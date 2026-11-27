/*
 * fix198 (live icefox2000, 25 Nov 2026): the bot lost its pickaxes and was entombed at y33 in solid stone
 * under the pillager camp. Its plank need back-chained to a log, whose only modeled producers were
 * "collect from a tree" (pathfinder: noPath through rock) — while the bot was literally holding
 * birch_sapling and bone_meal. minecraft-data models tree growth nowhere (it is not a recipe), so the
 * escape route its own inventory contained was invisible to the planner. The planner now carries a grow
 * edge (<p>_sapling + bone_meal -> <p>_log, minecraft.wiki/w/Sapling, minecraft.wiki/w/Bone_Meal) as an
 * OR next to collecting, and the seeded growSaplingToLog skill executes it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { obtainPlanner } from '../src/agent/recipe_plan.js';
import { parseVerboseGoal } from '../src/agent/voyager.js';

const itemDefs = ['oak_log', 'oak_sapling', 'oak_leaves', 'bone_meal', 'bone_block', 'bone', 'skeleton', 'birch_log', 'birch_sapling', 'oak_planks'];
const registry = {
    items: itemDefs.map((name, i) => ({ id: i, name })),
    itemsByName: Object.fromEntries(itemDefs.map((name, i) => [name, { id: i, name }])),
    blocksByName: {
        oak_log: { id: 0 }, oak_leaves: { id: 2 }, birch_log: { id: 7 },
    },
    blockLoot: {
        oak_leaves: { drops: [
            { item: 'oak_sapling', dropChance: 1, stackSizeRange: [1, 1] },
            { item: 'oak_log', dropChance: 1, stackSizeRange: [1, 1] },
        ] },
        birch_log: { drops: [{ item: 'birch_log', dropChance: 1, stackSizeRange: [1, 1] }] },
    },
    entityLoot: [
        { entity: 'skeleton', drops: [{ item: 'bone', dropChance: 1, stackSizeRange: [1, 1] }] },
    ],
};
const idOf = n => registry.itemsByName[n].id;
const recipesOf = id => {
    if (id === idOf('bone_meal')) return [{ result: { count: 3 }, delta: [{ id: idOf('bone_block'), count: -1 }] }];
    if (id === idOf('bone_block')) return [{ result: { count: 1 }, delta: [{ id: idOf('bone'), count: -9 }] }];
    if (id === idOf('oak_planks')) return [{ result: { count: 4 }, delta: [{ id: idOf('oak_log'), count: -1 }] }];
    return [];
};
const planner = ({ present = () => false } = {}) => obtainPlanner({
    registry,
    recipesOf,
    known: () => false,
    proven: () => false,
    edgeSuccess: () => 1,
    smeltInputs: () => [],
    present,
    mobSighted: () => true,
});

test('fix198: a log with sapling + bone meal in inventory plans as grow when no source block is present', () => {
    const pre = planner().prerequisites('oak_log', 1, { oak_sapling: 1, bone_meal: 1 });
    assert.strictEqual(pre.how, 'grow');
    assert.strictEqual(pre.task, 'Grow 1 oak_log from 1 oak_sapling');
    assert.ok(pre.ingredients.some(i => i.item === 'oak_sapling' && i.count === 1));
    assert.ok(pre.ingredients.some(i => i.item === 'bone_meal' && i.count === 1));
});

test('fix198: the entombment case end to end — planks back-chain through the grown log', () => {
    const pre = planner().prerequisites('oak_planks', 4, { oak_sapling: 1, bone_meal: 1 });
    // the log step is a grow, and the plank craft is the top task
    assert.ok(pre.plan.some(s => s === 'Grow 1 oak_log from 1 oak_sapling'), pre.plan.join(' | '));
});

test('fix198: bone meal from a held bone_block is crafted inside the grow plan; bone alone is not enough', () => {
    const p = planner();
    // no tree present: the grow route is the only feasible one, and the bone_meal craft rides inside it
    const won = p.cheapest(['oak_log'], 1, { oak_sapling: 1, bone_block: 1 }, true);
    assert.strictEqual(won.item, 'oak_log');
    assert.ok(won.plan.some(s => /Craft 1 bone_meal/.test(s)), won.plan.join(' | '));
    assert.ok(won.plan.some(s => /Grow 1 oak_log/.test(s)), won.plan.join(' | '));
    // The bone meal hunt (bone -> bone_block -> pickaxe-tool collects -> planks -> stick -> log) is
    // deliberately NOT subplanned: that chain re-enters the wood graph and memo-poisons other plans
    // (see the fix198 comment in recipe_plan.js).
    assert.throws(() => p.cheapest(['oak_log'], 1, { oak_sapling: 1, bone: 9 }, true), /not reachable|none of/i);
});

test('fix198: reachable mode — grow wins with saplings held, and nothing is reachable without them', () => {
    const p = planner();
    const won = p.cheapest(['oak_log'], 1, { oak_sapling: 1, bone_meal: 1 }, true);
    assert.strictEqual(won.item, 'oak_log');   // no tree present, but the grow route is reachable
    assert.throws(() => p.cheapest(['oak_log'], 1, {}, true), /not reachable|none of/i);
});

test('fix198: with a tree present, collecting stays an option (grow does not remove it)', () => {
    const p = planner({ present: name => name === 'oak_log' });
    const pre = p.prerequisites('oak_log', 1, {});
    assert.ok(['collect', 'grow'].includes(pre.how), pre.how);
});

test('fix198: the grow task parses as an item goal (satisfaction = logs gained)', () => {
    const g = parseVerboseGoal('Grow 2 oak_log from 2 oak_sapling');
    assert.ok(g, 'grow goal must parse');
    assert.strictEqual(g.verb, 'grow');
    assert.strictEqual(g.item, 'oak_log');
    assert.strictEqual(g.input, 'oak_sapling');
    assert.strictEqual(g.count, 2);
    assert.deepStrictEqual(g.items, ['oak_log']);
});

test('fix198: a non-growable sentence is not a grow goal', () => {
    assert.strictEqual(parseVerboseGoal('Grow 5 moss'), null);
});
