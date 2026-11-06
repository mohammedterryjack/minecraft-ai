/**
 * fix81: ANY failure that is not a library fault says what it lacks, as structured needs { item | anyOf, count, reason }
 * (reported by the code, a violated contract's inventory reads, or the goal's game-data prerequisites). The learner
 * chains on that missing item (progress.subgoals), and each subgoal that fails is chained again the same way: no special
 * case for tools. Game-data producer edges are untried until a run proves them. Recipe cycles are reported and excluded;
 * a subgoal chain that comes back to something it is already seeking throws. The seeded craftRecipe reports missing
 * ingredients structurally instead of "No recipe for X or missing ingredients".
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { obtainPlanner } from '../src/agent/recipe_plan.js';
import { markPreconditionUnmet, peekPreconditionUnmet } from '../src/agent/precondition.js';
import { loadManifest, applyManifest } from '../scripts/reset_bug_poisoned.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(registry);

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
});

// live 11-06 17:41 replay inventory line (tossClutter / scanForIronOreBlocks): no pickaxe, no logs/planks/sticks
const LIVE_INV = { iron_helmet: 7, cobblestone: 410, iron_axe: 1, coal: 1, iron_ingot: 56, shears: 1, torch: 79, wooden_axe: 1,
    iron_sword: 1, stone_sword: 1, stone_axe: 1, cobbled_deepslate: 66, gravel: 5, granite: 34, andesite: 22, raw_iron: 114,
    diorite: 64, cooked_mutton: 46, dirt: 4, raw_copper: 31, stone_shovel: 1, furnace: 1 };

const has = (inv, k) => (Object.hasOwn(inv, k) ? inv[k] : 0);
// the world for the replay stub: what a run of each task would really do, from the same game data; a failed run reports
// what it lacks the way the seeded code does (collectBlock: the harvest tools; craftRecipe: the item it could not craft;
// tossClutter: a storage block nearby) and the learner turns it into needs (_failureNeeds)
function applyTask(task, inv, nearby) {
    if (task === 'Store spare items in a chest') {
        if (nearby.includes('chest')) return { ok: true };
        const isStore = b => /chest|barrel|shulker/.test(b.name);   // tossClutter's own predicate
        return { ok: false, reported: { kind: 'precondition', need: { anyOf: registry.blocksArray.filter(isStore).map(b => b.name), count: 1, reason: 'proximity' } } };
    }
    const ens = task.match(/^ensure ([a-z_]+)$/);
    if (ens) {
        if (has(inv, ens[1]) < 1) return { ok: false, reported: null };
        inv[ens[1]]--; nearby.push(ens[1]);
        return { ok: true };
    }
    const [verb, n, item] = task.split(' ');
    const count = Number(n);
    if (verb === 'Collect' || verb === 'Mine') {
        const b = registry.blocksByName[item];
        const src = b ? b : registry.blocksArray.find(x => Object.hasOwn(registry.blockLoot, x.name) && registry.blockLoot[x.name].drops.some(d => d.item === item && !d.silkTouch));
        if (src.harvestTools && !Object.keys(src.harvestTools).some(id => has(inv, registry.items[id].name) > 0)) {
            return { ok: false, reported: { kind: 'precondition', need: { anyOf: Object.keys(src.harvestTools).map(id => registry.items[id].name), count: 1, reason: 'tool' } } };
        }
        inv[item] = has(inv, item) + count;
        return { ok: true };
    }
    if (verb === 'Craft') {
        for (const r of Recipe.find(registry.itemsByName[item].id)) {
            const times = Math.ceil(count / r.result.count);
            const ings = r.delta.filter(d => d.count < 0);
            if (!ings.every(d => has(inv, registry.items[d.id].name) >= -d.count * times)) continue;
            for (const d of ings) inv[registry.items[d.id].name] -= -d.count * times;
            inv[item] = has(inv, item) + times * r.result.count;
            return { ok: true };
        }
        return { ok: false, reported: { kind: 'precondition', need: { item, count, reason: 'ingredients' } } };
    }
    throw new Error(`test world: unknown task ${task}`);
}

function mkV({ inv, nearby, failTasks = [] }) {
    const v = Object.create(Voyager.prototype);
    v.agent = {
        bot: { version: VER, registry, recipesAll: (id) => Recipe.find(id), inventory: { emptySlotCount: () => 1 } },
        openChat() {},
    };
    v.skills = [];
    v.npGraph = null;
    v.progress = { subgoals: [], decomposed: {}, failed: [], completed: [], blockers: [], recipeEdges: {}, goalStats: {} };   // the schema the constructor loads
    v._saveProgress = () => {};
    v._windowCheck = () => {};
    v._afterSuccess = () => {};
    v._prefetchPlan = () => {};
    v._curSub = null;
    v.ran = [];
    v.observe = () => ({ inventory: { ...inv }, nearby_blocks: [...nearby], empty_inventory_slots: 1 });
    v._findReplay = task => ({ name: `route_${task.replace(/ /g, '_')}`, call: '' });
    v._structuredReplay = v._findReplay;
    v._embedReplay = async () => null;
    v._backchain = async () => null;
    // the real _replay's contract: a failed run returns its structured needs (rp.needs from _failureNeeds)
    v._replay = async (task) => {
        v.ran.push(task);
        if (failTasks.includes(task)) return { ok: false, name: 'r', reason: 'test: failed', needs: v._failureNeeds(task, null, null, v.observe()) };
        const res = applyTask(task, inv, nearby);
        if (res.ok) return { ok: true, name: 'r' };
        return { ok: false, name: 'r', reason: 'test world: cannot', needs: v._failureNeeds(task, res.reported, null, v.observe()) };
    };
    v._cursorLimited = () => true;   // code generation is not reached: every failure here names what it lacks
    return v;
}
// what _step does with the queue: pursue the task, then each queued subgoal in order
async function drive(v, task) {
    await v._pursueProposedTask(task, { task }, v.observe());
    let guard = 0;
    while (v.progress.subgoals.length) {
        if (++guard > 100) throw new Error('test: queue did not drain');
        v._curSub = null;
        const sub = v._subgoalTask();
        await v._pursueProposedTask(sub.task, sub, v.observe());
    }
}
// the live respawn inventory without its iron ingots: stone_pickaxe is then the one cheapest tier (with ingots, iron and
// stone tie and the planner's random choice decides; covered in the planner tests)
const NO_INGOTS = Object.fromEntries(Object.entries(LIVE_INV).filter(([k]) => k !== 'iron_ingot'));
const SURFACE = ['grass_block', 'dirt', 'stone', 'oak_log', 'oak_leaves'];

describe('fix81: respawn without tools — the failure chains iron_ore -> stone_pickaxe -> stick -> oak_planks -> oak_log', () => {
    it('the failed Mine run reports the harvest tools; the learner chains on the cheapest one, with a structured blocker', async () => {
        const v = mkV({ inv: { ...NO_INGOTS }, nearby: [...SURFACE] });
        await v._pursueProposedTask('Mine 1 iron_ore', { task: 'Mine 1 iron_ore' }, v.observe());
        assert.deepStrictEqual(v.ran, ['Mine 1 iron_ore'], 'the goal ran (no pre-run special case) and failed');
        const q = v.progress.subgoals;
        assert.deepStrictEqual(q.map(e => e.task), ['Craft 1 stone_pickaxe', 'Mine 1 iron_ore']);
        assert.strictEqual(q[0].parent, 'Mine 1 iron_ore');
        assert.deepStrictEqual(q[0].chain, ['iron_ore']);
        assert.strictEqual(q[0].edge, 'stone_pickaxe', 'a game-data edge');
        assert.deepStrictEqual({ retry: q[1].retry, prereq: q[1].prereq }, { retry: true, prereq: true });
        assert.deepStrictEqual(v.progress.blockers.map(({ at, ...b }) => b), [{ item: 'stone_pickaxe', count: 1, reason: 'tool', task: 'Mine 1 iron_ore' }]);
        assert.deepStrictEqual(v.progress.recipeEdges, { stone_pickaxe: { task: 'Craft 1 stone_pickaxe', status: 'untried', runs: 0, fails: 0 } });
    });

    it('drives the whole chain: each failing subgoal is chained on what IT lacks, then everything retries in order', async () => {
        const inv = { ...NO_INGOTS };
        const v = mkV({ inv, nearby: [...SURFACE] });
        await drive(v, 'Mine 1 iron_ore');
        assert.deepStrictEqual(v.ran, [
            'Mine 1 iron_ore',            // fails: tool (stone_pickaxe | iron_pickaxe | ...)
            'Craft 1 stone_pickaxe',      // fails: ingredients -> game data: 2 stick
            'Craft 2 stick',              // fails: ingredients -> 2 oak_planks (the oak log is the one observed)
            'Craft 2 oak_planks',         // fails: ingredients -> 1 oak_log
            'Collect 1 oak_log',          // hand-harvestable: passes
            'Craft 2 oak_planks', 'Craft 2 stick', 'Craft 1 stone_pickaxe', 'Mine 1 iron_ore',
        ]);
        const chains = Object.fromEntries(Object.entries(v.progress.decomposed).map(([k, d]) => [k, d.subs]));
        assert.deepStrictEqual(chains, {
            'Mine 1 iron_ore': ['Craft 1 stone_pickaxe'], 'Craft 1 stone_pickaxe': ['Craft 2 stick'],
            'Craft 2 stick': ['Craft 2 oak_planks'], 'Craft 2 oak_planks': ['Collect 1 oak_log'],
        });
        assert.ok(has(inv, 'iron_ore') >= 1 && has(inv, 'stone_pickaxe') === 1);
        assert.ok(v.progress.completed.includes('Mine 1 iron_ore'));
        assert.deepStrictEqual(v.progress.failed, []);
        assert.deepStrictEqual(v.progress.blockers, [], 'each blocker clears when its goal passes');
        for (const e of ['stone_pickaxe', 'stick', 'oak_planks', 'oak_log']) assert.strictEqual(v.progress.recipeEdges[e].status, 'proven', `${e}: ${JSON.stringify(v.progress.recipeEdges[e])}`);
    });

    it('a prerequisite that fails does not loop: each retry still lacking it is a failed goal, not re-queued', async () => {
        const inv = { ...NO_INGOTS };
        const v = mkV({ inv, nearby: [...SURFACE], failTasks: ['Collect 1 oak_log'] });
        await drive(v, 'Mine 1 iron_ore');
        assert.deepStrictEqual(v.ran, ['Mine 1 iron_ore', 'Craft 1 stone_pickaxe', 'Craft 2 stick', 'Craft 2 oak_planks', 'Collect 1 oak_log',
            'Craft 2 oak_planks', 'Craft 2 stick', 'Craft 1 stone_pickaxe', 'Mine 1 iron_ore'], 'each retry runs once and stops');
        assert.ok(v.progress.failed.includes('Mine 1 iron_ore'));
        assert.ok(Object.keys(v.progress.goalStats).some(k => k.startsWith('Mine 1 iron_ore::prerequisite still missing: 1 stone_pickaxe (tool')), JSON.stringify(v.progress.goalStats));
        assert.strictEqual(v.progress.recipeEdges.oak_log.status, 'untried');
        assert.strictEqual(v.progress.recipeEdges.oak_log.fails, 1);
    });

    it('a goal with its tool held runs normally (no subgoals)', async () => {
        const inv = { ...LIVE_INV, stone_pickaxe: 1 };
        const v = mkV({ inv, nearby: ['stone'] });
        await drive(v, 'Mine 1 iron_ore');
        assert.deepStrictEqual(v.ran, ['Mine 1 iron_ore']);
        assert.deepStrictEqual(v.progress.subgoals, []);
    });
});

describe('fix81: a non-tool failure chains the same way (no chest nearby)', () => {
    it('"needs a chest within 32 blocks" -> ensure chest -> craft chest -> planks -> logs, then the goal passes', async () => {
        const inv = { cobblestone: 410, raw_iron: 114 };
        const nearby = ['grass_block', 'oak_log'];
        const v = mkV({ inv, nearby });
        await drive(v, 'Store spare items in a chest');
        assert.deepStrictEqual(v.ran, [
            'Store spare items in a chest',   // fails: proximity, anyOf every storage block in the registry -> chest is the cheapest
            'ensure chest',                    // fails: no chest to place -> 1 chest (place)
            'Craft 1 chest',                   // fails: ingredients -> 8 oak_planks
            'Craft 8 oak_planks',              // fails: ingredients -> 2 oak_log
            'Collect 2 oak_log',
            'Craft 8 oak_planks', 'Craft 1 chest', 'ensure chest', 'Store spare items in a chest',
        ]);
        assert.ok(nearby.includes('chest'));
        assert.ok(v.progress.completed.includes('Store spare items in a chest'));
        assert.deepStrictEqual(v.progress.decomposed['Store spare items in a chest'].reason, 'needs: 1 chest (proximity, reported)');
        assert.deepStrictEqual(v.progress.decomposed['ensure chest'].reason, 'needs: 1 chest (place, game data)');
    });
});

describe('fix81: a violated pre-contract names the item it lacks', () => {
    it('the inventory keys the contract read that the bot has none of become anyOf; the cheapest is chained', () => {
        const v = mkV({ inv: { ...NO_INGOTS }, nearby: [...SURFACE] });
        v._getContractEndowments = () => ({});
        const e = { name: 'equipBestPickaxeForMining', contract: { pre: '(c) => ["iron_pickaxe", "stone_pickaxe", "wooden_pickaxe"].some(t => (c.pre.inv[t] || 0) > 0)' } };
        const c = { pre: { inv: { ...NO_INGOTS } } }, r = { name: e.name, preFail: true };
        v._contractNeed(e, c, r);
        assert.deepStrictEqual(r.need, { anyOf: ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'], count: 1, reason: 'contract' });
        const needs = v._failureNeeds('equip best pickaxe', null, [r], v.observe());
        assert.deepStrictEqual(needs, [{ anyOf: ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'], count: 1, reason: 'contract', source: 'contract of equipBestPickaxeForMining' }]);
        assert.strictEqual(v._chainNeeds('equip best pickaxe', needs, v.observe()), true);
        assert.deepStrictEqual(v.progress.subgoals.map(q => q.task), ['Craft 1 stone_pickaxe', 'equip best pickaxe']);
    });
    it('reads of keys the bot holds, or of non-items, name nothing', () => {
        const v = mkV({ inv: {}, nearby: [] });
        v._getContractEndowments = () => ({});
        const r = { name: 'x', preFail: true };
        v._contractNeed({ name: 'x', contract: { pre: '(c) => c.pre.inv.cobblestone > 500 && c.pre.inv.notAnItem === 1' } }, { pre: { inv: { cobblestone: 410 } } }, r);
        assert.ok(!Object.hasOwn(r, 'need'));
    });
});

describe('fix81: structured needs are validated and reach the curriculum', () => {
    it('a need must name an item or anyOf, an integer count and a reason kind', () => {
        assert.throws(() => markPreconditionUnmet({}), /need: \{ item \| anyOf, count, reason \} \} required/);
        assert.throws(() => markPreconditionUnmet({}, { need: { item: 'chest', count: 1 } }), /no reason kind/);
        assert.throws(() => markPreconditionUnmet({}, { need: { item: 'chest', reason: 'proximity' } }), /no integer count/);
        assert.throws(() => markPreconditionUnmet({}, { need: { item: 'chest', anyOf: ['barrel'], count: 1, reason: 'proximity' } }), /exactly one of item \/ anyOf/);
    });
    it('progress.blockers become the BLOCKERS line of the curriculum prompt, and clear once the item is held', () => {
        const v = mkV({ inv: {}, nearby: [] });
        v.progress.blockers = [{ item: 'stone_pickaxe', count: 1, reason: 'tool', task: 'Mine 1 iron_ore', at: 1 }, { item: 'chest', count: 1, reason: 'proximity', task: 'Store spare items in a chest', at: 2 }];
        assert.strictEqual(v._blockerHint({}), '\nBLOCKERS (prioritize these - what failed goals lack): "Mine 1 iron_ore" needs 1 stone_pickaxe (tool); "Store spare items in a chest" needs 1 chest (proximity)');
        assert.strictEqual(v._blockerHint({ stone_pickaxe: 1 }), '\nBLOCKERS (prioritize these - what failed goals lack): "Store spare items in a chest" needs 1 chest (proximity)');
        const src = Voyager.prototype.proposeTask.toString();
        assert.ok(src.includes('this._blockerHint(inv)') && src.includes('blockerHint'), 'proposeTask builds the prompt hint from the blockers');
    });
});

describe('fix81: obtainPlanner (game data only)', () => {
    const planner = (nearby, learned = () => false) => obtainPlanner({
        registry, recipesOf: id => Recipe.find(id),
        known: (item, src) => src.some(b => nearby.includes(b)) || learned(item), choose: t => t[0],
    });
    it('cheapest harvest tool for stone from nothing is the wooden pickaxe (fix47 case, structural)', () => {
        const pre = planner(['oak_log']).prerequisites('stone', 3, {});
        assert.strictEqual(pre.tool, 'wooden_pickaxe');
        assert.deepStrictEqual(pre.steps.map(s => s.task), ['Craft 1 wooden_pickaxe']);
        assert.strictEqual(pre.plan[pre.plan.length - 1], 'Collect 3 stone');
    });
    it('a held tool or a hand-harvestable source needs no prerequisite', () => {
        assert.deepStrictEqual(planner([]).prerequisites('stone', 1, { wooden_pickaxe: 1 }).steps, []);
        assert.deepStrictEqual(planner(['oak_log']).prerequisites('oak_log', 1, {}).steps, []);
    });
    it('the observed source decides between equal recipe variants (oak planks from the oak log seen nearby)', () => {
        const pre = planner(['birch_log']).prerequisites('stick', 4, {});
        assert.deepStrictEqual(pre.steps.map(s => s.task), ['Craft 2 birch_planks']);
    });
    it('a learned producer makes a raw resource known (iron_ingot by smelting, not from a block nobody has seen)', () => {
        const pre = planner([], item => item === 'iron_ingot').prerequisites('iron_ingot', 3, {});
        assert.strictEqual(pre.task, 'Obtain 3 iron_ingot');
        assert.deepStrictEqual(pre.steps, []);
    });
    it('recipe cycles in the game data are reported and excluded (iron_ingot -> iron_block -> iron_ingot)', () => {
        const pre = planner([]).prerequisites('iron_ingot', 3, { iron_ingot: 56 });
        assert.ok(pre.cycles.includes('iron_ingot -> iron_block -> iron_ingot'), pre.cycles.join('; '));
        assert.ok(!pre.plan.includes('Craft 1 iron_block'), `9 ingots -> block -> 9 ingots makes nothing: ${pre.plan.join(' -> ')}`);
    });
    it('an ingredient whose every recipe cycles back and that no block yields is obtained by the normal path (cycle reported)', () => {
        const reg = {
            items: { 1: { id: 1, name: 'a_item' }, 2: { id: 2, name: 'b_item' } },
            itemsByName: { a_item: { id: 1, name: 'a_item' }, b_item: { id: 2, name: 'b_item' } },
            blocksByName: {}, blockLoot: {},
        };
        const rec = { 1: [{ result: { count: 1 }, delta: [{ id: 2, count: -1 }, { id: 1, count: 1 }] }], 2: [{ result: { count: 1 }, delta: [{ id: 1, count: -1 }, { id: 2, count: 1 }] }] };
        const pre = obtainPlanner({ registry: reg, recipesOf: id => rec[id], known: () => false, choose: t => t[0] }).prerequisites('a_item', 1, {});
        assert.deepStrictEqual(pre.cycles, ['a_item -> b_item -> a_item']);
        assert.strictEqual(pre.task, 'Craft 1 a_item');
        assert.deepStrictEqual(pre.steps.map(st => st.task), ['Obtain 1 b_item']);
    });
    it('throws, naming the cycle, when the data gives no acyclic way at all (a block only its own drop can harvest)', () => {
        const reg = {
            items: { 1: { id: 1, name: 'x_item' } },
            itemsByName: { x_item: { id: 1, name: 'x_item' } },
            blocksByName: { x_item: { name: 'x_item', harvestTools: { 1: true } } },
            blockLoot: { x_item: { drops: [{ item: 'x_item' }] } },
        };
        const p = obtainPlanner({ registry: reg, recipesOf: () => [], known: () => false, choose: t => t[0] });
        assert.throws(() => p.prerequisites('x_item', 1, {}), /no acyclic way to obtain 1 x_item .*cycles: x_item -> x_item.*unobtainable: x_item from x_item/);
    });
});

describe('fix81: subgoal chain cycles fail loud', () => {
    it('a need that an ancestor is already seeking throws', () => {
        const v = mkV({ inv: {}, nearby: ['oak_log'] });
        v._curSub = { task: 'Craft 2 stick', parent: 'Craft 2 oak_planks', depth: 2, chain: ['oak_planks'] };
        assert.throws(() => v._chainNeeds('Craft 2 stick', [{ item: 'oak_planks', count: 2, reason: 'ingredients', source: 'reported' }], v.observe()), /subgoal cycle oak_planks -> stick -> oak_planks/);
    });
    it('the goal\'s own item reported missing chains its game-data prerequisites, and those are cycle-checked too', () => {
        const v = mkV({ inv: {}, nearby: ['oak_log'] });
        v._curSub = { task: 'Craft 2 oak_planks', parent: 'Craft 2 stick', depth: 1, chain: ['oak_log'] };
        assert.throws(() => v._chainNeeds('Craft 2 oak_planks', [{ item: 'oak_planks', count: 2, reason: 'ingredients', source: 'reported' }], v.observe()), /subgoal cycle oak_log -> oak_planks -> oak_log/);
    });
    it('placing a block is not a cycle with having it (ensure chest -> craft chest)', () => {
        const v = mkV({ inv: {}, nearby: ['oak_log'] });
        v._curSub = { task: 'ensure chest', parent: 'Store', depth: 1, chain: [] };
        assert.strictEqual(v._chainNeeds('ensure chest', [{ item: 'chest', count: 1, reason: 'place', source: 'game data' }], v.observe()), true);
        assert.deepStrictEqual(v.progress.subgoals[0].chain, ['placed chest']);
    });
});

describe('fix81: _backchain chains on the missing item, not only the goal item', () => {
    it('a single named need is planned through the learned graph, produced, and the goal route retried', async () => {
        const v = mkV({ inv: {}, nearby: [] });
        delete v._backchain;
        const asked = [];
        v._chain = (item, want, inv, depth, plan) => { asked.push([item, want]); plan.push({ name: 'craftSticks', item: 'stick' }); return true; };
        const runs = [];
        v._replay = async (task, before, r) => { runs.push(`${task} via ${r.name}`); return { ok: true, name: r.name }; };
        const rp = await v._backchain('Craft 1 stone_pickaxe', { inventory: { stick: 1 } }, [{ item: 'stick', count: 2, reason: 'ingredients', source: 'reported' }]);
        assert.deepStrictEqual(asked, [['stick', 3]]);
        assert.deepStrictEqual(runs, ['obtain 1 stick via craftSticks', 'Craft 1 stone_pickaxe via route_Craft_1_stone_pickaxe']);
        assert.strictEqual(rp.ok, true);
    });
    it('without a learned plan for the missing item it leaves the need to the subgoal chain (null)', async () => {
        const v = mkV({ inv: {}, nearby: [] });
        delete v._backchain;
        v._chain = () => false;
        assert.strictEqual(await v._backchain('Craft 1 stone_pickaxe', { inventory: {} }, [{ item: 'stick', count: 2, reason: 'ingredients', source: 'reported' }]), null);
    });
});

describe('fix81: a reported need uses the game data when no learned producer exists', () => {
    it('a missing ingredient of a run becomes its Craft subgoal (was "no learned producer subgoal")', () => {
        const v = mkV({ inv: { ...LIVE_INV }, nearby: ['oak_log'] });
        assert.strictEqual(v._chainNeeds('Mine 1 iron_ore', [{ item: 'stick', count: 4, reason: 'ingredients', source: 'reported' }], v.observe()), true);
        assert.deepStrictEqual(v.progress.subgoals.map(e => e.task), ['Craft 4 stick', 'Mine 1 iron_ore']);
        assert.deepStrictEqual(v.progress.subgoals[0].chain, ['iron_ore']);
    });
    it('a learned producer is preferred and its edge is not a game-data edge', () => {
        const v = mkV({ inv: {}, nearby: ['oak_log'] });
        v._subgoalToObtainItem = (item) => (item === 'stick' ? 'craftSticks' : null);
        v._chainNeeds('Craft 1 stone_pickaxe', [{ item: 'stick', count: 2, reason: 'ingredients', source: 'reported' }], v.observe());
        assert.deepStrictEqual(v.progress.subgoals.map(e => [e.task, e.edge === undefined ? 'retry' : e.edge]), [['craftSticks', null], ['Craft 1 stone_pickaxe', 'retry']]);
        assert.strictEqual(v.progress.recipeEdges.stick, undefined);
    });
    it('an open goal whose run reported nothing has no needs (the model decomposes it)', () => {
        const v = mkV({ inv: {}, nearby: [] });
        assert.strictEqual(v._failureNeeds('explore the cave', null, [], v.observe()), null);
    });
});

describe('fix81: seeded craftRecipe reports missing ingredients, not "No recipe"', () => {
    const seeded = () => Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'craftRecipe').code;
    function run(itemName, inv, num = 1) {
        const out = [];
        const bot = { registry, recipesFor: () => [], recipesAll: (id) => Recipe.find(id) };
        const fn = new Function('log', 'getInventoryCounts', '__mcPreconditionUnmet__', 'getNearestBlock', 'ensureCraftingTable', 'collectBlock', 'goToReachBlock',
            `${seeded()}\nreturn craftRecipe;`)((b, m) => out.push(m), () => ({ ...inv }), markPreconditionUnmet,
            () => { throw new Error('not reached'); }, () => { throw new Error('not reached'); }, () => { throw new Error('not reached'); }, () => { throw new Error('not reached'); });
        return fn(bot, itemName, num).then(ok => ({ ok, out, bot }));
    }
    it('stick with no planks: the missing ingredients, structured', async () => {
        const { ok, out, bot } = await run('stick', {});
        assert.strictEqual(ok, false);
        assert.strictEqual(out.length, 1);
        assert.match(out[0], /^Cannot craft stick: missing ingredients [a-z_]+ \(need 2, have 0\)\.$/);
        assert.ok(!out[0].includes('No recipe'));
        const m = peekPreconditionUnmet(bot);
        assert.deepStrictEqual(m.need, { item: 'stick', count: 4, reason: 'ingredients' });
        assert.strictEqual(m.missing.length, 1);
        assert.ok(!Object.hasOwn(bot, '__prereqFail'), 'the marker is the one structured channel');
    });
    it('iron_pickaxe with 56 ingots and no sticks: only the sticks are missing', async () => {
        const { out, bot } = await run('iron_pickaxe', { iron_ingot: 56 });
        assert.strictEqual(out[0], 'Cannot craft iron_pickaxe: missing ingredients stick (need 2, have 0).');
        assert.deepStrictEqual(peekPreconditionUnmet(bot).missing, [{ item: 'stick', need: 2, have: 0 }]);
    });
    it('an item with no recipe at all says so', async () => {
        const { out, bot } = await run('diamond_ore', {});
        assert.deepStrictEqual(out, ['No recipe for diamond_ore.']);
        assert.strictEqual(peekPreconditionUnmet(bot), null);
    });
});

describe('fix81: a candidate under trial is staged with its own deps (live 17:56:15Z checkForIronPickaxe)', () => {
    it('the replay closure includes the helper the repaired candidate calls, not only the incumbent deps', () => {
        const v = Object.create(Voyager.prototype);
        v.skills = [
            { name: 'craftIronPickaxe', deps: ['craftRecipe'], code: 'async function craftIronPickaxe(bot) { await craftRecipe(bot, "iron_pickaxe"); }',
              candidate: { deps: ['checkForIronPickaxe', 'craftRecipe'], code: 'async function craftIronPickaxe(bot) { if (!(await checkForIronPickaxe(bot))) await craftRecipe(bot, "iron_pickaxe"); }' } },
            { name: 'checkForIronPickaxe', deps: [], code: 'async function checkForIronPickaxe(bot) { return false; }' },
            { name: 'craftRecipe', deps: [], code: 'async function craftRecipe(bot) {}' },
        ];
        const { closure, over } = v._trialClosure('craftIronPickaxe', true);
        assert.deepStrictEqual([...closure].sort(), ['checkForIronPickaxe', 'craftIronPickaxe', 'craftRecipe']);
        assert.deepStrictEqual(Object.keys(over), ['craftIronPickaxe']);
        assert.ok(!v._closure('craftIronPickaxe').has('checkForIronPickaxe'), 'the incumbent graph alone misses it (the bug)');
        const incumbent = v._trialClosure('craftIronPickaxe', false);
        assert.deepStrictEqual([...incumbent.closure].sort(), ['craftIronPickaxe', 'craftRecipe'], 'not under trial: the incumbent deps');
    });
});

describe('fix81: ensureFurnace fake effects are reset by a manifest record (applied after deploy), not by code', () => {
    const MAN = 'scripts/fix81_ensureFurnace_manifest.json';
    it('the manifest is valid and expects exactly the live poisoned effects', () => {
        const m = loadManifest(MAN);
        assert.deepStrictEqual(m.records.map(r => [r.skill, r.expect, r.set]), [['ensureFurnace', { effects: ['oak_log', 'oak_planks', 'gravel'] }, { effects: [] }]]);
    });
    it('dry run reports the change; --apply writes it (and refuses once the record no longer matches)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix81-man-'));
        try {
            mkdirSync(join(dir, 'skills'));
            const idx = [{ name: 'ensureFurnace', effects: ['oak_log', 'oak_planks', 'gravel'], consumes: { oak_planks: 4, cobblestone: 9 } }];
            writeFileSync(join(dir, 'skills/index.json'), JSON.stringify(idx));
            writeFileSync(join(dir, 'skills/progress.json'), JSON.stringify({}));
            const manifest = loadManifest(MAN), quiet = () => {};
            applyManifest({ manifest, botsDir: dir, apply: false, log: quiet });
            assert.deepStrictEqual(JSON.parse(readFileSync(join(dir, 'skills/index.json'), 'utf8')), idx, 'dry run writes nothing');
            applyManifest({ manifest, botsDir: dir, apply: true, log: quiet });
            assert.deepStrictEqual(JSON.parse(readFileSync(join(dir, 'skills/index.json'), 'utf8'))[0].effects, []);
            assert.throws(() => applyManifest({ manifest, botsDir: dir, apply: true, log: quiet }));
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
