/**
 * fix103: the reset script removes only timestamped records for one goal inside the window.
 * Counters with no per-event time are listed and left in place. A goal record in a timestamped
 * log with no timestamp fails the run and writes nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resetLearned } from '../scripts/fix103-reset.js';

const SCRIPT = fileURLToPath(new URL('../scripts/fix103-reset.js', import.meta.url));
const GOAL = 'reach iron_ore';
const FROM = '2026-11-10T15:53:50.000Z';
const TO = '2026-11-10T15:57:43.000Z';
const INSIDE = '2026-11-10T15:55:00.000Z';
const BEFORE = '2026-11-10T15:00:00.000Z';
const INSIDE_MS = Date.parse(INSIDE);

function writeJson(path, value) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'fix103-reset-'));
    const skills = join(root, 'skills');
    mkdirSync(skills);
    writeJson(join(skills, 'progress.json'), {
        failed: [GOAL, 'collectOneDirt', `${GOAL} (stale: parent completed)`],
        goalStats: { [`${GOAL}::replay failed`]: { success: 0, fail: 1 }, 'collectOneDirt::': { success: 1, fail: 0 } },
        goalFailStates: [{ task: GOAL, ok: false, reason: 'replay failed', state: 'inv:;near:' }],
        goalFailures: { [`${GOAL}::collectOneDirt::interrupt`]: { success: 0, fail: 1, lastFail: INSIDE_MS, rate: 0.25 } },
        decomposed: {
            [GOAL]: { subs: ['collect 1 iron_ore'], skills: [], at: INSIDE_MS, reason: 'needs: 1 iron_ore' },
            collectOneDirt: { subs: [], skills: [], at: Date.parse(BEFORE), reason: 'older' },
        },
        repairQueue: [{ target: 'collectBlock', task: GOAL, evidence: 'crash' }],
        recipeEdges: { iron_ore: { task: GOAL, status: 'untried', runs: 1, fails: 1 } },
        blockers: [{ item: 'iron_ore', count: 1, reason: 'reach', task: GOAL }],
        subgoals: [{ task: 'collect 1 iron_ore', parent: GOAL, depth: 1 }],
    });
    writeJson(join(skills, 'index.json'), [
        {
            name: 'collectBlock',
            repairHistory: [
                { at: INSIDE, task: GOAL, kind: 'callee_fix', evidence: 'crash', desc: 'in window' },
                { at: BEFORE, task: GOAL, kind: 'callee_fix', evidence: 'older', desc: 'before window' },
                { at: INSIDE, task: 'collectOneDirt', kind: 'callee_fix', evidence: 'other', desc: 'other goal' },
            ],
        },
    ]);
    writeJson(join(root, 'repair_memory.json'), {
        repairs: [
            { id: 'repair_in', timestamp: INSIDE, taskHint: GOAL, skillName: 'collectBlock', outcome: 'failure', errorSignature: 'x', errorRaw: 'x', fixSnippet: '', embedding: null },
            { id: 'repair_out', timestamp: BEFORE, taskHint: GOAL, skillName: 'collectBlock', outcome: 'failure', errorSignature: 'y', errorRaw: 'y', fixSnippet: '', embedding: null },
        ],
        workflows: [
            { id: 'wf_in', timestamp: INSIDE, task: GOAL, steps: ['go', 'dig'], outcome: 'failure' },
            { id: 'wf_out', timestamp: BEFORE, task: 'collectOneDirt', steps: ['a', 'b'], outcome: 'success' },
        ],
        lastUpdated: INSIDE,
    });
    writeJson(join(root, 'idle_practice.json'), {
        practiceLog: [
            { goal: GOAL, type: 'retry_failed', outcome: 'failure', skillLearned: null, duration: 10, timestamp: INSIDE },
            { goal: 'collectOneDirt', type: 'retry_failed', outcome: 'failure', skillLearned: null, duration: 10, timestamp: INSIDE },
        ],
        gaps: [
            { task: GOAL, reason: 'crash', count: 1, firstSeen: INSIDE_MS, lastSeen: INSIDE_MS },
            { task: GOAL, reason: 'older then touched', count: 4, firstSeen: Date.parse(BEFORE), lastSeen: INSIDE_MS },
            { task: 'collectonedirt', reason: 'other', count: 1, firstSeen: INSIDE_MS, lastSeen: INSIDE_MS },
        ],
        lastPractice: 0,
        enabled: true,
    });
    writeJson(join(root, 'needs_produces.json'), {
        observations: { collectblock: { needs: {}, produces: {}, runs: 3, lastRun: INSIDE } },
        confirmed: {},
        lastUpdated: INSIDE,
    });
    writeJson(join(skills, 'trials_inflight.json'), { pid: 1, root: 'collectBlock', task: GOAL, ran: {}, candidates: [], startedAt: INSIDE_MS });
    return root;
}

function read(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

describe('fix103 reset script', () => {
    it('dry-run lists the in-window records and writes nothing', () => {
        const root = fixture();
        const lines = [];
        const before = readFileSync(join(root, 'repair_memory.json'), 'utf8');
        const plan = resetLearned(root, GOAL, FROM, TO, false, (line) => lines.push(line));
        assert.ok(plan.changes.length >= 6, plan.changes.join('\n'));
        assert.ok(plan.changes.some((line) => line.includes('workflows') && line.includes(GOAL)));
        assert.ok(plan.changes.some((line) => line.includes('repairHistory') && line.includes('in window') === false && line.includes(GOAL)));
        assert.ok(plan.changes.some((line) => line.includes('decomposed')));
        assert.ok(plan.changes.some((line) => line.includes('practiceLog')));
        assert.ok(plan.changes.some((line) => line.includes('gaps') && line.includes('count":1') || line.includes('count=1')));
        assert.ok(plan.changes.some((line) => line.includes('trials_inflight')));
        assert.ok(plan.manual.some((line) => line.includes('goalStats')));
        assert.ok(plan.manual.some((line) => line.includes('failed[0]')));
        assert.ok(plan.manual.some((line) => line.includes('cumulative')));
        assert.ok(lines.some((line) => line.startsWith('WOULD ')));
        assert.ok(lines.some((line) => line.includes('2026-11-10T15:53:50Z')));
        assert.strictEqual(readFileSync(join(root, 'repair_memory.json'), 'utf8'), before);
        assert.strictEqual(existsSync(join(root, 'skills', 'trials_inflight.json')), true);
        rmSync(root, { recursive: true, force: true });
    });

    it('apply removes only the in-window records and a second apply finds nothing', () => {
        const root = fixture();
        resetLearned(root, GOAL, FROM, TO, true, () => {});
        const progress = read(join(root, 'skills', 'progress.json'));
        assert.deepStrictEqual(progress.failed, [GOAL, 'collectOneDirt', `${GOAL} (stale: parent completed)`]);
        assert.strictEqual(progress.goalStats[`${GOAL}::replay failed`].fail, 1);
        assert.strictEqual(Object.hasOwn(progress.decomposed, GOAL), false);
        assert.ok(progress.decomposed.collectOneDirt);
        assert.strictEqual(progress.repairQueue.length, 1);
        const index = read(join(root, 'skills', 'index.json'));
        const history = index[0].repairHistory;
        assert.strictEqual(history.length, 2);
        assert.ok(history.some((row) => row.task === GOAL && row.at === BEFORE));
        assert.ok(history.some((row) => row.task === 'collectOneDirt'));
        const memory = read(join(root, 'repair_memory.json'));
        assert.deepStrictEqual(memory.repairs.map((row) => row.id), ['repair_out']);
        assert.deepStrictEqual(memory.workflows.map((row) => row.id), ['wf_out']);
        const idle = read(join(root, 'idle_practice.json'));
        assert.strictEqual(idle.practiceLog.length, 1);
        assert.strictEqual(idle.practiceLog[0].goal, 'collectOneDirt');
        assert.strictEqual(idle.gaps.length, 2);
        assert.ok(idle.gaps.some((gap) => gap.task === GOAL && gap.count === 4));
        assert.strictEqual(existsSync(join(root, 'skills', 'trials_inflight.json')), false);
        assert.strictEqual(existsSync(join(root, 'skills', 'trials_inflight.json.fix103-bak')), true);
        const needs = read(join(root, 'needs_produces.json'));
        assert.strictEqual(needs.observations.collectblock.runs, 3);
        const again = resetLearned(root, GOAL, FROM, TO, true, () => {});
        assert.deepStrictEqual(again.changes, []);
        rmSync(root, { recursive: true, force: true });
    });

    it('a malformed row throws and writes nothing', () => {
        const cases = [
            {
                pattern: /recipeEdges\["iron_ore"\] is not an object/,
                file: (root) => join(root, 'skills', 'progress.json'),
                plant(path) {
                    const progress = read(path);
                    progress.recipeEdges.iron_ore = null;
                    writeJson(path, progress);
                },
            },
            {
                pattern: /subgoals\[0\] is not an object/,
                file: (root) => join(root, 'skills', 'progress.json'),
                plant(path) {
                    const progress = read(path);
                    progress.subgoals = [null];
                    writeJson(path, progress);
                },
            },
            {
                pattern: /deathSpots\["0,0"\] is not an object/,
                file: (root) => join(root, 'skills', 'progress.json'),
                plant(path) {
                    const progress = read(path);
                    progress.deathSpots = { '0,0': null };
                    writeJson(path, progress);
                },
            },
            {
                pattern: /index\.json\[0\] is not a skill object/,
                file: (root) => join(root, 'skills', 'index.json'),
                plant(path) { writeJson(path, [null]); },
            },
            {
                pattern: /observations\["collectblock"\] is not an object/,
                file: (root) => join(root, 'needs_produces.json'),
                plant(path) {
                    const needs = read(path);
                    needs.observations.collectblock = null;
                    writeJson(path, needs);
                },
            },
        ];
        for (const item of cases) {
            const root = fixture();
            const path = item.file(root);
            item.plant(path);
            const before = readFileSync(path, 'utf8');
            assert.throws(() => resetLearned(root, GOAL, FROM, TO, true, () => {}), item.pattern);
            assert.strictEqual(readFileSync(path, 'utf8'), before);
            assert.strictEqual(existsSync(`${path}.fix103-bak`), false);
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a goal record with no timestamp writes nothing', () => {
        const root = fixture();
        const memoryPath = join(root, 'repair_memory.json');
        const memory = read(memoryPath);
        delete memory.workflows[0].timestamp;
        writeJson(memoryPath, memory);
        const before = readFileSync(memoryPath, 'utf8');
        assert.throws(() => resetLearned(root, GOAL, FROM, TO, true, () => {}), /workflows\[0\] has no timestamp/);
        assert.strictEqual(readFileSync(memoryPath, 'utf8'), before);
        assert.strictEqual(existsSync(`${memoryPath}.fix103-bak`), false);
        rmSync(root, { recursive: true, force: true });
    });

    it('the CLI dry-run names the example window and does not write', async () => {
        const root = fixture();
        const before = readFileSync(join(root, 'skills', 'progress.json'), 'utf8');
        const child = spawn(process.execPath, [SCRIPT, root, GOAL, FROM, TO], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (buf) => { stdout += buf; });
        child.stderr.on('data', (buf) => { stderr += buf; });
        const code = await new Promise((resolve) => child.on('exit', resolve));
        assert.strictEqual(code, 0, stderr);
        assert.match(stdout, /DRY-RUN/);
        assert.match(stdout, /2026-11-10T15:53:50Z 2026-11-10T15:57:43Z/);
        assert.match(stdout, /WOULD REMOVE/);
        assert.match(stdout, /MANUAL/);
        assert.strictEqual(readFileSync(join(root, 'skills', 'progress.json'), 'utf8'), before);
        rmSync(root, { recursive: true, force: true });
    });
});
