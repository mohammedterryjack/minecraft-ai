// fix74: idle practice never taught the learner anything about the skill it practised.
//
// Live (iMac, icefox2000, deployed 5d378f9; record in fixtures/fix74-live-travelWest.json):
//   travelWestAvoidDeathHotspot was saved 2026-11-06T02:47:40Z with effects [crafting_table, cobblestone]: the writeCode run was
//   measured from the TASK-start snapshot (pre-fix70), and during code-model call #94 (02:43:01-02:43:20Z) idle practice ran
//   craftOneIronPickaxe x3, pickupNearbyItems, equipBestPickaxeForMining and findIronOreNearby; their gains became its effects.
//   mindcraft.log: 336x "top candidate: travelWestAvoidDeathHotspot (n=1 ...)", 188x "NOT SUCCESS ... no gain for effects
//   [crafting_table,cobblestone] (no ranking bump)", 86x "TIMEOUT ... exceeded 10000ms"; stats still success 1 / fail 0 after
//   311 practice runs.
//   1. practice wrote only stats.lastRun / practiceRuns (fa01ee3), so n never moved and fix49's uncertainty ranking re-picked it
//   2. its effects had no evidence (only consumes got some in fix70) and a westward walk can never "gain" them
//   3. the cap was a hard-coded 10000 ms, and a cut run only set bot.interrupt_code: the goto it was waiting in kept walking
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { recordEffectEvidence, verifiedEffects } from '../src/agent/consume_evidence.js';
import { checkInterruptSource } from '../src/agent/action_manager.js';
import { markPreconditionUnmet, peekPreconditionUnmet } from '../src/agent/precondition.js';

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/fix74-live-travelWest.json', import.meta.url), 'utf8')).record;
const SRC = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
let Voyager;
before(async () => { const mod = await import('../src/agent/voyager.js'); Voyager = mod.Voyager; mod._setVersionForTest('1.21.4'); });
const live = () => JSON.parse(JSON.stringify(LIVE));
const DEST = { x: -178, y: 53, z: 107 };
// a root trace record as instrumentSrc's harness writes it (fields read by annotateTrace, _postHolds, _postVerifiesRun, durations)
const rootRec = (name, { t0, t1, from, to, intr = false, rv }) => ({ name, parent: -1, depth: 0, t0, t1, intr, rv, fail: false, argv: [], delta: {}, o0: 0, o1: 0,
    s0: { pos: from, alive: true }, s1: { pos: to, alive: true } });

// a voyager whose practice program is the given body (it gets the bot and writes the trace the harness would write)
function mkPracticeV(skills, run, extra = {}) {
    const calls = { interrupts: 0, pathfinderStops: 0, sources: [] };
    const bot = { interrupt_code: false, output: '', pathfinder: { stop() { calls.pathfinderStops++; } } };
    const v = Object.create(Voyager.prototype);
    Object.assign(v, {
        skills, progress: {}, _saveSkills: () => {}, _idlePracticeActive: true, _unjudgeableNoted: new Set(), _unverifiedConsumesNoted: new Set(),
        agent: { bot, isIdle: () => true, requestInterrupt: (source) => { checkInterruptSource(source); calls.sources.push(source); calls.interrupts++; bot.interrupt_code = true; bot.pathfinder.stop(); } },
        _threats: () => 'none', observe: () => ({ inventory: { ...bot.inv } }), _libSrcSubset: () => '', _closure: () => [],
        _timedBotForSkillRun: () => bot,
        _stageLintExecTraced: async () => ({ lint: null, staged: { func: { main: async b => { b.__psnTrace = []; b.__psnOut = ''; await run(b); } } } }),
        ...extra,
    });
    bot.inv = { cobblestone: 64 };
    v._armPracticeAbort();
    return { v, bot, calls };
}

describe('fix74: the live travelWestAvoidDeathHotspot record', () => {
    it('its effects have no run evidence: nothing verified, so they neither judge practice nor say "postcondition met"', () => {
        const s = live();
        assert.deepStrictEqual(s.effects, ['crafting_table', 'cobblestone']);
        assert.strictEqual(Object.hasOwn(s, 'effectEvidence'), false);
        assert.deepStrictEqual(verifiedEffects(s), []);
        const { v } = mkPracticeV([s], async () => {});
        assert.strictEqual(v._shouldSkipPractice(s, { crafting_table: 1, cobblestone: 64 }, new Set()), null);
    });
    it('pre-fix70 task-window measurement yields the fake effects; the run window (fix70 runBefore) yields none', () => {
        // inventories reconstructed from the save context: the practice runs inside the task window crafted a table and mined stone
        const taskStart = { cobblestone: 40, oak_log: 1, stone_pickaxe: 1, iron_pickaxe: 1 };
        const runBefore = { cobblestone: 52, crafting_table: 1 };   // after the practice runs, right before the walk
        const after = { cobblestone: 52, crafting_table: 1 };       // a walk west changes no inventory
        const pre = { name: 'w' }; recordEffectEvidence(pre, taskStart, after, null);
        assert.deepStrictEqual(pre.effects.sort(), ['cobblestone', 'crafting_table']);
        const post = { name: 'w' }; recordEffectEvidence(post, runBefore, after, null);
        assert.deepStrictEqual(post.effects, []);
    });
    it('a successful practice walk is judged by its learned post, moves n, and its first measured run drops the fake effects', async () => {
        const s = live();
        const { v } = mkPracticeV([s], async b => { b.__psnTrace.push(rootRec(s.name, { t0: 1000, t1: 46000, from: { x: -140, y: 60, z: 107 }, to: { ...DEST } })); });
        const r = await v._runPracticeSkill(s);
        assert.strictEqual(r.ok, true, r.detail);
        assert.deepStrictEqual([s.stats.success, s.stats.fail], [2, 0], 'n moved from 1 to 2');
        assert.strictEqual(s.stats.practiceRuns, LIVE.stats.practiceRuns + 1);
        assert.deepStrictEqual(s.effects, [], 'crafting_table / cobblestone were not gained by the measured run');
        assert.deepStrictEqual(s.effectEvidence, { runs: 1, items: {} });
        assert.deepStrictEqual(s.runMs, { n: 1, max: 45000 }, 'its duration is learned from the trace');
    });
    it('a practice walk that ends far from the target is a failure in its stats', async () => {
        const s = live();
        const { v } = mkPracticeV([s], async b => { b.__psnTrace.push(rootRec(s.name, { t0: 0, t1: 5000, from: { x: -25, y: 69, z: 70 }, to: { x: -30, y: 69, z: 70 } })); });
        const r = await v._runPracticeSkill(s);
        assert.strictEqual(r.ok, false);
        assert.deepStrictEqual([s.stats.success, s.stats.fail, s.stats.streakFail], [1, 1, 1]);
        assert.deepStrictEqual(s.effects, ['crafting_table', 'cobblestone'], 'a failed run is not a measured success');
    });
});

describe('fix74: practice outcomes feed the ranking', () => {
    it('after its practice success the n=1 skill is no longer the top candidate', async () => {
        const a = live();
        const b = { ...live(), name: 'otherWalk', stats: { success: 1, fail: 0, streakFail: 0, tasks: [] } };
        const { v } = mkPracticeV([a, b], async bot => { bot.__psnTrace.push(rootRec(a.name, { t0: 0, t1: 10, from: { x: -140, y: 60, z: 107 }, to: { ...DEST } })); },
            { _getPendingGoalItems: () => new Set() });
        assert.strictEqual(v._selectPracticeSkill(new Map()).name, a.name, 'tie: first by order');
        await v._runPracticeSkill(a);
        assert.strictEqual(v._selectPracticeSkill(new Map()).name, 'otherWalk');
    });
    it('a skill nothing can judge (no post-contract, no verified effects) is not picked', () => {
        const s = { ...live(), name: 'noJudge' }; delete s.contract;
        const { v } = mkPracticeV([s], async () => {}, { _getPendingGoalItems: () => new Set() });
        assert.strictEqual(v._practiceJudgeable(s), false);
        assert.strictEqual(v._selectPracticeSkill(new Map()), null);
        s.effectEvidence = { runs: 2, items: { raw_iron: { runs: 2, gained: 2 } } };
        assert.strictEqual(v._selectPracticeSkill(new Map()).name, 'noJudge');
        assert.strictEqual(v._selectPracticeSkill(new Map([['noJudge', 'lint failed']])), null, 'not re-picked in the same session');
    });
});

describe('fix74: effect evidence', () => {
    it('an item gained once by something else drops out at the next run that does not gain it', () => {
        const s = { name: 's' };
        recordEffectEvidence(s, { raw_iron: 0 }, { raw_iron: 1, dirt: 2 }, null);
        assert.deepStrictEqual(s.effects.sort(), ['dirt', 'raw_iron']);
        recordEffectEvidence(s, { raw_iron: 1, dirt: 2 }, { raw_iron: 2, dirt: 2 }, null);
        assert.deepStrictEqual(s.effects, ['raw_iron']);
    });
    it('a goal hint only says which ups count: a two-product skill is not outvoted by a run whose goal was the other product', () => {
        const s = { name: 'tools' };
        recordEffectEvidence(s, {}, { stick: 4, crafting_table: 1 }, null);
        recordEffectEvidence(s, {}, { stick: 4 }, ['stick']);
        recordEffectEvidence(s, {}, { crafting_table: 1 }, ['crafting_table']);
        assert.deepStrictEqual(s.effects.sort(), ['crafting_table', 'stick']);
    });
    it('bad arguments fail loud', () => {
        assert.throws(() => recordEffectEvidence({ name: 'z' }, null, {}, null), /before\/after inventories are required/);
        assert.throws(() => recordEffectEvidence({ name: 'z' }, {}, {}, 'stick'), /goalItems must be an array or null/);
    });
});

describe('fix74: the practice cap is learned per skill', () => {
    it('durations come from calls that returned on their own; interrupted or unfinished calls are not samples', () => {
        const s = { name: 'a' }, t = { name: 't' };
        const { v } = mkPracticeV([s, t], async () => {});
        v._learnRunDurations([{ name: 'a', t0: 0, t1: 700 }, { name: 'a', t0: 0, t1: 300 }, { name: 'a', t0: 0, t1: 9000, intr: true }, { name: 'a', t0: 0 }, { name: 'getNearestBlock', t0: 0, t1: 5 }]);
        assert.deepStrictEqual(s.runMs, { n: 2, max: 700 });
        assert.strictEqual(v._practiceBound(s), 700);
        assert.strictEqual(v._practiceBound(t), null, 'no observation: no cap');
        assert.throws(() => v._learnRunDurations(null), /no trace/);
    });
    it('a run past its learned bound is interrupted (skill AND pathfinder), awaited, and counted as a failure', async () => {
        const s = { ...live(), runMs: { n: 3, max: 40 } };
        let returned = false;
        const { v, calls } = mkPracticeV([s], async b => {
            // a goto that only ends when the pathfinder is stopped, like the live walk
            await new Promise(resolve => { const stop = b.pathfinder.stop; b.pathfinder.stop = () => { stop(); resolve(); }; });
            returned = true;
        });
        const r = await v._runPracticeSkill(s);
        assert.strictEqual(r.ok, false);
        assert.match(r.detail, /cut at its learned bound 40ms/);
        assert.strictEqual(calls.interrupts, 1);
        assert.strictEqual(calls.sources[0].kind, 'practice', 'fix75: the interrupt names its source');
        assert.strictEqual(calls.pathfinderStops, 1, 'the movement it set going was stopped');
        assert.strictEqual(returned, true, 'the skill returned before the slot was given back (fix70 awaiting)');
        assert.deepStrictEqual([s.stats.success, s.stats.fail], [1, 1]);
        assert.strictEqual(v.agent.bot.interrupt_code, false);
        assert.deepStrictEqual(s.runMs, { n: 3, max: 40 }, 'a cut run is not a duration sample');
    });
    it('a skill with no observed duration is uncapped: it runs until the code-model call completes, and the abort is no verdict', async () => {
        const s = live();
        const { v, calls } = mkPracticeV([s], async b => { while (!b.interrupt_code) await new Promise(r => setImmediate(r)); });
        const p = v._runPracticeSkill(s);
        let settled = false; p.then(() => { settled = true; });
        for (let i = 0; i < 200; i++) await new Promise(r => setImmediate(r));
        assert.strictEqual(settled, false, 'no cap cut it');
        v._stopIdlePractice();
        assert.strictEqual(await p, null);
        assert.strictEqual(calls.pathfinderStops, 1);
        assert.deepStrictEqual([s.stats.success, s.stats.fail], [1, 0], 'abort is not the skill\'s fault');
        assert.strictEqual(Object.hasOwn(s, 'runMs'), false);
    });
});

describe('fix74 on fix76: an unmet precondition is no verdict in practice either', () => {
    it('a practice run that fails after marking its precondition unmet leaves stats alone and clears the marker', async () => {
        const s = live();
        const { v, bot } = mkPracticeV([s], async b => { markPreconditionUnmet(b, { item: 'cooked_mutton' }); b.__psnTrace.push(rootRec(s.name, { t0: 0, t1: 5000, from: { x: -25, y: 69, z: 70 }, to: { x: -30, y: 69, z: 70 } })); });
        const r = await v._runPracticeSkill(s);
        assert.strictEqual(r.ok, null, r.detail);
        assert.match(r.detail, /unmet precondition \(precondition\)/);
        assert.deepStrictEqual([s.stats.success, s.stats.fail], [1, 0], 'not counted against the skill');
        assert.strictEqual(peekPreconditionUnmet(bot), null, 'the marker does not outlive the run');
    });
    it('a stale marker from before the run cannot void a real failure', async () => {
        const s = live();
        const { v, bot } = mkPracticeV([s], async b => { b.__psnTrace.push(rootRec(s.name, { t0: 0, t1: 5000, from: { x: -25, y: 69, z: 70 }, to: { x: -30, y: 69, z: 70 } })); });
        markPreconditionUnmet(bot);
        const r = await v._runPracticeSkill(s);
        assert.strictEqual(r.ok, false);
        assert.deepStrictEqual([s.stats.success, s.stats.fail], [1, 1]);
    });
});

describe('fix74: no magic timers or fallbacks in practice', () => {
    const body = (start, end) => SRC.slice(SRC.indexOf(start), SRC.indexOf(end, SRC.indexOf(start))).split('\n').map(l => l.replace(/\s\/\/ .*$/, '')).join('\n');   // code only
    it('the practice loop and run have no sleeps; the only timer is the learned bound', () => {
        const loop = body('    async _startIdlePractice(callNum) {', '    _armPracticeAbort() {');
        const run = body('    async _runPracticeSkill(skill) {', '    // fix47: compute cheapest tool');
        assert.doesNotMatch(loop, /setTimeout|setInterval|\b\d{3,}\b/);
        assert.deepStrictEqual(run.match(/setTimeout\([^;]*;/g), ["setTimeout(() => resolve({ kind: 'cut' }), bound);"]);
        assert.doesNotMatch(run, /maxPracticeMs|10000/);
    });
    it('a session with no eligible skill ends at once instead of pausing', async () => {
        const { v } = mkPracticeV([], async () => {});
        v._idlePracticeActive = false;
        const t0 = Date.now();
        await v._startIdlePractice(1);
        assert.ok(Date.now() - t0 < 1000, `ended in ${Date.now() - t0}ms`);
    });
    it('callers set _lastEffects from the entry without an `|| []` default', () => {
        assert.doesNotMatch(SRC, /_lastEffects = [^;\n]*\.effects \|\|/);
        assert.strictEqual((SRC.match(/this\._lastEffects = (?:e|x)\.effects;/g) || []).length, 5);
    });
});
