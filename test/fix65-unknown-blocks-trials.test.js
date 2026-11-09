/**
 * fix65 regressions.
 * 1) world.getBlockAtPosition returned {name:'air'} for an unloaded chunk (6a7820b copied the 2024 modes.js "hacky fix when
 *    blocks are not loaded", dc520a9/b4a60cb). Unknown now stays unknown: null from the API, UNLOADED in reports, and
 *    absolute coordinates passed as offsets throw, naming bot.blockAt.
 * 2) The 09:37Z collectBlock trial candidate was never retired:
 *    a) replays (the common path) ran child candidates only when the replayed ROOT had a candidate (#30, 094b9db);
 *    b) candidate outcomes were read before death/stall/timeout attribution, so a cut candidate was skipped as `intr`;
 *    c) a hang killed the process before any outcome was written. A trial journal + the watchdog's evidence file now count
 *       it on the next start.
 * 3) ARMED is logged only when a keep_alive gap falls outside the spread of gaps seen before it.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Vec3 } from 'vec3';
import * as world from '../src/agent/library/world.js';
import { Coder } from '../src/agent/coder.js';
import { Voyager } from '../src/agent/voyager.js';
import { instrumentSrc } from '../src/agent/skill_graph.js';
import { startEventLoopStallGuard, stopEventLoopStallGuard } from '../src/utils/event_loop_guard.js';
import { watchdogEvidencePath } from '../src/utils/main_thread_watchdog.js';

const NAME = '__fix65_test__';
const BOT_DIR = `./bots/${NAME}`;
after(() => rmSync(BOT_DIR, { recursive: true, force: true }));

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/fix65-live-iron-closure.json', import.meta.url), 'utf8'));

/** Loaded cells map to blocks; anything else is an unloaded chunk (bot.blockAt -> null). */
function cellBot(cells, at = new Vec3(-122.3, 33, 58.7)) {
    const m = new Map(Object.entries(cells).map(([k, name]) => { const [x, y, z] = k.split(',').map(Number); const position = new Vec3(x, y, z); return [position.toString(), { name, position }]; }));
    return { entity: { position: at }, blockAt: (p) => m.get(p.floored().toString()) ?? null };
}

describe('fix65: unloaded is unknown, never air', () => {
    it('the relative lookup returns null for an unloaded chunk and the block for a loaded offset (fix67: one Vec3 offset)', () => {
        const bot = cellBot({ '-123,32,58': 'deepslate' });
        assert.strictEqual(world.getBlockAtOffset(bot, new Vec3(0, -1, 0)).name, 'deepslate');
        assert.strictEqual(world.getBlockAtOffset(bot, new Vec3(0, 1, 0)), null, 'unloaded -> null, not {name: "air"}');
        assert.strictEqual(world.getBlockAtOffset(bot, new Vec3(2, -1, 0)), null);   // ensureFurnace-style offset
    });

    it('absolute positions have their own lookup (fix67 replaced the fix65 inference)', () => {
        const bot = cellBot({ '-124,33,57': 'iron_ore' });
        assert.strictEqual(world.getBlockAtAbsolute(bot, new Vec3(-124, 33, 57)).name, 'iron_ore');
    });

    it('reports print UNLOADED for unknown cells; getFirstBlockAboveHead stops at the first unknown cell', () => {
        const bot = cellBot({ '-123,32,58': 'stone', '-123,33,58': 'air', '-123,35,58': 'air', '-123,36,58': 'air' });
        assert.deepStrictEqual(world.getSurroundingBlocks(bot), ['Block Below: stone', 'Block at Legs: air', `Block at Head: ${world.UNLOADED}`]);
        assert.strictEqual(world.reportBlockAtOffset(bot, new Vec3(0, 1, 0)), world.UNLOADED);
        assert.strictEqual(world.getFirstBlockAboveHead(bot, null, 32), `${world.UNLOADED} (2 blocks up)`);
        const sky = cellBot(Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`-123,${35 + i},58`, 'air'])));
        assert.strictEqual(world.getFirstBlockAboveHead(sky, null, 4), 'none');
    });

    it('no fake {name: "air"} is left in world.js or modes.js', () => {
        for (const f of ['../src/agent/library/world.js', '../src/agent/modes.js']) {
            const src = readFileSync(new URL(f, import.meta.url), 'utf8');
            assert.doesNotMatch(src, /=\s*\{\s*name:\s*'air'\s*\}/, f);
        }
    });

    it('the live collectBlock candidate now fails loudly on its first lookup instead of excluding every ore (fix67: the three-number lookup no longer exists)', async () => {
        const cand = LIVE.find(s => s.name === 'collectBlock').candidate.code.replace('getNearestBlocks(bot, types, 64, 10000)', 'getNearestBlocksWhere(bot, types, 64, 10000)');
        const coder = new Coder({ name: NAME });
        while (!coder.code_lint_template || !coder.code_template) await new Promise(r => setImmediate(r));
        const staged = await coder._stageCode(`${cand}\nawait collectBlock(bot, 'iron_ore', 5);`, { lintOnly: false });
        const ores = new Map(Array.from({ length: 40 }, (_, k) => { const p = new Vec3(-124 + k, 33, 57); return [p.toString(), { name: 'iron_ore', position: p }]; }));
        const bot = { output: '', interrupt_code: false, scans: 0, entity: { position: new Vec3(-122.3, 33, 58.7) },
            findBlocks() { bot.scans++; return [...ores.values()].map(b => b.position); }, blockAt: p => ores.get(p.floored().toString()) ?? null };
        await assert.rejects(staged.func.main(bot), /getBlockAtPosition is not (defined|a function)/);
        assert.strictEqual(bot.scans, 1, 'one scan, then a loud error (it used to rescan once per ore)');
    });
});

/** A Voyager over the live closure with only the persistence and later-stage repair calls stubbed. */
function liveVoyager() {
    mkdirSync(`${BOT_DIR}/skills`, { recursive: true });
    const v = Object.create(Voyager.prototype);
    v.skills = JSON.parse(JSON.stringify(LIVE));
    v.dir = `${BOT_DIR}/skills`;
    v.progress = { completedAt: {}, completed: [], failed: [] };
    v.agent = { bot: { inventory: { emptySlotCount: () => 5 } } };
    v._saveSkills = () => {};
    v._saveProgress = () => {};
    v._checkContracts = () => {};
    v._learnVitalsEffects = () => {};
    v._learnSlotEffects = () => {};
    return v;
}
const STOP = new Error('stop after trial accounting');

describe('fix65: trial candidates are retired by the learner', () => {
    it('a replay of mineOneIronOre (no candidate of its own) now trials the child candidates, collectBlock included', () => {
        const v = liveVoyager();
        const over = v._replayOverrides('mineOneIronOre', false);
        assert.deepStrictEqual(Object.keys(over).sort(), ['breakBlockAt', 'collectBlock', 'mineBlocks', 'mineIronOreBlock', 'travelTo']);
        // #30's rule, for contrast: children only when the root's own trial ran -> nothing, which is why the record stayed 0/0
        const old = {}; for (const s of v.skills) if (s.candidate && false && (s.name === 'mineOneIronOre' || v._closure('mineOneIronOre').has(s.name))) old[s.name] = s.candidate.code;
        assert.deepStrictEqual(old, {});
    });

    function failedReplay(v, cut) {
        const out = '\nFAILED: collectBlock threw getBlockAtPosition(bot, -124, 33, 57): these are absolute coordinates\n';
        const t = Date.now();
        v.agent.bot.__psnOut = out;
        v.agent.bot.__psnTrace = [
            { name: 'mineOneIronOre', args: '[]', parent: -1, depth: 0, o0: 0, o1: out.length, t0: t - 3, t1: cut ? undefined : t, intr: !!cut },
            { name: 'mineIronOreBlock', args: '[]', parent: 0, depth: 1, o0: 0, o1: out.length, t0: t - 2, t1: cut ? undefined : t, intr: !!cut },
            { name: 'collectBlock', args: '["iron_ore",5]', parent: 1, depth: 2, o0: 0, o1: cut ? undefined : out.length, t0: t - 1, t1: cut ? undefined : t, intr: !!cut, fail: !cut, err: cut ? undefined : 'absolute coordinates' },
        ];
        v._runStart = t - 4;
        v._stall = cut ? { t, pos: '-122,33,58' } : null;
        v._lastRunMsg = '';
        v._isLeaf = () => { throw STOP; };
        assert.throws(() => v._attribute('mineOneIronOre', 'Mine 1 iron_ore', false, v._replayOverrides('mineOneIronOre', false), null), e => e === STOP);
    }

    it('two failed in-place trials REJECT the live candidate and roll back its joint refactor (mineBlocks too)', () => {
        const v = liveVoyager();
        failedReplay(v, false);
        assert.deepStrictEqual(v.skills.find(s => s.name === 'collectBlock').candidate.stats.fail, 1);
        failedReplay(v, false);
        assert.strictEqual(v.skills.find(s => s.name === 'collectBlock').candidate, undefined, 'collectBlock candidate retired');
        assert.strictEqual(v.skills.find(s => s.name === 'mineBlocks').candidate, undefined, 'its joint-repair partner rolled back');
    });

    it('a stalled run counts against the candidate open at the stall (it was skipped as `intr` before)', () => {
        const v = liveVoyager();
        failedReplay(v, true);
        assert.strictEqual(v.skills.find(s => s.name === 'collectBlock').candidate.stats.fail, 1);
    });

    it('a crash during the step is attributed to the call running when it was thrown', () => {
        const v = liveVoyager();
        v.running = true; v.currentTask = 'Mine 1 iron_ore';
        v.agent.bot.interrupt_code = false; v.agent.actions = { stop: () => {} }; v.agent.requestInterrupt = () => { v.agent.bot.interrupt_code = true; };   // fix75: the process error records itself as an interrupt source
        v._runStart = Date.now() - 4;
        v._onProcessError('UNCAUGHT EXCEPTION', new Error('boom'));
        const c = v._crashedInRun();
        assert.strictEqual(c.message, 'boom');
        const t = c.t;
        v.agent.bot.__psnOut = '';
        v.agent.bot.__psnTrace = [
            { name: 'mineOneIronOre', args: '[]', parent: -1, depth: 0, o0: 0, t0: t - 3, intr: true },
            { name: 'collectBlock', args: '[]', parent: 0, depth: 1, o0: 0, t0: t - 1, intr: true },
        ];
        v._stall = null; v._lastRunMsg = ''; v.agent.lastDeath = null;
        v._isLeaf = () => { throw STOP; };
        assert.throws(() => v._attribute('mineOneIronOre', 'Mine 1 iron_ore', false, v._replayOverrides('mineOneIronOre', false), null), e => e === STOP);
        assert.strictEqual(v.skills.find(s => s.name === 'collectBlock').candidate.stats.fail, 1);
    });

    it('a run that killed the process is counted on the next start from the trial journal + watchdog evidence', () => {
        const ev = watchdogEvidencePath(BOT_DIR);
        for (let k = 1; k <= 2; k++) {
            const v = liveVoyager();
            v._openTrialJournal(Object.keys(v._replayOverrides('mineOneIronOre', false)), 'mineOneIronOre', 'Mine 1 iron_ore', v._closure('mineOneIronOre'));   // never closed: the process "died"
            writeFileSync(ev, JSON.stringify({ pid: process.pid, silentMs: 22545, limitMs: 22545, phases: ['action:voyager:replay:Mine 1 iron_ore'], skill: 'collectBlock', stack: 'mineOneIronOre <- mineIronOreBlock <- collectBlock' }));
            const next = liveVoyager();
            if (k === 2) next.skills.find(s => s.name === 'collectBlock').candidate.stats = { success: 0, fail: 1, streakFail: 1, tasks: [] };
            next._settleDeadTrials(ev);
            assert.ok(!existsSync(`${next.dir}/trials_inflight.json`), 'journal consumed');
            const c = next.skills.find(s => s.name === 'collectBlock').candidate;
            if (k === 1) assert.strictEqual(c.stats.fail, 1, 'the hang counts against the deepest in-flight candidate on the stack');
            else assert.strictEqual(c, undefined, 'second hang: REJECT');
            assert.strictEqual(next.skills.find(s => s.name === 'mineIronOreBlock').candidate.stats.fail, 1, 'a caller on the stack is not blamed for the hang below it');
        }
    });

    it('no watchdog evidence for the dead pid: loud, not counted against anyone', () => {
        const v = liveVoyager();
        v._openTrialJournal(['collectBlock'], 'mineOneIronOre', 'Mine 1 iron_ore', v._closure('mineOneIronOre'));
        const ev = watchdogEvidencePath(BOT_DIR);
        writeFileSync(ev, JSON.stringify({ pid: -1, silentMs: 1, phases: [], skill: 'x', stack: 'collectBlock' }));
        const next = liveVoyager();
        next._settleDeadTrials(ev);
        assert.strictEqual(next.skills.find(s => s.name === 'collectBlock').candidate.stats.fail, 0);
    });

    it('a clean run removes its journal', () => {
        const v = liveVoyager();
        const close = v._openTrialJournal(['collectBlock'], 'mineOneIronOre', 'Mine 1 iron_ore', v._closure('mineOneIronOre'));
        assert.ok(existsSync(`${v.dir}/trials_inflight.json`));
        close();
        assert.ok(!existsSync(`${v.dir}/trials_inflight.json`));
    });

    it('end to end: the real watchdog SIGKILLs a spinning child and the next learner counts it from the file the worker wrote', { timeout: 30000 }, async () => {
        const ev = watchdogEvidencePath(BOT_DIR);
        rmSync(ev, { force: true });
        const v = liveVoyager();
        const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/fix64-watchdog-child.mjs', import.meta.url)), 'spin', '200', ev, 'mineOneIronOre <- mineIronOreBlock <- collectBlock'], { stdio: ['ignore', 'pipe', 'pipe'] });
        // the journal is written by the process that runs the trial; here the child stands in for it
        v._openTrialJournal(['collectBlock', 'mineIronOreBlock'], 'mineOneIronOre', 'Mine 1 iron_ore', v._closure('mineOneIronOre'));   // fix68: same journal format
        const j = JSON.parse(readFileSync(`${v.dir}/trials_inflight.json`, 'utf8')); j.pid = child.pid;
        writeFileSync(`${v.dir}/trials_inflight.json`, JSON.stringify(j));
        const signal = await new Promise(r => child.on('exit', (c, s) => r(s)));
        assert.strictEqual(signal, 'SIGKILL');
        const evidence = JSON.parse(readFileSync(ev, 'utf8'));
        assert.strictEqual(evidence.pid, child.pid);
        assert.strictEqual(evidence.stack, 'mineOneIronOre <- mineIronOreBlock <- collectBlock');
        const next = liveVoyager();
        next._settleDeadTrials(ev);
        assert.strictEqual(next.skills.find(s => s.name === 'collectBlock').candidate.stats.fail, 1);
    });

    it('when a traced call returns, the running skill/stack go back to its caller (not cleared)', async () => {
        const coder = new Coder({ name: NAME });
        while (!coder.code_lint_template || !coder.code_template) await new Promise(r => setImmediate(r));
        const code = 'async function inner(bot) { return 1; }\nasync function outer(bot) {\n    await inner(bot);\n    bot.after = [bot.__psnRunningSkill, bot.__psnStackStr];\n    return 1;\n}\n'
            + instrumentSrc(['outer', 'inner']) + '\nawait outer(bot);';
        const staged = await coder._stageCode(code, { lintOnly: false });
        const bot = { output: '', interrupt_code: false, __psnALS: new AsyncLocalStorage(), inventory: { slots: Array(46).fill(null), emptySlotCount: () => 36 },
            waitForTicks: async () => {}, entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null, health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, quickBarSlot: 0 };
        await staged.func.main(bot);
        assert.deepStrictEqual(bot.after, ['outer', 'outer']);
        assert.strictEqual(bot.__psnRunningSkill, null);
    });
});

describe('fix65: ARMED is logged only when the keep_alive gap leaves its learned spread', () => {
    it('gaps inside the spread seen so far stay silent; a new min or max logs', () => {
        const realNow = Date.now, realLog = console.log;
        const lines = [];
        let now = 1_000_000;
        Date.now = () => now;
        console.log = (...a) => lines.push(a.join(' '));
        const bot = { _client: new EventEmitter() };
        try {
            startEventLoopStallGuard(bot);
            bot._client.emit('keep_alive');
            for (const gap of [15030, 15034, 15031, 15178, 15100, 15033, 15000, 15050]) { now += gap; bot._client.emit('keep_alive'); }
        } finally {
            stopEventLoopStallGuard(bot);
            Date.now = realNow; console.log = realLog;
        }
        const armed = lines.filter(l => l.includes('stall guard ARMED'));
        assert.deepStrictEqual(armed.map(l => Number(l.match(/currently (\d+)ms/)[1])), [15030, 15034, 15178, 15000]);
        assert.strictEqual(bot.__eventLoopStallThresholdMs, 15050, 'the threshold still tracks the latest gap');
    });
});
