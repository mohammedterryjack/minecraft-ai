/**
 * fix91 (live icefox2000, 09:49–10:02 GMT 7 Nov, bc5da90): 14–19 subgoals stayed queued.
 * Hunger won every step ("raiser none playable"). A cold-start proposal the learned
 * posterior rejected made _serveUrgent return true, so _step ended with nothing dequeued
 * ("not pursued", then a step with no "new task"). A repair or a decompose that produced
 * nothing did the same (steps of 4–9ms). A serve that pursued a proposal and did not act
 * still pre-empted the queue. Dead heads (parent completed, parent decomposition gone,
 * parent no longer lists the entry, a retry the posterior backs off, an invalid task,
 * a goal the state already satisfies) were shifted and either run or abandoned, and the
 * live entry behind them did not run in that step.
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { VitalsModel } from '../src/agent/vitals_model.js';
import { _setVersionForTest as loadMcData } from '../src/utils/mcdata.js';

const VER = '1.21.4';
const LIVE = { task: 'Mine 1 iron_ore', parent: 'Craft 1 iron_pickaxe', depth: 1 };
const LIVE_DEC = { subs: ['Mine 1 iron_ore'], skills: [], at: 1, reason: 'test' };

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
    loadMcData(VER);
});

const realRandom = Math.random;
afterEach(() => { Math.random = realRandom; });

function liveRegen() {
    const m = new VitalsModel({
        regen: {
            15: { n: 1021, up: 0 }, 16: { n: 246, up: 0 }, 17: { n: 76, up: 0 },
            18: { n: 14, up: 4 }, 19: { n: 10, up: 3 }, 20: { n: 14, up: 9 },
        },
        runs: {},
        foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
    });
    // No measured food raiser. A learned consume effect is a food plan (fix93), not this cold start.
    return m;
}

function rig({ food = 20, health = 20, subgoals, decomposed, completed, completedAt, goalFailStates } = {}) {
    const v = Object.create(Voyager.prototype);
    v.skills = [];
    v.npGraph = null;
    v.progress = {
        subgoals: subgoals !== undefined ? subgoals : [{ ...LIVE }],
        decomposed: decomposed !== undefined ? decomposed : { 'Craft 1 iron_pickaxe': { ...LIVE_DEC, subs: [...LIVE_DEC.subs] } },
        decomposeQueue: null,
        completed: completed !== undefined ? completed : [],
        completedAt: completedAt !== undefined ? completedAt : {},
        failed: [],
        blockers: [],
        goalStats: {},
        goalFailStates: goalFailStates !== undefined ? goalFailStates : [],
        fix25: true,
        recipeEdges: {},
    };
    Object.defineProperty(v, '_decomposeQueue', {
        get() { return this.progress.decomposeQueue; },
        set(q) { this.progress.decomposeQueue = q; },
    });
    v.agent = {
        name: 'fix91',
        bot: {
            health, food,
            game: { maxHealth: 20, maxFood: 20 },
            interrupt_code: false,
            inventory: { emptySlotCount: () => 10 },
            entity: { position: { x: 0, y: 64, z: 0 } },
            version: VER,
            currentWindow: null,
        },
        openChat() {},
        actions: { executing: false },
    };
    v.vitals = liveRegen();
    v._curSub = null;
    v.currentTask = null;
    v._saveProgress = () => {};
    v._saveSkills = () => {};
    v._repairQueue = [];
    v._afterSuccess = () => {};
    for (const m of ['_checkHomeGround', '_watchWindows', '_watchDimension', '_oneshot', '_requeueDeferred', '_prefetchPlan']) v[m] = () => {};
    for (const m of ['_queueApiLintRepairs', '_gateTrial', '_backfillContracts', '_refactor', '_prune', '_generalise', '_split', '_retention', '_idlePractice']) v[m] = async () => false;
    v.observe = () => ({ inventory: {}, nearby_blocks: [], position: '0,64,0', time: 'day 0', food_value: food, is_day: true });
    v.pursued = [];
    v._pursueProposedTask = async (task) => { v.pursued.push(task); return false; };
    v.proposeTask = async () => { throw new Error('proposeTask should not run'); };
    return v;
}

describe('fix91: a rejected cold-start does not consume the step', () => {
    it('the queued subgoal is dequeued and run in the same step', async () => {
        const v = rig({ food: 17, health: 18 });
        const stateKey = 'inv:;near:;is_day:true';
        v.progress.goalFailStates = [{ task: 'Get 1 cooked_mutton', ok: false, reason: 'replay failed', state: stateKey }];
        v.proposeTask = async () => ({ task: 'Get 1 cooked_mutton', reasoning: 'the bot is hungry', context: '' });
        Math.random = () => 0.999;
        await v._step();
        assert.deepStrictEqual(v.pursued, ['Mine 1 iron_ore']);
        assert.deepStrictEqual(v.progress.subgoals, []);
        assert.strictEqual(v._curSub.task, 'Mine 1 iron_ore');
    });
});

describe('fix91: a serve that does not act does not pre-empt the queue', () => {
    it('an accepted cold-start whose pursue produces no action still runs the subgoal', async () => {
        const v = rig({ food: 17, health: 18 });
        v.proposeTask = async () => ({ task: 'Look around the hut', reasoning: 'r', context: '' });
        await v._step();
        assert.deepStrictEqual(v.pursued, ['Look around the hut', 'Mine 1 iron_ore']);
        assert.deepStrictEqual(v.progress.subgoals, []);
    });

    it('a goal that is already satisfied returns false from pursue (no action)', async () => {
        const v = rig();
        v._pursueProposedTask = Voyager.prototype._pursueProposedTask;
        v._goalAlreadySatisfied = () => ({ satisfied: true, reason: 'have 1 dirt' });
        const acted = await v._pursueProposedTask('Collect 1 dirt', { task: 'Collect 1 dirt', reasoning: 'r', context: '' }, v.observe());
        assert.strictEqual(acted, false);
        assert.ok(v.progress.completed.includes('Collect 1 dirt'));
    });

    it('cursor-limited with no replay returns false from pursue (nothing ran)', async () => {
        const v = rig();
        v._pursueProposedTask = Voyager.prototype._pursueProposedTask;
        v._goalAlreadySatisfied = () => ({ satisfied: false, reason: 'not yet' });
        v._resolveGoal = () => ({ kind: 'open' });
        v._structuredReplay = () => null;
        v._embedReplay = async () => null;
        v._findReplay = () => null;
        v._backchain = async () => null;
        v._cursorLimited = () => true;
        const acted = await v._pursueProposedTask('Look around the hut', { task: 'Look around the hut', reasoning: 'r', context: '' }, v.observe());
        assert.strictEqual(acted, false);
    });
});

describe('fix91: a no-op repair or decompose does not consume the step', () => {
    it('a repair that returns false leaves the step to the queued subgoal', async () => {
        const v = rig({ food: 20, health: 20 });
        v._repairQueue = [{ target: 'killMob', kind: 'callee_fix' }];
        v._repair = async () => false;
        await v._step();
        assert.deepStrictEqual(v.pursued, ['Mine 1 iron_ore']);
        assert.deepStrictEqual(v.progress.subgoals, []);
    });

    it('a decompose that returns false leaves the step to the queued subgoal', async () => {
        const v = rig({ food: 20, health: 20 });
        v._decomposeQueue = { task: 'Get 1 cooked_mutton', reason: 'failed 3x' };
        v._decompose = async () => false;
        await v._step();
        assert.strictEqual(v._decomposeQueue, null);
        assert.deepStrictEqual(v.pursued, ['Mine 1 iron_ore']);
        assert.deepStrictEqual(v.progress.subgoals, []);
    });
});

describe('fix91: a dead head does not block a live subgoal', () => {
    it('a subgoal whose parent completed after it was decomposed is removed; the next one runs', async () => {
        const v = rig({
            food: 20,
            subgoals: [
                { task: 'Mine 1 stone', parent: 'Build a wall', depth: 1 },
                { ...LIVE },
            ],
            completed: ['Build a wall'],
            completedAt: { 'Build a wall': 2 },
            decomposed: {
                'Build a wall': { subs: ['Mine 1 stone'], skills: [], at: 1, reason: 'test' },
                'Craft 1 iron_pickaxe': { ...LIVE_DEC, subs: [...LIVE_DEC.subs] },
            },
        });
        await v._step();
        assert.deepStrictEqual(v.pursued, ['Mine 1 iron_ore']);
        assert.ok(v.progress.failed.some(t => t.startsWith('Mine 1 stone (stale:') && t.includes('Build a wall')));
        assert.deepStrictEqual(v.progress.subgoals, []);
    });

    it('a subgoal whose parent has no decomposition is removed; the next one runs', async () => {
        const v = rig({
            food: 20,
            subgoals: [
                { task: 'Mine 1 stone', parent: 'Build a wall', depth: 1 },
                { ...LIVE },
            ],
            decomposed: { 'Craft 1 iron_pickaxe': { ...LIVE_DEC, subs: [...LIVE_DEC.subs] } },
        });
        await v._step();
        assert.deepStrictEqual(v.pursued, ['Mine 1 iron_ore']);
        assert.ok(v.progress.failed.some(t => t.includes('Mine 1 stone') && t.includes('no decomposition')));
    });

    it('a subgoal the parent decomposition no longer lists is removed; the next one runs', async () => {
        const v = rig({
            food: 20,
            subgoals: [
                { task: 'Mine 1 stone', parent: 'Craft 1 iron_pickaxe', depth: 1 },
                { ...LIVE },
            ],
            decomposed: { 'Craft 1 iron_pickaxe': { subs: ['Mine 1 iron_ore'], skills: [], at: 1, reason: 'replaced' } },
        });
        await v._step();
        assert.deepStrictEqual(v.pursued, ['Mine 1 iron_ore']);
        assert.ok(v.progress.failed.some(t => t.includes('Mine 1 stone') && t.includes('no longer lists')));
    });

    it('a retry the learned posterior backs off is removed; a child of that parent still runs', async () => {
        const v = rig({
            food: 20,
            subgoals: [
                { task: 'Get 1 cooked_mutton', retry: true, depth: 0 },
                { task: 'Mine 1 iron_ore', parent: 'Get 1 cooked_mutton', depth: 1 },
            ],
            decomposed: { 'Get 1 cooked_mutton': { subs: ['Mine 1 iron_ore'], skills: [], at: 1, reason: 'needs' } },
            goalFailStates: [{ task: 'Get 1 cooked_mutton', ok: false, reason: 'replay failed', state: 'inv:;near:;is_day:true' }],
        });
        Math.random = () => 0.999;
        await v._step();
        assert.deepStrictEqual(v.pursued, ['Mine 1 iron_ore']);
        assert.ok(v.progress.failed.some(t => t.startsWith('Get 1 cooked_mutton (stale:') && t.includes('backed off')));
        assert.deepStrictEqual(v.progress.subgoals, []);
    });

    it('an invalid head is removed; the live subgoal runs in the same step', async () => {
        const v = rig({
            food: 20,
            subgoals: [
                { task: 'Mine 1 not_a_real_thing', parent: 'Craft 1 iron_pickaxe', depth: 1 },
                { ...LIVE },
            ],
            decomposed: { 'Craft 1 iron_pickaxe': { subs: ['Mine 1 not_a_real_thing', 'Mine 1 iron_ore'], skills: [], at: 1, reason: 'test' } },
        });
        await v._step();
        assert.deepStrictEqual(v.pursued, ['Mine 1 iron_ore']);
        assert.ok(v.progress.failed.some(t => t.includes('not_a_real_thing') && t.includes('unknown item')));
        assert.deepStrictEqual(v.progress.subgoals, []);
    });

    it('a head the state already satisfies is completed; the next subgoal runs', async () => {
        const v = rig({
            food: 20,
            subgoals: [
                { task: 'Collect 1 dirt', parent: 'Craft 1 iron_pickaxe', depth: 1 },
                { ...LIVE },
            ],
            decomposed: { 'Craft 1 iron_pickaxe': { subs: ['Collect 1 dirt', 'Mine 1 iron_ore'], skills: [], at: 1, reason: 'test' } },
        });
        v.observe = () => ({ inventory: { dirt: 1 }, nearby_blocks: [], position: '0,64,0', time: 'day 0' });
        await v._step();
        assert.deepStrictEqual(v.pursued, ['Mine 1 iron_ore']);
        assert.ok(v.progress.completed.includes('Collect 1 dirt'));
        assert.deepStrictEqual(v.progress.subgoals, []);
    });
});
