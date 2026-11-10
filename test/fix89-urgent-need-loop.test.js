/**
 * fix89 (live icefox2000, 08:16 GMT 7 Nov, 902c954): hunger serve replayed eatCookedMutton
 * every step (~2459). The child logged FAILED for a missing input and returned false; the
 * raiser returned undefined. The contract scored that as "call succeeded", so no structured
 * need was extracted, the replay result carried needs:null and no reason, and _serveUrgentBody
 * threw. The next step served hunger again. Nothing else ran.
 *
 * The missing input here is whichever craftable item the registry lists first (not a food
 * special case). The raiser is a learned food-raiser only because its measured runs say so.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { VitalsModel } from '../src/agent/vitals_model.js';
import { annotateTrace } from '../src/agent/skill_graph.js';

const require = createRequire(import.meta.url);
const VER = '1.21.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(registry);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BOT = 'fix89-urgent-need';

function missingInputFromRegistry() {
    for (const it of registry.itemsArray) {
        if (typeof it.name !== 'string' || it.name.length === 0) continue;
        if (it.id === 0) continue;
        if (Recipe.find(it.id).length === 0) continue;
        return it.name;
    }
    throw new Error('[fix89 test] registry has no craftable item to use as a missing input');
}
const ITEM = missingInputFromRegistry();

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
});
after(() => {
    rmSync(join(ROOT, 'bots', BOT), { recursive: true, force: true });
});

function liveRegen(runs = {}) {
    return new VitalsModel({
        regen: {
            15: { n: 1021, up: 0 }, 16: { n: 246, up: 0 }, 17: { n: 76, up: 0 },
            18: { n: 14, up: 4 }, 19: { n: 10, up: 3 }, 20: { n: 14, up: 9 },
        },
        runs,
        foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
    });
}

function state() {
    return {
        pos: { x: 0, y: 64, z: 0 }, hp: 18, food: 17, oxygen: 20, sky: 15, alive: true, dim: 'overworld',
        inv: {}, free: 10,
        eq: { heldItem: null, offHand: null, helmet: null, chestplate: null, leggings: null, boots: null },
    };
}

// Parent returns undefined (not an explicit success). Child returns false and logs FAILED for the missing input.
function childFailTrace() {
    const output = `FAILED: ${ITEM} missing or count is 0\n`;
    const s = state();
    const parent = {
        name: 'raiseVital', parent: -1, depth: 0, argv: [], rv: undefined, ret: 'undefined', fail: false,
        s0: s, s1: s, delta: {}, intr: false, o0: 0, o1: output.length,
    };
    const child = {
        name: 'checkInput', parent: 0, depth: 1, argv: [], rv: false, ret: 'false', fail: true,
        s0: s, s1: s, delta: {}, intr: false, o0: 0, o1: output.length,
    };
    const trace = [parent, child];
    annotateTrace(trace, output);
    return { output, trace };
}

function mkV({ vitals, food = 17, health = 18, skillsList }) {
    const v = Object.create(Voyager.prototype);
    const bot = {
        health, food,
        game: { maxHealth: 20, maxFood: 20 },
        interrupt_code: false,
        inventory: { emptySlotCount: () => 10 },
        entity: { position: { x: 0, y: 64, z: 0 } },
        version: VER,
        registry,
        recipesAll: (id) => Recipe.find(id),
        currentWindow: null,
    };
    v.agent = {
        name: BOT,
        bot,
        actions: { executing: false },
        openChat() {},
        fatal(msg) { throw new Error('FATAL: ' + msg); },
    };
    v.vitals = vitals;
    v.npGraph = null;
    v.skills = skillsList !== undefined ? skillsList : [{
        name: 'raiseVital', demoted: false, mergedInto: null, task: 'Raise a vital',
        code: 'async function raiseVital(bot) { return; }',
        effects: [], deps: [],
        stats: { success: 4, fail: 0, tasks: [] },
        contract: {
            pre: `c => c.pre.alive && (c.pre.inv['${ITEM}'] ?? 0) > 0`,
            post: 'c => c.post.alive',
            text: 'needs the input the contract reads',
        },
    }];
    v.progress = {
        subgoals: [{ task: 'Mine 1 iron_ore', parent: 'Craft 1 iron_pickaxe', depth: 1 }],
        decomposeQueue: null,
        decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], goalStats: {}, recipeEdges: {},
    };
    Object.defineProperty(v, '_decomposeQueue', {
        get() { return this.progress.decomposeQueue; },
        set(q) { this.progress.decomposeQueue = q; },
    });
    v._saveProgress = () => {};
    v._saveSkills = () => {};
    v._curSub = null;
    v.currentTask = null;
    v._repairQueue = [];
    v._afterSuccess = () => {};
    v.proposeTask = async () => { throw new Error('proposeTask should not run when a measured raiser exists or was learned out'); };
    v.observe = () => ({ inventory: {}, nearby_blocks: [], position: '0,64,0', time: 'day 0', food_value: food, is_day: true });
    return v;
}

function replayChildFailure(v) {
    const calls = [];
    v._replay = async (task) => {
        calls.push(task);
        const { output, trace } = childFailTrace();
        v._checkContracts(trace, false);
        const needs = v._failureNeeds(task, null, trace, v.observe());
        const reason = v._failureReason(trace);
        const out = { ok: false, name: 'raiseVital', output, cut: '', invFullFact: null, unverified: true, needs };
        if (typeof reason === 'string') return { ...out, reason };
        return out;
    };
    return calls;
}

describe('fix89: a measured +0.0 food/run is not a raiser', () => {
    it('published effect +0.0 is learned out of foodRaisers and does not consume the step', async () => {
        const m = liveRegen({ raiseVital: { n: 40, food: 1, hp: 0 } });
        assert.strictEqual(VitalsModel.reportedFoodPerRun(1 / 40), '0.0');
        assert.strictEqual(m.foodRaisers().length, 0);
        const v = mkV({ vitals: m });
        let replayed = false;
        v._replay = async () => { replayed = true; return { ok: true, name: 'raiseVital' }; };
        assert.strictEqual(await v._serveUrgent(), false);
        assert.strictEqual(replayed, false);
        assert.strictEqual(v.progress.subgoals[0].task, 'Mine 1 iron_ore');
    });

    it('a published positive effect is still a raiser', () => {
        const m = liveRegen();
        m.noteRun('raiseVital', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        assert.ok(VitalsModel.raisesFood(6));
        assert.deepStrictEqual(m.foodRaisers().map(x => x.name), ['raiseVital']);
    });
});

describe('fix89: missing input on a raiser serve backchains instead of looping', () => {
    it('undefined return with a violated pre is a structured need, not "call succeeded"', () => {
        const m = liveRegen();
        m.noteRun('raiseVital', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const v = mkV({ vitals: m });
        const { trace } = childFailTrace();
        v._checkContracts(trace, false);
        const queued = v._repairQueue.filter(q => typeof q.evidence === 'string' && q.evidence.includes('call succeeded'));
        assert.deepStrictEqual(queued, []);
        assert.strictEqual(trace[0].preFail, true);
        assert.ok(Array.isArray(trace[0].need.anyOf) && trace[0].need.anyOf.includes(ITEM));
        const needs = v._failureNeeds('need:hunger', null, trace, v.observe());
        assert.ok(Array.isArray(needs) && needs.length === 1);
        assert.ok(needs[0].anyOf.includes(ITEM));
        assert.strictEqual(needs[0].reason, 'contract');
    });

    it('an explicit success return with a violated pre is still a wrong precondition', () => {
        const m = liveRegen();
        const v = mkV({ vitals: m });
        const s = state();
        const rec = {
            name: 'raiseVital', parent: -1, depth: 0, argv: [], rv: true, ret: 'true', fail: false,
            s0: s, s1: s, delta: {}, intr: false,
        };
        v._checkContracts([rec], false);
        assert.ok(v._repairQueue.some(q => q.evidence.includes('call succeeded')));
        assert.ok(!Object.hasOwn(rec, 'preFail'));
    });

    it('the FAILED line on the child frame is the failure reason', () => {
        const m = liveRegen();
        const v = mkV({ vitals: m });
        const { trace } = childFailTrace();
        const reason = v._failureReason(trace);
        assert.strictEqual(typeof reason, 'string');
        assert.ok(reason.includes('FAILED'));
        assert.ok(reason.includes(ITEM));
        assert.ok(reason.startsWith('checkInput:'));
    });

    it('one failed serve chains the missing input; the next step does not replay the raiser', async () => {
        const m = liveRegen();
        m.noteRun('raiseVital', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const v = mkV({ vitals: m, food: 17, health: 18 });
        const calls = replayChildFailure(v);
        const before = v.progress.subgoals.map(s => s.task);
        assert.strictEqual(await v._serveUrgent(), true);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0], 'need:hunger');
        const added = v.progress.subgoals.map(s => s.task).filter(t => !before.includes(t));
        assert.ok(added.some(t => t.includes(ITEM)), `subgoals ${JSON.stringify(v.progress.subgoals.map(s => s.task))}`);
        assert.ok(v.progress.blockers.some(b => Array.isArray(b.anyOf) && b.anyOf.includes(ITEM)), JSON.stringify(v.progress.blockers));
        assert.strictEqual(await v._serveUrgent(), false);
        assert.strictEqual(calls.length, 1, 'the raiser is not replayed while its backchain is queued');
        assert.strictEqual(v.currentTask, null);
    });

    it('a failed serve with a reason and no need is a learned outcome of the need', async () => {
        const m = liveRegen();
        m.noteRun('raiseVital', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const v = mkV({ vitals: m });
        v._replay = async () => ({ ok: false, name: 'raiseVital', reason: 'post did not hold', needs: null });
        assert.strictEqual(await v._serveUrgent(), true);
        const o = v._goalOutcomes('need:hunger');
        assert.strictEqual(o.f, 1);
        assert.strictEqual(o.s, 0);
        assert.ok(v._goalBackoffMultiplier('need:hunger') < 1);
    });
});

describe('fix89: wiring', () => {
    it('replay copies the trace failure reason, and a violated pre with ret undefined is not success', () => {
        const src = readFileSync(join(ROOT, 'src/agent/voyager.js'), 'utf8');
        assert.ok(src.includes('this._failureReason(failTrace)'));
        assert.ok(src.includes('r.rv !== undefined && r.rv !== false && r.rv !== null'));
        const un = readFileSync(join(ROOT, 'src/agent/vitals_model.js'), 'utf8');
        assert.ok(un.includes('raisesFood'));
    });
});
