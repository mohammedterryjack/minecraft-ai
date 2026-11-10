/**
 * fix90 (live icefox2000, 09:05 GMT 7 Nov, 35141e0, after fix89): hunger serve logged
 * "raiser none playable" (the measured raiser is consume, not a library skill) and cold-started
 * the curriculum. qwen proposed eatFood 21/23 times. Each run logged
 * "FAILED: hungry but no food could be consumed" and the inventory held no food. No structured
 * need, no backchain. The curriculum proposed the same goal again in the same state.
 *
 * A failure that means "no item of kind X" is an anyOf need of that kind, taken from minecraft-data
 * (not from the skill's own list). The curriculum backs a goal off by its posterior in this state.
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { VitalsModel } from '../src/agent/vitals_model.js';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(registry);
const mc = require('minecraft-data');

const FAIL = 'FAILED: hungry but no food could be consumed [food 17/20 health 18/20]';
const REASON = `eatFood: ${FAIL}`;
const SHORT = "const order = ['apple','beef','cooked_beef'];";

function foodNames() {
    const md = mc(VER);
    const names = [];
    for (const rec of Object.values(md.foods)) {
        if (!rec || typeof rec.name !== 'string') continue;
        if (!Object.hasOwn(md.itemsByName, rec.name)) continue;
        if (!names.includes(rec.name)) names.push(rec.name);
    }
    names.sort();
    if (names.length < 2) throw new Error('[fix90 test] minecraft-data foods is not an item collection');
    return names;
}

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
});

const realRandom = Math.random;
afterEach(() => { Math.random = realRandom; });

function eatSkill(code) {
    return {
        name: 'eatFood', task: 'eatFood', description: 'Eat food the bot is holding',
        code: `async function eatFood(bot) {\n    ${code}\n    return false;\n}`,
        deps: [], effects: [], consumes: {}, stats: { success: 0, fail: 0, tasks: [] },
        contract: { pre: 'c => c.pre.alive', post: 'c => c.ret', text: 'returns whether food was eaten' },
    };
}

function traceOf(line) {
    return [{ name: 'eatFood', parent: -1, depth: 0, ownFail: [line] }];
}

function mkV(skills) {
    const v = Object.create(Voyager.prototype);
    v.skills = skills.map(s => JSON.parse(JSON.stringify(s)));
    v.progress = {
        completedAt: {}, completed: [], failed: [], goalStats: {}, goalFailStates: [],
        subgoals: [], decomposed: {}, blockers: [], recipeEdges: {},
    };
    v.npGraph = null;
    v._saveProgress = () => {};
    v._saveSkills = () => {};
    v._windowCheck = () => {};
    v._afterSuccess = () => {};
    v._prefetchPlan = () => {};
    v._curSub = null;
    v.currentTask = null;
    const bot = {
        version: VER, registry, health: 18, food: 17,
        game: { maxHealth: 20, maxFood: 20 },
        inventory: { emptySlotCount: () => 36 },
        entity: { position: { x: 0, y: 64, z: 0 } },
        recipesAll: (id) => Recipe.find(id),
        currentWindow: null,
    };
    v.agent = { name: 'icefox2000', bot, openChat() {} };
    v.observe = () => ({ inventory: {}, nearby_blocks: [], food_value: 17, empty_inventory_slots: 36, is_day: true });
    return v;
}

function liveRegen(runs) {
    return new VitalsModel({
        regen: {
            15: { n: 1021, up: 0 }, 16: { n: 246, up: 0 }, 17: { n: 76, up: 0 },
            18: { n: 14, up: 4 }, 19: { n: 10, up: 3 }, 20: { n: 14, up: 9 },
        },
        runs,
        foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
    });
}

describe('fix90: a "no item of kind" failure is an anyOf need from game data', () => {
    it('the eatFood FAILED line with an empty inventory is the whole foods collection, not the skill list', () => {
        const v = mkV([eatSkill(SHORT)]);
        const needs = v._failureNeeds('eatFood', null, traceOf(FAIL), v.observe());
        const foods = foodNames();
        assert.ok(Array.isArray(needs) && needs.length === 1, JSON.stringify(needs));
        assert.strictEqual(needs[0].reason, 'input');
        assert.strictEqual(needs[0].count, 1);
        assert.deepStrictEqual(needs[0].anyOf, foods);
        assert.ok(needs[0].anyOf.includes('bread'), 'the kind is the game-data collection, which the skill list does not name');
        assert.ok(!SHORT.includes('bread'));
    });

    it('the same failure on the need label (urgent serve task) is the same need', () => {
        const v = mkV([eatSkill('return false;')]);
        const needs = v._failureNeeds('need:hunger', null, traceOf(FAIL), v.observe());
        assert.deepStrictEqual(needs[0].anyOf, foodNames());
        assert.strictEqual(needs[0].reason, 'input');
    });

    it('quoted item literals that are one kind, and no failure text, are that whole kind', () => {
        const v = mkV([eatSkill(SHORT)]);
        const needs = v._failureNeeds('eatFood', null, null, v.observe());
        assert.deepStrictEqual(needs[0].anyOf, foodNames());
    });

    it('holding any member, a single literal, a mixed set, or an unnamed kind is not this need', () => {
        const v = mkV([eatSkill(SHORT)]);
        const holding = { inventory: { bread: 1 }, nearby_blocks: [] };
        assert.strictEqual(v._failureNeeds('eatFood', null, traceOf(FAIL), holding), null);
        assert.strictEqual(v._failureNeeds('eatFood', null, null, { ...v.observe(), inventory: { bread: 1 } }), null);
        const one = mkV([eatSkill("const only = 'apple';")]);
        assert.strictEqual(one._failureNeeds('eatFood', null, null, one.observe()), null);
        const mixed = mkV([eatSkill("const xs = ['apple','cobblestone'];")]);
        assert.strictEqual(mixed._failureNeeds('eatFood', null, null, mixed.observe()), null);
        const plain = mkV([eatSkill('return false;')]);
        assert.strictEqual(plain._failureNeeds('eatFood', null, traceOf('FAILED: no stone in reach'), plain.observe()), null);
        const plural = v._failureNeeds('eatFood', null, traceOf('FAILED: no foods could be consumed'), v.observe());
        assert.deepStrictEqual(plural[0].anyOf, foodNames());
    });

    it('kind discovery does not name a collection or an item', () => {
        const src = [Voyager.prototype._kindInputNeeds, Voyager.prototype._itemKinds, Voyager.prototype._collectionItems, Voyager.prototype._kindAliases]
            .map(fn => fn.toString()).join('\n');
        assert.equal(/apple|bread|mutton|cooked_/.test(src), false);
        assert.equal(/['"]foods?['"]/.test(src), false);
    });
});

describe('fix90: curriculum replay of eatFood chains the need onto the hunger serve', () => {
    function replayFail(v) {
        const calls = [];
        v._replay = async (task) => {
            calls.push(task);
            const needs = v._failureNeeds(task, null, traceOf(FAIL), v.observe());
            return { ok: false, name: 'eatFood', reason: REASON, needs };
        };
        v._backchain = async () => null;
        v._cursorLimited = () => true;
        return calls;
    }

    it('a skill-goal replay under need:hunger backchains to obtaining one food', async () => {
        const v = mkV([eatSkill(SHORT)]);
        v.currentTask = 'need:hunger';
        replayFail(v);
        await v._pursueProposedTask('eatFood', { task: 'eatFood', reasoning: 'r', context: '' }, v.observe());
        const foods = new Set(foodNames());
        assert.ok(Object.hasOwn(v.progress.decomposed, 'need:hunger'), JSON.stringify(Object.keys(v.progress.decomposed)));
        const blocker = v.progress.blockers.find(b => Array.isArray(b.anyOf) && b.anyOf.some(n => foods.has(n)));
        assert.ok(blocker, JSON.stringify(v.progress.blockers));
        assert.strictEqual(blocker.reason, 'input');
        assert.ok(v.progress.subgoals.some(s => typeof s.task === 'string' && blocker.anyOf.some(n => s.task.endsWith(' ' + n))), JSON.stringify(v.progress.subgoals));
    });

    it('a learned consume effect plans food once and does not replay eatFood', async () => {
        const runs = {};
        const m = liveRegen(runs);
        m.noteRun('consume', { hp: 18, food: 10 }, { hp: 18, food: 13.5 });
        for (let i = 1; i < 13; i++) m.noteRun('consume', { hp: 18, food: 10 }, { hp: 18, food: 13.5 });
        assert.ok(m.foodRaisers().some(r => r.name === 'consume'));
        const v = mkV([eatSkill(SHORT)]);
        v.vitals = m;
        v.agent.bot.food = 17;
        v.agent.bot.health = 18;
        const calls = replayFail(v);
        v.proposeTask = async () => { throw new Error('proposeTask must not cold-start over a learned consume effect'); };
        assert.strictEqual(await v._serveUrgent(), true);
        assert.deepStrictEqual(calls, [], 'eatFood is not replayed');
        assert.ok(Object.hasOwn(v.progress.decomposed, 'need:hunger'));
        assert.ok(v.progress.subgoals.some(s => s.parent === 'need:hunger'), JSON.stringify(v.progress.subgoals));
        assert.strictEqual(await v._serveUrgent(), false);
        assert.deepStrictEqual(calls, [], 'the queued plan is the serve; eatFood is not proposed');
    });

    it('a playable raiser that fails the same way chains under the need label', async () => {
        const m = liveRegen({});
        m.noteRun('eatFood', { hp: 18, food: 10 }, { hp: 18, food: 16 });
        const v = mkV([eatSkill(SHORT)]);
        v.vitals = m;
        v.agent.bot.food = 17;
        v.agent.bot.health = 18;
        const calls = [];
        v._replay = async (task) => {
            calls.push(task);
            const needs = v._failureNeeds(task, null, traceOf(FAIL), v.observe());
            return { ok: false, name: 'eatFood', reason: REASON, needs };
        };
        assert.strictEqual(await v._serveUrgent(), true);
        assert.deepStrictEqual(calls, ['need:hunger']);
        assert.ok(Object.hasOwn(v.progress.decomposed, 'need:hunger'));
        const foods = new Set(foodNames());
        assert.ok(v.progress.blockers.some(b => Array.isArray(b.anyOf) && b.anyOf.some(n => foods.has(n))));
        assert.strictEqual(await v._serveUrgent(), false);
        assert.deepStrictEqual(calls, ['need:hunger']);
    });
});

describe('fix90: the curriculum does not re-propose a goal that just failed in this state', () => {
    const eq = { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' };
    const stateKey = 'inv:;near:;is_day:true';
    const failReason = 'FAILED: hungry but no food could be consumed';

    function curriculum(v) {
        v.progress.goalFailStates = [{ task: 'eatFood', ok: false, reason: failReason, state: stateKey }];
        v.repairMemory = { getWorkflowsForTask: () => [], formatWorkflowHints: () => '' };
        v._hutBuilt = () => false;
        v._cursorLimited = () => false;
        v._logPromptBreakdown = () => {};
        v.vitals = new VitalsModel({ regen: {}, runs: {}, foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } } });
        v.agent.bot.health = 20;
        v.agent.bot.food = 20;
        v.agent.bot.game = { maxHealth: 20, maxFood: 20 };
    }

    it('proposeTask is told the goal, the reason, and the state', async () => {
        const v = mkV([]);
        curriculum(v);
        let user = null;
        v._askLocal = async (_sys, u) => { user = u; return '{"reasoning":"r","task":"Look around the hut","context":""}'; };
        const state = {
            position: '0, 64, 0', biome: 'plains', time: 'day (1)',
            health_value: 20, health_max: 20, food_value: 20, food_max: 20,
            inventory_slots: '0/36', empty_inventory_slots: 36, threats: 'none',
            inventory: {}, nearby_blocks: [], equipment: eq,
            is_day: true, sleeping: false, sky_light: 15, time_since_rest: 1,
        };
        await v.proposeTask(state);
        assert.match(user, /failed_in_this_state/);
        assert.ok(user.includes(failReason), user);
        assert.ok(user.includes(stateKey), user);
        assert.ok(user.includes('eatFood'), user);
    });

    it('the same-state posterior backs the goal off, and still retries at that rate', () => {
        const v = mkV([eatSkill(SHORT)]);
        v.progress.goalFailStates = [{ task: 'eatFood', ok: false, reason: failReason, state: stateKey }];
        const state = { inventory: {}, nearby_blocks: [], is_day: true };
        Math.random = () => 0.999;
        const why = v._rejectTask('eatFood', true, state);
        assert.strictEqual(typeof why, 'string');
        assert.ok(why.includes('eatFood') && why.includes(failReason) && why.includes(stateKey), why);
        Math.random = () => 0;
        assert.strictEqual(v._rejectTask('eatFood', true, state), null);
    });

    it('a failure recorded in a different state does not back the goal off here', () => {
        const v = mkV([eatSkill(SHORT)]);
        v.progress.goalStats = { 'eatFood::replay failed': { success: 0, fail: 3 } };
        v.progress.goalFailStates = [{ task: 'eatFood', ok: false, reason: failReason, state: 'inv:bread:1;near:;is_day:true' }];
        Math.random = () => 0.999;
        assert.strictEqual(v._rejectTask('eatFood', true, { inventory: {}, nearby_blocks: [], is_day: true }), null);
    });

    it('a planner step feeds the rejection back and pursues the next proposal', async () => {
        const v = mkV([eatSkill(SHORT)]);
        v.progress.goalFailStates = [{ task: 'eatFood', ok: false, reason: failReason, state: stateKey }];
        for (const m of ['_checkHomeGround', '_watchWindows', '_watchDimension', '_oneshot', '_requeueDeferred', '_prefetchPlan']) v[m] = () => {};
        for (const m of ['_queueApiLintRepairs', '_gateTrial', '_backfillContracts', '_refactor', '_prune', '_generalise', '_split', '_retention', '_idlePractice', '_serveUrgent']) v[m] = async () => false;
        v.observe = () => ({ inventory: {}, nearby_blocks: [], equipment: eq, is_day: true });
        v._subgoalTask = () => null;
        v._takePlan = async () => ({ task: 'eatFood', reasoning: 'hungry' });
        const notes = [];
        v.proposeTask = async (st) => { notes.push(st.note); return { task: 'Look around the hut', reasoning: 'get wood', context: '' }; };
        const pursued = [];
        v._pursueProposedTask = async (task) => { pursued.push(task); };
        Math.random = () => 0.999;
        await v._step();
        assert.deepStrictEqual(pursued, ['Look around the hut']);
        assert.strictEqual(notes.length, 1);
        assert.ok(notes[0].includes('eatFood') && notes[0].includes(failReason) && notes[0].includes(stateKey), notes[0]);
    });
});
