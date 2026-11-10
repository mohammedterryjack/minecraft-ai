// fix102: annotateTrace cuts failure lines out of a run's whole output with slice/split.
// V8 keeps those as SlicedStrings (a pointer into the parent), and a one-element join returns
// that same string, so evidence stored from the line pinned every run's bot.output.
// The harness this reproduces (200 kept lines, one ~100KB output each) retained 18.3MB.
// Idle practice calls main() itself, so it also has to start from an empty bot.output the way
// ActionManager does before a traced action.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkInterruptSource } from '../src/agent/action_manager.js';

const SELF = fileURLToPath(import.meta.url);
const RUNS = 200;
const LOG_LINES = 2000;
// Sliced strings retain about one full output per kept line. Flat copies of the lines stay
// far under the outputs they were cut from; a fifth of that total is still many times the
// old retention and many times a flat copy.
const WELL_BELOW_DIVISOR = 5;
const CONTRACT_PARENT_CHARS = 100000;
const CONTRACT_LINE = 'FAILED: contract evidence line';
const FAIL = 'FAILED: collectBlock threw no wheat nearby run 0';
const TWO = 'FAILED: no wheat nearby | FAILED: no water nearby';
const REPEATED = 'FAILED: no wheat nearby (x2)';
const UNICODE = 'FAILED: collectBlock threw no naïve wheat — run 7';

if (process.env.FIX102_RETAIN === '1') {
    const { annotateTrace, blame, blameAll, traceText, structuredTrace } = await import('../src/agent/skill_graph.js');
    if (typeof global.gc !== 'function') throw new Error('fix102 probe requires node --expose-gc');
    const gcHeap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
    const frame = (output) => [{ name: 'collectBlock', parent: -1, depth: 0, args: '[]', ret: 'false', fail: true, intr: false, err: null, o0: 0, o1: output.length }];
    const stored = (output, extra) => {
        const trace = frame(output);
        if (extra) Object.assign(trace[0], extra);
        annotateTrace(trace, output);
        const one = blame(trace, () => false);
        const all = blameAll(trace, () => false, () => true);
        if (!one || typeof one.evidence !== 'string') throw new Error(`blame did not store evidence, got ${JSON.stringify(one)}`);
        if (!Array.isArray(all) || all.length !== 1 || typeof all[0].evidence !== 'string') throw new Error(`blameAll did not store one evidence, got ${JSON.stringify(all)}`);
        return { ownFail: trace[0].ownFail[0], ownFails: trace[0].ownFail, evidence: one.evidence, blameAll: all[0].evidence, trace: traceText(trace) };
    };

    const kept = [];
    let outputBytes = 0;
    let run0 = null;
    const h0 = gcHeap();
    for (let i = 0; i < RUNS; i++) {
        let out = '';
        for (let k = 0; k < LOG_LINES; k++) out += `log line ${k} of run ${i} padding padding padding\n`;
        const fail = `FAILED: collectBlock threw no wheat nearby run ${i}`;
        out += `${fail}\n`;
        if (i === 0) outputBytes = Buffer.byteLength(out);
        const row = stored(out);
        if (row.ownFail !== fail) throw new Error(`ownFail changed: ${JSON.stringify(row.ownFail)}`);
        if (i === 0) run0 = { ownFail: row.ownFail, evidence: row.evidence, blameAll: row.blameAll, trace: row.trace };
        kept.push(row.ownFail, row.evidence, row.blameAll, row.trace);
    }
    const retainedBytes = gcHeap() - h0;

    const twoOut = `log line\nFAILED: no wheat nearby\nFAILED: no water nearby\n`;
    const two = stored(twoOut);
    const repOut = `log line\nFAILED: no wheat nearby\nFAILED: no wheat nearby\n`;
    const rep = stored(repOut);
    const uniOut = `${'pad '.repeat(LOG_LINES)}\n${UNICODE}\n`;
    const uni = stored(uniOut);
    const errOut = `${'pad '.repeat(LOG_LINES)}\nok\n`;
    const errRow = stored(errOut, { err: 'boom', ownFail: undefined });
    const retRow = stored(errOut, { err: null, ret: 'false' });

    process.stdout.write(JSON.stringify({
        runs: RUNS,
        outputBytes,
        retainedBytes,
        kept: kept.length,
        run0,
        two: two.evidence,
        twoOwn: two.ownFails,
        repeat: rep.evidence,
        unicode: uni.evidence,
        errOnly: errRow.evidence,
        returned: retRow.evidence,
    }) + '\n');
    const log = console.log;
    console.log = () => {};
    let contract;
    try {
        const { Voyager, codeRetryFeedback } = await import('../src/agent/voyager.js');
        const captureContract = (i) => {
            const line = `${CONTRACT_LINE} ${i}`;
            const parent = 'P'.repeat(CONTRACT_PARENT_CHARS);
            const view = (parent + line).slice(parent.length);
            if (view !== line) throw new Error(`contract view changed: ${JSON.stringify(view)}`);
            const skill = { name: 'mineBlock', code: 'async function mineBlock(bot) { return false; }\n', repairHistory: [] };
            const v = Object.create(Voyager.prototype);
            v.skills = [skill];
            v.progress = {};
            v._saveProgress = () => {};
            v._saveSkills = () => {};
            v._queueContractFix(skill, view);
            v._proposalOutcome(skill, 'rejected undecidable contract', v._repairSig(skill.name, view));
            v._recordSplitFailure(skill.name, skill.code, view);
            const feedback = codeRetryFeedback({ cut: null, output: view, trace: null, critique: '', invFull: null, behaviorLog: '' });
            const structured = structuredTrace([{ name: 'mineBlock', args: '[]', ret: 'false', ok: false, err: null, parent: -1, ownFail: [view] }]);
            const q = v.progress.repairQueue;
            if (!Array.isArray(q) || q.length !== 1 || typeof q[0].evidence !== 'string') throw new Error(`contract repair queue did not store evidence: ${JSON.stringify(q)}`);
            const keys = v.progress.failedRepairSigs && Object.keys(v.progress.failedRepairSigs);
            if (!Array.isArray(keys) || keys.length !== 1) throw new Error(`failedRepairSigs did not store the signature: ${JSON.stringify(v.progress.failedRepairSigs)}`);
            const rows = v.progress.splitFailures;
            if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0].why !== 'string') throw new Error(`splitFailures did not store the reason: ${JSON.stringify(rows)}`);
            return {
                parentBytes: Buffer.byteLength(parent) + Buffer.byteLength(line),
                evidence: q[0].evidence,
                sig: keys[0],
                split: rows[0].why,
                feedback,
                structured,
                line,
            };
        };
        captureContract(0);
        const h1 = gcHeap();
        const rows = [];
        for (let i = 1; i <= RUNS; i++) rows.push(captureContract(i));
        contract = {
            runs: rows.length,
            parentBytes: rows.reduce((sum, row) => sum + row.parentBytes, 0),
            retainedBytes: gcHeap() - h1,
            sample: rows[0],
        };
    } finally {
        console.log = log;
    }
    process.stdout.write(JSON.stringify({ contract }));
} else {
    const LIVE = JSON.parse(readFileSync(new URL('./fixtures/fix74-live-travelWest.json', import.meta.url), 'utf8')).record;
    const DEST = { x: -178, y: 53, z: 107 };
    let Voyager;
    before(async () => {
        const mod = await import('../src/agent/voyager.js');
        Voyager = mod.Voyager;
        mod._setVersionForTest('1.21.4');
    });

    describe('fix102: stored failure lines do not pin the run output', () => {
        it('keeps the failure text and drops the output it was cut from', () => {
            const child = spawnSync(process.execPath, ['--expose-gc', SELF], {
                env: { ...process.env, FIX102_RETAIN: '1' },
                encoding: 'utf8',
                timeout: 60000,
            });
            if (child.error) throw child.error;
            if (child.status !== 0) throw new Error(`probe exited ${child.status}\n${child.stderr}\n${child.stdout}`);
            const lines = child.stdout.trim().split('\n');
            if (lines.length !== 2) throw new Error(`probe wrote ${lines.length} lines\n${child.stdout}`);
            const report = JSON.parse(lines[0]);
            report.contract = JSON.parse(lines[1]).contract;
            assert.strictEqual(report.runs, RUNS);
            assert.ok(report.outputBytes > 0);
            assert.ok(
                report.retainedBytes * WELL_BELOW_DIVISOR < report.runs * report.outputBytes,
                `retained ${report.retainedBytes} bytes from ${report.runs} outputs of ${report.outputBytes} bytes each`,
            );
            assert.strictEqual(report.run0.ownFail, FAIL);
            assert.strictEqual(report.run0.evidence, FAIL);
            assert.strictEqual(report.run0.blameAll, FAIL);
            assert.strictEqual(report.run0.trace, `collectBlock() -> false FAIL | ${FAIL}`);
            assert.deepStrictEqual(Buffer.from(report.run0.evidence, 'utf8'), Buffer.from(FAIL, 'utf8'));
            assert.deepStrictEqual(report.twoOwn, ['FAILED: no wheat nearby', 'FAILED: no water nearby']);
            assert.strictEqual(report.two, TWO);
            assert.strictEqual(report.repeat, REPEATED);
            assert.strictEqual(report.unicode, UNICODE);
            assert.deepStrictEqual(Buffer.from(report.unicode, 'utf8'), Buffer.from(UNICODE, 'utf8'));
            assert.strictEqual(report.errOnly, 'boom');
            assert.strictEqual(report.returned, 'returned false');
            assert.equal(report.run0.evidence.includes('padding padding'), false);
            const contractLine = `${CONTRACT_LINE} 1`;
            assert.strictEqual(report.contract.runs, RUNS);
            assert.strictEqual(report.contract.sample.evidence, contractLine);
            assert.strictEqual(report.contract.sample.split, contractLine);
            assert.ok(report.contract.sample.sig.endsWith(`:${contractLine}`), report.contract.sample.sig);
            assert.equal(report.contract.sample.sig.includes('PPPP'), false);
            assert.strictEqual(report.contract.sample.feedback, `Execution output:\n${contractLine}`);
            assert.strictEqual(report.contract.sample.structured, `mineBlock() -> false FAIL | ${contractLine}`);
            assert.deepStrictEqual(Buffer.from(report.contract.sample.evidence, 'utf8'), Buffer.from(contractLine, 'utf8'));
            assert.ok(
                report.contract.retainedBytes * WELL_BELOW_DIVISOR < report.contract.parentBytes,
                `contract stores retained ${report.contract.retainedBytes} bytes from ${report.contract.runs} parents totaling ${report.contract.parentBytes} bytes`,
            );
        });
    });

    describe('fix102: idle practice starts with an empty bot.output', () => {
        it('a traced practice run does not append to the previous run', async () => {
            const stale = `STALE_PREVIOUS_RUN_OUTPUT ${'x'.repeat(4000)}\n`;
            const practiceLog = 'FAILED: practice log that must not prefix the next run\n';
            const seen = [];
            const skill = JSON.parse(JSON.stringify(LIVE));
            const calls = { interrupts: 0 };
            const bot = { interrupt_code: false, output: stale, pathfinder: { stop() {} } };
            const v = Object.create(Voyager.prototype);
            const rootRec = (from, to) => ({
                name: skill.name, parent: -1, depth: 0, t0: 1000, t1: 46000, intr: false, rv: undefined, fail: false, argv: [], delta: {}, o0: 0, o1: 0,
                s0: { pos: from, alive: true }, s1: { pos: to, alive: true },
            });
            Object.assign(v, {
                skills: [skill], progress: {}, _saveSkills: () => {}, _idlePracticeActive: true, _unjudgeableNoted: new Set(), _unverifiedConsumesNoted: new Set(),
                agent: {
                    bot, isIdle: () => true,
                    requestInterrupt: (source) => { checkInterruptSource(source); calls.interrupts++; bot.interrupt_code = true; bot.pathfinder.stop(); },
                },
                _threats: () => 'none', observe: () => ({ inventory: { cobblestone: 64 } }), _libSrcSubset: () => '', _closure: () => [],
                _timedBotForSkillRun: () => bot,
                _stageLintExecTraced: async () => ({
                    lint: null,
                    staged: { func: { main: async (b) => {
                        seen.push(b.output);
                        b.output += practiceLog;
                        b.__psnTrace = [];
                        b.__psnOut = b.output;
                        b.__psnTrace.push(rootRec({ x: -140, y: 60, z: 107 }, { ...DEST }));
                    } } },
                }),
            });
            v._armPracticeAbort();
            const first = await v._runPracticeSkill(skill);
            assert.strictEqual(first.ok, true, first.detail);
            assert.strictEqual(seen[0], '');
            assert.equal(bot.output.includes('STALE_PREVIOUS_RUN_OUTPUT'), false);
            assert.strictEqual(bot.output, practiceLog);
            bot.output += 'and a second line from the same run\n';
            const second = await v._runPracticeSkill(skill);
            assert.strictEqual(second.ok, true, second.detail);
            assert.strictEqual(seen[1], '');
            assert.strictEqual(seen.length, 2);
        });
    });

    describe('fix102: a lone surrogate is kept', () => {
        it('flatCopy and annotateTrace keep a lone surrogate and a split emoji', async () => {
            const { flatCopy, annotateTrace } = await import('../src/agent/skill_graph.js');
            const lone = 'FAILED: player said hi \uDE00 there';
            const copied = flatCopy(lone);
            assert.strictEqual(copied, lone);
            assert.deepStrictEqual(Buffer.from(copied, 'utf16le'), Buffer.from(lone, 'utf16le'));

            // skills.js placeBlock logs String(err).slice(0, 100). An emoji on that boundary
            // leaves the high surrogate and drops the low one.
            const PLACE_ERROR_CHARS = 100;
            const emoji = '\uD83D\uDE00';
            const message = `${'x'.repeat(PLACE_ERROR_CHARS - 1)}${emoji} tail`;
            const sliced = String(message).slice(0, PLACE_ERROR_CHARS);
            assert.strictEqual(sliced.length, PLACE_ERROR_CHARS);
            assert.strictEqual(sliced.charCodeAt(PLACE_ERROR_CHARS - 1), emoji.charCodeAt(0));
            const splitLine = `FAILED: ${sliced}`;
            const splitCopy = flatCopy(splitLine);
            assert.strictEqual(splitCopy, splitLine);
            assert.deepStrictEqual(Buffer.from(splitCopy, 'utf16le'), Buffer.from(splitLine, 'utf16le'));

            const output = `${lone}\n${splitLine}\n`;
            const trace = [{ name: 'placeBlock', parent: -1, depth: 0, args: '[]', ret: 'false', fail: true, intr: false, err: null, o0: 0, o1: output.length }];
            assert.doesNotThrow(() => annotateTrace(trace, output));
            assert.deepStrictEqual(trace[0].ownFail, [lone, splitLine]);
        });
    });
}
