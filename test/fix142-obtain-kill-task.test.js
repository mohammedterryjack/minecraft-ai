/*
 * fix142 (live icefox2000, 18 Nov 2026): hunger backchain queued "Obtain 1 chicken" / "Obtain 1 pufferfish";
 * the generic obtainItem skill executed them and tried craftRecipe ("FAILED: craftRecipe failed for chicken" —
 * mobs drop items on death, they are not craftable; the obtain verb never reached killMob). The planner already
 * knew the droppers (entityLoot: chicken <- chicken, pufferfish <- pufferfish); only the rendered task hid that.
 * Entity-obtains now render as "Kill N <dropper>" (voyager routes "kill|hunt|slay|fight N <mob>" to
 * killMob, and the fix141 mob contract chains "approach <mob>" when none is near). Opaque obtains (no recipe,
 * block, entity, or furnace source) keep "Obtain N <item>".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { obtainPlanner } from '../src/agent/recipe_plan.js';

const itemDefs = ['chicken', 'beef', 'cooked_beef', 'egg', 'cow', 'mooshroom', 'sheep', 'wolf', 'furnace', 'oak_log', 'coal', 'stick', 'oak_planks', 'charcoal'];
const registry = {
    items: itemDefs.map((name, i) => ({ id: i, name })),
    itemsByName: Object.fromEntries(itemDefs.map((name, i) => [name, { id: i, name }])),
    blocksByName: {},
    blockLoot: {},
    entityLoot: [
        // chicken drops 1 raw chicken; beef from cow (expected 2/kill) and mooshroom (expected 2/kill)
        { entity: 'chicken', drops: [{ item: 'chicken', dropChance: 1, stackSizeRange: [1, 1] }] },
        { entity: 'cow', drops: [{ item: 'beef', dropChance: 1, stackSizeRange: [1, 3] }] },
        { entity: 'mooshroom', drops: [{ item: 'beef', dropChance: 1, stackSizeRange: [1, 3] }] },
        { entity: 'wolf', drops: [{ item: 'bone', dropChance: 1, stackSizeRange: [0, 2] }] },
    ],
};
const p = () => obtainPlanner({
    registry,
    recipesOf: () => [],
    known: () => false,
    proven: () => false,
    edgeSuccess: () => 1,
    smeltInputs: () => [],
    present: () => false,
});

test('fix142: a mob-dropped food item is planned as Kill <dropper>, not Obtain <item>', () => {
    const pre = p().prerequisites('chicken', 1, {});
    assert.strictEqual(pre.how, 'obtain');
    assert.strictEqual(pre.task, 'Kill 1 chicken');
    assert.deepStrictEqual(pre.from, ['chicken']);
    assert.ok(pre.plan.includes('Kill 1 chicken'), pre.plan.join(' | '));
});

test('fix142: the Kill task names the highest-yield dropper; equal yields break by entity name', () => {
    const pre = p().prerequisites('beef', 1, {});
    assert.deepStrictEqual(pre.from, ['cow', 'mooshroom']);   // equal yield: cow < mooshroom
    assert.strictEqual(pre.task, 'Kill 1 cow');
});

test('fix142: an opaque obtain (no recipe, block, entity, or furnace source) keeps "Obtain N <item>"', () => {
    const pre = p().prerequisites('egg', 1, {});
    assert.strictEqual(pre.task, 'Obtain 1 egg');
});

test('fix142: kill count follows the needed count', () => {
    const pre = p().prerequisites('chicken', 3, {});
    assert.strictEqual(pre.task, 'Kill 3 chicken');
});
