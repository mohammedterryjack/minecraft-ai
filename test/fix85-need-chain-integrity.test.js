/**
 * fix85: a structured need belongs to the call frame that reported it. The game-data producer edges for oak_planks and
 * stick point forward (planks from logs, sticks from planks); the live cycle was the nested call's marker becoming the
 * parent task's need. A repair must keep the marker calls. collectBlock searches with the same predicate the reach
 * observation uses. A block whose harvestTools list is empty drops by hand. A generated reply must call its function.
 * A contract post that returns undefined, or a pre that reads c.post, is refused and the refusal is fed back.
 * A malformed game-data recipe in the slot-freeing scan throws.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { markPreconditionUnmet } from '../src/agent/precondition.js';
import { blameAll, splitGeneratedCode, entryCallFeedback, markerCallsMissing, instrumentSrc } from '../src/agent/skill_graph.js';
import { bestSlotFreeingCraft } from '../src/agent/slot_room.js';
import { obtainPlanner } from '../src/agent/recipe_plan.js';
import { getNearestBlock, getNearestBlocksWhere } from '../src/agent/library/world.js';
import { _setVersionForTest as setMcVersion } from '../src/utils/mcdata.js';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(registry);

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
    setMcVersion(VER);
});

function mkV(nearby = []) {
    const v = Object.create(Voyager.prototype);
    v.agent = { bot: { version: VER, registry, recipesAll: id => Recipe.find(id), inventory: { emptySlotCount: () => 1 } } };
    v.skills = [];
    v.progress = { subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], recipeEdges: {}, goalStats: {} };
    v._saveProgress = () => {};
    v._curSub = null;
    v._maturity = () => ({ V: 1 });
    v._boltzmann = xs => xs[0];
    v.observe = () => ({ inventory: {}, nearby_blocks: [...nearby], empty_inventory_slots: 36 });
    return v;
}

function recipeEdges(item) {
    const id = registry.itemsByName[item].id;
    return Recipe.find(id).map(r => ({
        yield: r.result.count,
        ingredients: r.delta.filter(d => d.count < 0).map(d => registry.items[d.id].name),
    }));
}
function lootSources(item) {
    return Object.entries(registry.blockLoot).filter(([, loot]) => loot.drops.some(d => d.item === item && !d.silkTouch)).map(([b]) => b);
}

describe('fix85 (C): oak_planks and stick producer edges point forward', () => {
    it('every oak_planks recipe consumes a log or wood, never a stick; every stick recipe that uses planks consumes them', () => {
        const planks = recipeEdges('oak_planks');
        const sticks = recipeEdges('stick');
        assert.ok(planks.length > 0, 'oak_planks has recipes');
        assert.ok(sticks.length > 0, 'stick has recipes');
        assert.ok(planks.every(r => r.ingredients.length > 0 && r.ingredients.every(i => i !== 'stick')), `oak_planks recipes: ${JSON.stringify(planks)}`);
        assert.ok(planks.some(r => r.ingredients.includes('oak_log')));
        assert.ok(sticks.some(r => r.ingredients.includes('oak_planks')), `stick recipes: ${JSON.stringify(sticks)}`);
        assert.ok(sticks.every(r => !r.ingredients.includes('oak_planks') || r.yield > 0));
        const both = planks.filter(r => r.ingredients.includes('stick') && r.ingredients.includes('oak_planks'));
        assert.deepStrictEqual(both, [], 'no oak_planks recipe consumes both stick and oak_planks');
        const plankLoot = lootSources('oak_planks');
        const stickLoot = lootSources('stick');
        assert.ok(plankLoot.includes('oak_planks'), `blocks that drop oak_planks: ${plankLoot.join(', ')}`);
        assert.ok(stickLoot.length > 0 && !stickLoot.includes('oak_planks'), `blocks that drop stick: ${stickLoot.join(', ')}`);
        const drops = registry.blocksByName.oak_planks.drops.map(d => registry.items[typeof d === 'number' ? d : d.drop.id].name);
        assert.ok(drops.includes('oak_planks'), `oak_planks block drops ${drops.join(', ')}`);
    });
});

describe('fix85 (C): a nested need stays on the nested frame', () => {
    it('markPreconditionUnmet writes the need onto bot.__psnFrame, and the prelude publishes that frame', () => {
        const bot = { __psnFrame: 1, __psnTrace: [{ name: 'mineBlocks', parent: -1 }, { name: 'craftRecipe', parent: 0 }] };
        markPreconditionUnmet(bot, { need: { item: 'iron_pickaxe', count: 1, reason: 'ingredients' } });
        assert.strictEqual(Object.hasOwn(bot.__psnTrace[0], 'reportedNeed'), false);
        assert.strictEqual(bot.__psnTrace[1].reportedNeed.item, 'iron_pickaxe');
        assert.match(instrumentSrc(['craftRecipe']), /bot\.__psnFrame = id/);
    });
    it('the root frame\'s reach need is the Collect oak_planks need, not the nested iron_pickaxe marker', () => {
        const v = mkV();
        const global = { kind: 'precondition', need: { item: 'iron_pickaxe', count: 1, reason: 'ingredients' } };
        const trace = [
            { name: 'collectBlock', parent: -1, depth: 0, reportedNeed: { item: 'oak_planks', count: 4, reason: 'reach' } },
            { name: 'craftRecipe', parent: 0, depth: 1, reportedNeed: { item: 'iron_pickaxe', count: 1, reason: 'ingredients' } },
        ];
        const needs = v._failureNeeds('Collect 4 oak_planks', global, trace, v.observe());
        assert.deepStrictEqual(needs.map(n => ({ item: n.item, reason: n.reason, source: n.source })), [{ item: 'oak_planks', reason: 'reach', source: 'reported by collectBlock' }]);
        assert.strictEqual(v._chainNeeds('Collect 4 oak_planks', needs, v.observe()), true);
        assert.deepStrictEqual(v.progress.subgoals.map(s => s.task), ['reach oak_planks', 'Collect 4 oak_planks']);
    });
    it('a stick need that exists only on a nested frame does not decompose Collect oak_planks into Craft 3 sticks', () => {
        const v = mkV();
        v.skills = [{ name: 'craftSticks', task: 'Craft 3 sticks', code: 'async function craftSticks(bot) { return true; }', effects: ['stick'], consumes: { oak_planks: 2 }, demoted: false }];
        const global = { kind: 'precondition', need: { item: 'stick', count: 3, reason: 'ingredients' } };
        const trace = [
            { name: 'mineBlocks', parent: -1, depth: 0 },
            { name: 'craftRecipe', parent: 0, depth: 1, reportedNeed: { item: 'stick', count: 3, reason: 'ingredients' } },
        ];
        const needs = v._failureNeeds('Collect 4 oak_planks', global, trace, v.observe());
        assert.ok(needs === null || needs.every(n => n.item !== 'stick' && n.item !== 'iron_pickaxe'), JSON.stringify(needs));
        if (needs !== null) {
            assert.strictEqual(v._chainNeeds('Collect 4 oak_planks', needs, v.observe()), true);
            assert.ok(!v.progress.subgoals.some(s => s.task === 'Craft 3 sticks'), v.progress.subgoals.map(s => s.task).join(', '));
        }
    });
    it('the same stick need, trusted as the task\'s own, decomposes into Craft 3 sticks and then cycles', () => {
        const v = mkV();
        v.skills = [{ name: 'craftSticks', task: 'Craft 3 sticks', code: 'async function craftSticks(bot) { return true; }', effects: ['stick'], consumes: { oak_planks: 2 }, demoted: false }];
        const stolen = [{ item: 'stick', count: 3, reason: 'ingredients', source: 'reported' }];
        assert.strictEqual(v._chainNeeds('Collect 4 oak_planks', stolen, v.observe()), true);
        assert.ok(v.progress.subgoals.some(s => s.task === 'Craft 3 sticks'));
        v.progress.subgoals = [];
        v._curSub = { task: 'Craft 3 sticks', chain: ['oak_planks'], depth: 1 };
        assert.throws(
            () => v._chainNeeds('Craft 3 sticks', [{ item: 'oak_planks', count: 2, reason: 'ingredients', source: 'reported' }], v.observe()),
            /\[fix81\] LOUD: subgoal cycle oak_planks -> stick -> oak_planks \(need of "Craft 3 sticks"\)/,
        );
    });
    it('a slot need on the root frame is still a slot need (fix84)', () => {
        const v = mkV();
        const trace = [{ name: 'collectBlock', parent: -1, depth: 0, reportedNeed: { item: 'oak_log', count: 1, reason: 'slot' } }];
        const needs = v._failureNeeds('Collect 1 oak_log', null, trace, v.observe());
        assert.strictEqual(needs[0].reason, 'slot');
        assert.strictEqual(v._needKey(needs[0]), 'slot');
        assert.strictEqual(needs[0].source, 'reported by collectBlock');
    });
});

describe('fix85 (A): a reported need is not repaired, and a repair must keep the marker calls', () => {
    const failed = (extra) => ({ name: 'collectBlock', parent: -1, depth: 0, ok: false, fail: true, intr: false, ret: 'false', ownFail: ['FAILED: no source within reach is a structured need'], ...extra });
    it('the frame that reported the need, and a parent that only propagated it, are not blamed', () => {
        const trace = [
            { name: 'mineBlocks', parent: -1, depth: 0, ok: false, fail: true, intr: false, ret: 'false', ownFail: [] },
            { ...failed({ parent: 0, depth: 1, reportedNeed: { item: 'oak_planks', count: 4, reason: 'reach' } }) },
        ];
        assert.deepStrictEqual(blameAll(trace, () => false, () => true), []);
    });
    it('the same FAILED line with the marker gone is blamed, and the gate names the dropped call', () => {
        assert.deepStrictEqual(blameAll([failed({})], () => false, () => true).map(b => b.target), ['collectBlock']);
        const src = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'collectBlock').code;
        const dropped = src.replace(
            /__mcPreconditionUnmet__\(bot, \{ need: sources\.length === 1 \? \{ item: sources\[0\], count: num - collected, reason: 'reach' \} : \{ anyOf: sources, count: num - collected, reason: 'reach' \} \}\);/,
            'log(bot, "FAILED: no source within reach is a structured need");',
        );
        assert.notStrictEqual(dropped, src);
        assert.match(markerCallsMissing(src, dropped, '__mcPreconditionUnmet__'), /repair dropped the __mcPreconditionUnmet__ call/);
        assert.strictEqual(markerCallsMissing(src, src, '__mcPreconditionUnmet__'), null);
        assert.match(markerCallsMissing('', 'async function f(bot) { __mcPreconditionUnmet__(bot, {}); }', '__mcPreconditionUnmet__'), /must not call it/);
    });
});

describe('fix85 (D): collectBlock\'s search and the reach observation see the same block', () => {
    it('getNearestBlock ignores a predicate; getNearestBlocksWhere applies it, and the seeded search uses that', () => {
        const oak = { name: 'oak_planks', position: { x: 2, y: 64, z: 2 } };
        const id = registry.blocksByName.oak_planks.id;
        const bot = {
            findBlocks: ({ matching }) => {
                if (typeof matching === 'function') return matching(oak) ? [oak.position] : [];
                if (Array.isArray(matching) && matching.includes(id)) return [oak.position];
                return [];
            },
            blockAt: () => oak,
        };
        const pred = b => b.name === 'oak_planks';
        // fix95: a predicate is not a block name; getNearestBlock refuses it loudly instead of matching nothing
        assert.throws(() => getNearestBlock(bot, pred, 64), /getNearestBlocksWhere for a predicate/);
        assert.strictEqual(getNearestBlocksWhere(bot, pred, 64, 1)[0].name, 'oak_planks');
        const src = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'collectBlock').code;
        assert.match(src, /if \(b\.position === null\) return true/);
        assert.match(src, /!excluded\.has\(posKey\(b\.position\)\)/);
        assert.match(src, /getNearestBlocksWhere\(bot, b =>/);
        assert.ok(!src.includes('getNearestBlock(bot, b =>'));
        assert.match(src, /drops nothing in the game data; a reach need cannot obtain it/);
        assert.match(src, /reason: 'slot'/);
        assert.match(src, /reason: 'reach'/);
    });
});

describe('fix85 (B): a block with no harvestTools drops by hand', () => {
    it('oak_log has no harvestTools, and a contract that requires a pickaxe for it is refused', () => {
        assert.strictEqual(registry.blocksByName.oak_log.harvestTools, undefined);
        const plan = obtainPlanner({ registry, recipesOf: id => Recipe.find(id), known: () => false, proven: () => false, edgeSuccess: () => 1, smeltInputs: () => [] }).prerequisites('oak_log', 1, {});
        assert.strictEqual(plan.tool, null);
        assert.deepStrictEqual(plan.steps, []);
        const v = mkV();
        const ct = { pre: "c => c.pre.alive && c.args[0] === 'oak_log' && c.pre.eq.heldItem === 'wooden_pickaxe'", post: 'c => true' };
        assert.match(v._validContract(ct), /post expects 'wooden_pickaxe' for block 'oak_log', whose harvestTools list none \(it drops by hand\)/);
        const src = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'collectBlock').code;
        assert.match(src, /failed canHarvest but the game data lists no harvestTools \(it drops by hand\)/);
    });
});

describe('fix85 (E): the generated function has to be called', () => {
    it('a definition alone has no entry call; the feedback names the function and the missing trace', () => {
        const only = 'async function collectLogs(bot) { return true; }';
        const bare = splitGeneratedCode(only, 'collectLogs');
        assert.strictEqual(bare.entry, false);
        assert.deepStrictEqual(bare.violations, []);
        const msg = entryCallFeedback('collectLogs');
        assert.match(msg, /await collectLogs\(bot\)/);
        assert.match(msg, /no execution trace/);
        const called = splitGeneratedCode(`${only}\nawait collectLogs(bot);`, 'collectLogs');
        assert.strictEqual(called.entry, true);
        assert.deepStrictEqual(called.violations, []);
        assert.ok(!called.skillSource.includes('await collectLogs'));
        const src = Voyager.prototype._pursueProposedTask.toString();
        assert.match(src, /if \(lint === null && !split\.entry\) lint = entryCallFeedback\(own\);/);
    });
});

describe('fix85: contract feedback names a non-boolean post, and a pre must not read c.post', () => {
    it('post that returns undefined is refused with that value, and the refusal is in the next learning prompt', async () => {
        const v = mkV();
        const post = { pre: 'c => true', post: "c => c.post.eq.heldItem?.endsWith('_axe')" };
        const bad = v._validContract(post);
        assert.match(bad, /post returned undefined \(undefined\), not a boolean/);
        const pre = { pre: "c => c.post.eq.heldItem === 'iron_axe'", post: 'c => true' };
        assert.match(v._validContract(pre), /pre reads c\.post\.eq\.heldItem \(state after the call\); a precondition may read c\.pre and c\.args only/);
        let user = null;
        v._ask = async (_s, u) => { user = u; throw new Error('stop'); };
        const e = { name: 'equipToolOrCraft', description: 'equip', effects: [], code: 'async function equipToolOrCraft(bot) { return; }', contractFail: bad };
        const n = await v._learnContracts([e], 'backfill');
        assert.strictEqual(n, 0);
        assert.match(user, new RegExp(`previous contract was refused: ${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    });
});

describe('fix85: a malformed game-data recipe in the freeing-crafts loop throws', () => {
    it('a recipe with no delta throws, naming the item; a recipe that frees nothing does not', () => {
        const plankId = registry.itemsByName.oak_planks.id;
        assert.throws(
            () => bestSlotFreeingCraft(registry, id => (id === plankId ? [{ delta: null }] : []), { oak_log: 4 }),
            /\[fix85\] game-data recipe for oak_planks is malformed \(recipe has no delta array\)/,
        );
        assert.throws(
            () => bestSlotFreeingCraft(registry, id => (id === plankId ? [{ delta: [1, 2], result: {} }] : []), { oak_log: 4 }),
            /\[fix85\] game-data recipe for oak_planks is malformed \(recipe result count is undefined\)/,
        );
        assert.strictEqual(bestSlotFreeingCraft(registry, () => [{ delta: [], result: { count: 1 } }], {}), null);
        assert.strictEqual(bestSlotFreeingCraft(registry, id => Recipe.find(id), { dragon_egg: 36 * registry.itemsByName.dragon_egg.stackSize }), null);
    });
});
