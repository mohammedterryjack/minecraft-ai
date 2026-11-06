/**
 * fix81: a missing tool / ingredient precondition is read from the game data before an item goal runs and becomes a
 * subgoal chain (progress.subgoals), each subgoal planned again the same way when it runs. Recipe cycles are reported
 * and excluded; a subgoal chain that comes back to an item it is already seeking throws. The seeded craftRecipe
 * reports missing ingredients structurally instead of "No recipe for X or missing ingredients".
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { obtainPlanner } from '../src/agent/recipe_plan.js';
import { markPreconditionUnmet, peekPreconditionUnmet } from '../src/agent/precondition.js';

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
// the world for the replay stub: what a run of each task would really do, from the same game data
function applyTask(task, inv) {
    const [verb, n, item] = task.split(' ');
    const count = Number(n);
    if (verb === 'Collect' || verb === 'Mine') {
        const b = registry.blocksByName[item];
        const src = b ? b : registry.blocksArray.find(x => Object.hasOwn(registry.blockLoot, x.name) && registry.blockLoot[x.name].drops.some(d => d.item === item && !d.silkTouch));
        if (src.harvestTools && !Object.keys(src.harvestTools).some(id => has(inv, registry.items[id].name) > 0)) return false;   // no tool: nothing drops
        inv[item] = has(inv, item) + count;
        return true;
    }
    if (verb === 'Craft') {
        for (const r of Recipe.find(registry.itemsByName[item].id)) {
            const times = Math.ceil(count / r.result.count);
            const ings = r.delta.filter(d => d.count < 0);
            if (!ings.every(d => has(inv, registry.items[d.id].name) >= -d.count * times)) continue;
            for (const d of ings) inv[registry.items[d.id].name] -= -d.count * times;
            inv[item] = has(inv, item) + times * r.result.count;
            return true;
        }
        return false;
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
    v.progress = { subgoals: [], decomposed: {}, failed: [], completed: [], blockers: [], goalStats: {} };
    v._saveProgress = () => {};
    v._windowCheck = () => {};
    v._afterSuccess = () => {};
    v._prefetchPlan = () => {};
    v._curSub = null;
    v.ran = [];
    v.observe = () => ({ inventory: { ...inv }, nearby_blocks: nearby, empty_inventory_slots: 1 });
    v._findReplay = task => ({ name: `route_${task.replace(/ /g, '_')}`, call: '' });
    v._embedReplay = async () => null;
    v._backchain = async () => null;
    v._replay = async (task) => {
        v.ran.push(task);
        if (failTasks.includes(task)) return { ok: false, name: 'r', reason: 'test: failed' };
        return applyTask(task, inv) ? { ok: true, name: 'r' } : { ok: false, name: 'r', reason: 'test world: cannot' };
    };
    v._cursorLimited = () => true;   // a failed run stops before code generation in these tests
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

describe('fix81: respawn without tools — "Mine 1 iron_ore" with wood on the surface', () => {
    it('queues the harvest tool first (not mineOre underground), with the blocker for the curriculum', async () => {
        const inv = { ...LIVE_INV };
        const v = mkV({ inv, nearby: ['grass_block', 'dirt', 'stone', 'oak_log', 'oak_leaves'] });
        await v._pursueProposedTask('Mine 1 iron_ore', { task: 'Mine 1 iron_ore' }, v.observe());
        assert.deepStrictEqual(v.ran, [], 'nothing ran: the goal needs a pickaxe first');
        const q = v.progress.subgoals;
        assert.strictEqual(q.length, 2);
        assert.match(q[0].task, /^Craft 1 (stone|iron)_pickaxe$/);
        assert.strictEqual(q[0].parent, 'Mine 1 iron_ore');
        assert.deepStrictEqual(q[0].chain, ['iron_ore']);
        assert.deepStrictEqual({ task: q[1].task, retry: q[1].retry, prereq: q[1].prereq }, { task: 'Mine 1 iron_ore', retry: true, prereq: true });
        assert.strictEqual(v.progress.blockers.length, 1);
        assert.strictEqual(v.progress.blockers[0].block, 'iron_ore');
        assert.match(v.progress.blockers[0].tool, /^(stone|iron)_pickaxe$/);
    });

    it('runs wood/logs -> planks -> sticks -> pickaxe, then the goal (each subgoal planned again when it runs)', async () => {
        const inv = { ...LIVE_INV };
        const v = mkV({ inv, nearby: ['grass_block', 'dirt', 'stone', 'oak_log', 'oak_leaves'] });
        await drive(v, 'Mine 1 iron_ore');
        assert.strictEqual(v.ran.length, 5, v.ran.join(' | '));
        assert.deepStrictEqual(v.ran.slice(0, 3), ['Collect 1 oak_log', 'Craft 2 oak_planks', 'Craft 2 stick'], 'the observed log on the surface is the raw resource');
        assert.match(v.ran[3], /^Craft 1 (stone|iron)_pickaxe$/);
        assert.strictEqual(v.ran[4], 'Mine 1 iron_ore', 'the goal runs last, with a pickaxe');
        assert.ok(has(inv, 'iron_ore') >= 1);
        assert.deepStrictEqual(v.progress.failed, []);
        assert.ok(v.progress.completed.includes('Mine 1 iron_ore'));
        assert.deepStrictEqual(v.progress.blockers, [], 'the blocker clears when the goal passes');
    });

    it('a prerequisite that fails does not loop: each retry still lacking it is a failed goal, not re-queued, not run', async () => {
        const inv = { ...LIVE_INV };
        const v = mkV({ inv, nearby: ['grass_block', 'stone', 'oak_log'], failTasks: ['Collect 1 oak_log'] });
        await drive(v, 'Mine 1 iron_ore');
        assert.deepStrictEqual(v.ran, ['Collect 1 oak_log'], 'only the raw resource ran; mineOre never went underground without a pickaxe');
        assert.ok(v.progress.failed.includes('Mine 1 iron_ore'));
        const why = Object.keys(v.progress.goalStats).find(k => k.startsWith('Mine 1 iron_ore::prerequisite still missing'));
        assert.ok(why, JSON.stringify(v.progress.goalStats));
    });

    it('a goal with its tool held runs normally (no subgoals)', async () => {
        const inv = { ...LIVE_INV, stone_pickaxe: 1 };
        const v = mkV({ inv, nearby: ['stone'] });
        await drive(v, 'Mine 1 iron_ore');
        assert.deepStrictEqual(v.ran, ['Mine 1 iron_ore']);
    });

    it('smelt goals are not planned from crafting recipes', async () => {
        const v = mkV({ inv: { raw_iron: 3, coal: 3 }, nearby: [] });
        v._replay = async (task) => { v.ran.push(task); return { ok: true, name: 'r' }; };
        await v._pursueProposedTask('Smelt 3 raw_iron into 3 iron_ingot', {}, v.observe());
        assert.deepStrictEqual(v.ran, ['Smelt 3 raw_iron into 3 iron_ingot']);
        assert.deepStrictEqual(v.progress.subgoals, []);
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
    it('_queuePrerequisites throws when a prerequisite is already sought by an ancestor', () => {
        const v = mkV({ inv: {}, nearby: ['oak_log'] });
        v._curSub = { task: 'Craft 2 stick', parent: 'Craft 2 oak_planks', depth: 2, chain: ['oak_planks'] };
        assert.throws(() => v._queuePrerequisites('Craft 2 stick', { item: 'stick', count: 2 }, v.observe()), /subgoal cycle oak_planks -> stick -> oak_planks/);
    });
    it('_tryDecomposePrerequisiteFailure throws when the missing item is the one an ancestor seeks', () => {
        const v = mkV({ inv: {}, nearby: ['oak_log'] });
        v._curSub = { task: 'Craft 2 oak_planks', parent: 'Craft 2 stick', depth: 1, chain: ['stick'] };
        v.agent.bot.__prereqFail = { item: 'stick', need: 2, have: 0 };
        assert.throws(() => v._tryDecomposePrerequisiteFailure('Craft 2 oak_planks'), /subgoal cycle stick -> oak_planks -> stick/);
    });
});

describe('fix81: structured prerequisite failure uses the game data when no learned producer exists', () => {
    it('a missing ingredient of a run becomes its Craft subgoal (was "no learned producer subgoal")', () => {
        const v = mkV({ inv: { ...LIVE_INV }, nearby: ['oak_log'] });
        v.agent.bot.__prereqFail = { item: 'stick', need: 4, have: 0 };
        assert.strictEqual(v._tryDecomposePrerequisiteFailure('Mine 1 iron_ore'), true);
        assert.deepStrictEqual(v.progress.subgoals.map(e => e.task), ['Craft 4 stick', 'Mine 1 iron_ore']);
        assert.deepStrictEqual(v.progress.subgoals[0].chain, ['iron_ore']);
    });
    it('the goal\'s own item reported missing is planned as the goal\'s prerequisites', () => {
        const v = mkV({ inv: { iron_ingot: 3 }, nearby: ['oak_log'] });
        v.agent.bot.__prereqFail = { item: 'iron_pickaxe', need: 1, have: 0 };
        assert.strictEqual(v._tryDecomposePrerequisiteFailure('Craft 1 iron_pickaxe'), true);
        assert.deepStrictEqual(v.progress.subgoals.map(e => e.task), ['Craft 2 stick', 'Craft 1 iron_pickaxe']);
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
        assert.deepStrictEqual(bot.__prereqFail, { item: 'stick', need: 4, have: 0 });
        const m = peekPreconditionUnmet(bot);
        assert.strictEqual(m.item, 'stick');
        assert.strictEqual(m.missing.length, 1);
    });
    it('iron_pickaxe with 56 ingots and no sticks: only the sticks are missing', async () => {
        const { out, bot } = await run('iron_pickaxe', { iron_ingot: 56 });
        assert.strictEqual(out[0], 'Cannot craft iron_pickaxe: missing ingredients stick (need 2, have 0).');
        assert.deepStrictEqual(peekPreconditionUnmet(bot).missing, [{ item: 'stick', need: 2, have: 0 }]);
    });
    it('an item with no recipe at all says so', async () => {
        const { out, bot } = await run('diamond_ore', {});
        assert.deepStrictEqual(out, ['No recipe for diamond_ore.']);
        assert.ok(!Object.hasOwn(bot, '__prereqFail'));
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
