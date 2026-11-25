/**
 * fix186 (iMac, 25 Nov 2026, 21:00Z steer): "approach cod" was routed (lexical/embedding name match) to the learned
 * approachCod whose evidence says it produces [cobblestone]. fix86 noticed the disjoint pair only AFTER the replay ran
 * (MISROUTE verdict in _attribute), so every appearance of the goal burned another doomed run — three "task failed after
 * 4 attempts: approach cod" in one window, each preceded by the same `!!! [route] approachCod routed to "approach cod"`
 * warning. The rule now runs BEFORE the run: a selector-chosen route (route.routed) whose skill has non-empty learned
 * produces disjoint from the goal items returns null (no replay candidate) and the task goes to backchain/code, exactly
 * like the precheck skips. Empty produces stays no evidence (fix86); committed routes (backchain, plan steps, need
 * raisers, gate trials — no routed flag) keep running.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

let Voyager, NeedsProducesGraph;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest('1.21.4');
    NeedsProducesGraph = (await import('../src/agent/needs_produces.js')).NeedsProducesGraph;
});

const approachCodEntry = (effects) => ({
    name: 'approachCod',
    description: 'Walk to a nearby cod.',
    task: 'mine 64 cobblestone',
    deps: [],
    effects,
    code: 'async function approachCod(bot) { await bot.chat("stub"); }\n\n// DESCRIPTION: Walk to a nearby cod.',
    saved: '2026-11-25T10:00:00.000Z',
    stats: { success: 30, fail: 2, streakFail: 0, tasks: ['mine 64 cobblestone'], lastRun: Date.now(), practiceRuns: 40 },
});

/** _replay with the real route-fit chain; the world, staging and persistence are stubbed. `executed` proves the run ran. */
function rig(effects) {
    const v = Object.create(Voyager.prototype);
    v.skills = [approachCodEntry(effects)];
    v.progress = { completedAt: {}, completed: [], failed: [], goalStats: {}, replayThreshold: 0.85 };
    v.npGraph = Object.assign(Object.create(NeedsProducesGraph.prototype), { confirmed: {}, confirmedProduces: () => [], recordDelta: () => {} });
    v._saveSkills = () => {}; v._saveProgress = () => {};
    const bot = { output: '', inventory: { emptySlotCount: () => 1 }, entity: { position: { x: 10, y: 66, z: 10 } }, food: 20 };
    v.agent = { bot };
    v.observe = () => ({ inventory: { cobblestone: 5 }, equipment: {}, nearby_blocks: [], nearby_entities: [], food_value: 20 });
    v.executed = false;
    v._stageLintExecTraced = async () => {
        v.executed = true;
        return { lint: null, staged: { func: { main: async b => { b.__psnTrace = []; b.__psnOut = ''; } } } };
    };
    v._openTrialJournal = () => () => {};
    v._timedBotForSkillRun = () => bot;
    v._run = async (l, fn) => { await fn(); return { success: true, message: 'Code finished.' }; };
    v._diedInRun = () => null; v._stalledInRun = () => null; v._crashedInRun = () => null; v._lastRunTimedOut = false;
    v._foodRaiseSaturated = () => null; v._libraryFault = () => false; v._classifyUnmetPrecondition = () => null;
    v._failureNeeds = () => null; v._detectInventoryFullFailure = () => null;
    v._learnRunDurations = () => {}; v._checkContracts = () => {}; v._learnVitalsEffects = () => {}; v._learnSlotEffects = () => {};
    v._prefetchBlamedEmbeds = () => {};
    v.logs = [];
    return v;
}
async function quiet(v, fn) {
    const log = console.log; console.log = (...a) => { v.logs.push(a.join(' ')); };
    try { return await fn(); } finally { console.log = log; }
}
const routed = () => ({ name: 'approachCod', call: 'await approachCod(bot);', routed: true });
const committed = () => ({ name: 'approachCod', call: 'await approachCod(bot);' });

describe('fix186 disjoint routed replay is refused before the run', () => {
    it('"approach cod" routed to approachCod (learned produces [cobblestone]): null, nothing executed, stats untouched', async () => {
        const v = rig(['cobblestone']);
        const before = v.observe();
        const rp = await quiet(v, () => v._replay('approach cod', before, routed()));
        assert.strictEqual(rp, null, 'disjoint routed replay must return null (no candidate), not a run result');
        assert.strictEqual(v.executed, false, 'the doomed run must not be staged or executed');
        const e = v.skills[0];
        assert.strictEqual(e.stats.fail, 2, 'no failure charged for a run that never happened');
        assert.ok(v.logs.some(l => l.includes('[fix186] skip replay approachCod')), 'skip is logged: ' + v.logs.filter(l => l.includes('fix186')).join(' | '));
    });
    it('same disjoint pair through the open-goal route form is also refused', async () => {
        const v = rig(['cobblestone']);
        const rp = await quiet(v, () => v._replay('collect 1 cod', v.observe(), routed()));
        assert.strictEqual(rp, null);
        assert.strictEqual(v.executed, false);
    });
    it('empty learned produces is no evidence (fix86): the routed replay still runs', async () => {
        const v = rig([]);
        await quiet(v, () => v._replay('approach cod', v.observe(), routed()));
        assert.strictEqual(v.executed, true, 'empty produces must not skip the run');
    });
    it('a committed route (no routed flag, e.g. gate trial or plan step) still runs despite disjoint produces', async () => {
        const v = rig(['cobblestone']);
        await quiet(v, () => v._replay('approach cod', v.observe(), committed()));
        assert.strictEqual(v.executed, true, 'committed routes are not selector routings and keep running');
    });
    it('a routed fit (learned produces includes the goal item) runs', async () => {
        const v = rig(['cod']);
        await quiet(v, () => v._replay('approach cod', v.observe(), routed()));
        assert.strictEqual(v.executed, true, 'fitting routes must run normally');
    });
});
