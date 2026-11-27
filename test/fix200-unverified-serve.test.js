/**
 * fix200 (live icefox2000, 27 Nov): the hunger serve replayed eatCookedCod, the bot ate
 * ("Ate cooked_cod. [food 19/20]"), but eatCookedCod's learned post
 * `c => (c.ret !== true) || ((pre.inv.cooked_cod) - (post.inv.cooked_cod) === 1)` is vacuous
 * when ret is falsy, so fix56's open-goal check returned unverified=true with no needs and no
 * reason string. _serveUrgentBody fell through to
 * `[fix80] need raiser serve failed without a reason` and the hunger need failed after 4 attempts.
 *
 * _replay's unverified state means "the run executed but the contract cannot verify it" — for
 * need:hunger the ground truth is vitals. fix200: food rose -> served; food flat -> recorded
 * failed with an explicit reason. Never throw "without a reason" on unverified.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { VitalsModel } from '../src/agent/vitals_model.js';

const require = createRequire(import.meta.url);
const VER = '1.21.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(registry);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BOT = 'fix200-unverified-serve';

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
});
after(() => {
    rmSync(join(ROOT, 'bots', BOT), { recursive: true, force: true });
});

function liveRegen() {
    return new VitalsModel({
        regen: {
            15: { n: 1021, up: 0 }, 16: { n: 246, up: 0 }, 17: { n: 76, up: 0 },
            18: { n: 14, up: 4 }, 19: { n: 10, up: 3 }, 20: { n: 14, up: 9 },
        },
        runs: {},
        foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
    });
}

function mkV({ vitals, food = 14 }) {
    const v = Object.create(Voyager.prototype);
    v.mobSightings = { has: () => true };
    const bot = {
        health: 18, food,
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
    v.skills = [{
        name: 'eatCookedCod', demoted: false, mergedInto: null, task: 'Eat 1 cooked_cod',
        code: 'async function eatCookedCod(bot) { await consume(bot, "cooked_cod"); }',
        effects: [], deps: [],
        stats: { success: 4, fail: 0, tasks: [] },
        contract: {
            pre: 'c => c.pre.alive && (c.pre.inv.cooked_cod || 0) >= 1',
            post: 'c => (c.ret !== true) || (((c.pre.inv.cooked_cod || 0) - (c.post.inv.cooked_cod || 0)) === 1)',
            text: 'vacuous post: cannot verify a run',
        },
    }];
    v.progress = {
        subgoals: [], decomposeQueue: null, decomposed: {}, failed: [],
        completedAt: {}, completed: [], blockers: [], goalStats: {}, recipeEdges: {},
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
    v.servedSuccess = false;
    v._afterSuccess = () => { v.servedSuccess = true; };
    const goalStates = [];
    const goalOutcomes = [];
    v._noteGoalState = (task, ok, reason) => { goalStates.push({ task, ok, reason }); };
    v._recordGoalOutcome = (task, ok, reason) => { goalOutcomes.push({ task, ok, reason }); };
    v.observe = () => ({ inventory: {}, nearby_blocks: [], position: '0,64,0', time: 'day 0', food_value: bot.food });
    v.__goalStates = goalStates;
    v.__goalOutcomes = goalOutcomes;
    return v;
}

// make the vitals model report a measured raiser so st.best is eatCookedCod
function withRaiser(m) {
    m.noteRun('eatCookedCod', { hp: 20, food: 10 }, { hp: 20, food: 16 });
    return m;
}

describe('fix200: unverified hunger serve is decided by vitals, not thrown', () => {
    it('food rose during an unverified run -> need served, no throw', async () => {
        const m = withRaiser(liveRegen());
        const v = mkV({ vitals: m, food: 14 });
        v._replay = async () => {
            v.agent.bot.food = 19;   // the run ate: food 14 -> 19
            return { ok: false, name: 'eatCookedCod', output: 'Action output:\nAte cooked_cod. [food 19/20]', cut: '', invFullFact: null, unverified: true, needs: null };
        };
        assert.strictEqual(await v._serveUrgent(), true);
        assert.strictEqual(v.servedSuccess, true);
        assert.deepStrictEqual(v.__goalOutcomes, []);
    });

    it('food flat during an unverified run -> recorded failed with a reason, no throw', async () => {
        const m = withRaiser(liveRegen());
        const v = mkV({ vitals: m, food: 14 });
        v._replay = async () => ({ ok: false, name: 'eatCookedCod', output: '', cut: '', invFullFact: null, unverified: true, needs: null });
        assert.strictEqual(await v._serveUrgent(), true);
        assert.strictEqual(v.servedSuccess, false);
        assert.strictEqual(v.__goalOutcomes.length, 1);
        assert.strictEqual(v.__goalOutcomes[0].ok, false);
        assert.match(v.__goalOutcomes[0].reason, /unverified .* food stayed at 14/);
        assert.strictEqual(v.__goalStates.length, 1);
    });

    it('a verified failure WITHOUT a reason still throws loudly (fix80 kept)', async () => {
        const m = withRaiser(liveRegen());
        const v = mkV({ vitals: m, food: 14 });
        v._replay = async () => ({ ok: false, name: 'eatCookedCod', output: '', cut: '', invFullFact: null, unverified: false, needs: null });
        await assert.rejects(() => v._serveUrgent(), /serve failed without a reason/);
    });
});
