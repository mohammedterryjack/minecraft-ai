/*
 * fix205 (live icefox2000, 27 Nov 2026 ~11:20 GMT): food fell to 2/20 while the bot starved next to the
 * pillager camp. The learned regen floor is 18, so closing it from 2 needs 16 food points. The food chain
 * asked planner.cheapest(foods, 1, inv): cheapest per ITEM. dried_kelp restores 1 food point
 * (minecraft.wiki/w/Food) and collects off any ocean-adjacent block, so one kelp was the cheapest unit and
 * was chosen — then the bot needed ~16 of them, each behind a "Smelt 1 kelp into 1 dried_kelp" furnace step,
 * and died to mobs before the third smelt. cooked_cod restores 5 (3 cooked, 1 cod): 3-4 units close the same
 * deficit. Ranking must be cost-to-close-the-deficit, count = ceil(deficit / foodPoints), not cost-per-item.
 * fix205b: goals decomposed from game data created no progress.recipeEdges entry, so every failure of
 * "Collect 1 kelp" / "Smelt 1 kelp into 1 dried_kelp" was counted nowhere — edgeSuccess(kelp) stayed at its
 * optimistic prior while the live task failed 4 attempts at a time, so the food ranker could never learn
 * away from the kelp grind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFoodAcquisition } from '../src/agent/food_backchain.js';
import { lessCost } from '../src/agent/recipe_plan.js';

// food points per minecraft.wiki/w/Food table (dried_kelp 1, cod 2, cooked_cod 5, bread 5)
const FOODS = { dried_kelp: 1, cod: 2, cooked_cod: 5, bread: 5 };
const foodValue = (item) => FOODS[item];

// unit costs: one kelp collect+smelt costs 2 steps, one cod kill+smelt costs 4 — per unit kelp is cheaper
const unitCost = { dried_kelp: [0, 1, 1, 2], cod: [0, 2, 2, 4], cooked_cod: [0, 2, 2, 4], bread: [0, 3, 3, 5] };
const costOf = (item, count) => {
    const u = unitCost[item];
    if (!u) return null;
    return u.map((x) => x * count);
};
const prerequisites = (item) => ({ task: `Collect 1 ${item}`, how: 'collect', plan: [], cycles: [] });
const entityDroppersFor = () => [];

const plan = (deficitPoints, over = {}) => planFoodAcquisition({
    edibles: Object.keys(FOODS), inventory: {}, deficitPoints, foodValue, costOf, prerequisites, entityDroppersFor,
    ...over,
});

test('deficit 15 picks the 5-point food even though the 1-point food has the cheapest unit', () => {
    const p = plan(15);
    // dried_kelp: 15 units x [0,1,1,2] = [0,15,15,30]; cooked_cod: 3 units x [0,2,2,4] = [0,6,6,12]
    assert.strictEqual(p.item, 'cooked_cod', JSON.stringify(p));
    assert.strictEqual(p.units, 3);
});

test('a small deficit still takes the cheap small bite: deficit 1 prefers dried_kelp', () => {
    const p = plan(1);
    assert.strictEqual(p.item, 'dried_kelp');
    assert.strictEqual(p.units, 1);
});

test('units round up: deficit 12 of a 5-point food is 3 units', () => {
    const p = plan(12, {
        edibles: ['cooked_cod', 'bread'],
        costOf: (item, count) => [0, 0, 0, count],   // equal raw cost per unit: bread(5pt)=3 units vs cod 3 units
    });
    assert.ok(['bread', 'cooked_cod'].includes(p.item));
    assert.strictEqual(p.units, 3);
});

test('equal cost vectors break by ascending item name, the planner pick() tie rule', () => {
    const p = plan(10, { costOf: (item) => [0, 1, 1, 1] });
    assert.strictEqual(p.item, 'bread');   // tied cost: bread < cod < cooked_cod < dried_kelp
});

test('a candidate no cost can close fails loudly, it is not quietly skipped', () => {
    assert.throws(
        () => plan(15, { edibles: ['mystery_meal'], foodValue: () => 4, costOf: () => null }),
        /fix205.*LOUD.*none of the 1 edible items can close a 15-food-point deficit/,
    );
});

test('a non-positive or missing deficit is a contract violation, not a silent one-item plan', () => {
    for (const bad of [0, -3, NaN, undefined, 'sixteen']) {
        assert.throws(() => planFoodAcquisition({
            edibles: ['bread'], inventory: {}, deficitPoints: bad,
            foodValue, costOf, prerequisites, entityDroppersFor,
        }), /deficitPoints/);
    }
});

test('a foodValue that is not a number fails loudly', () => {
    assert.throws(
        () => plan(5, { foodValue: () => undefined }),
        /foodValue\(dried_kelp\) must return a number/,
    );
});

test('a held edible is eaten before any deficit probe runs', () => {
    const p = planFoodAcquisition({
        edibles: Object.keys(FOODS), inventory: { bread: 1 }, deficitPoints: 15,
        foodValue: () => { throw new Error('must not value food while one is held'); },
        costOf: () => { throw new Error('must not cost food while one is held'); },
        prerequisites: () => { throw new Error('must not plan while one is held'); },
        entityDroppersFor: () => [],
    });
    assert.strictEqual(p.executable, true);
    assert.strictEqual(p.item, 'bread');
});

test('lessCost is the shared strict lexicographic order and refuses mismatched vectors', () => {
    assert.strictEqual(lessCost([0, 1, 0], [0, 2, 0]), true);
    assert.strictEqual(lessCost([0, 2, 0], [0, 1, 0]), false);
    assert.strictEqual(lessCost([1, 1], [1, 1]), false);
    assert.throws(() => lessCost([1, 1], [1]), /differ in length/);
    assert.throws(() => lessCost(null, [1]), /cost vectors/);
});

test('lessCost is exported by recipe_plan.js (the planner and the food ranker share one comparator)', async () => {
    const mod = await import('../src/agent/recipe_plan.js');
    assert.strictEqual(typeof mod.lessCost, 'function');
});

test('fix205b: game-data plan tasks register producer edges, so their failures count', async () => {
    const mod = await import('../src/agent/voyager.js');
    mod._setVersionForTest('1.21.4');
    const v = Object.create(mod.Voyager.prototype);
    v.progress = { recipeEdges: {} };
    v._saveProgress = () => {};
    v._noteEdgePlanTasks(['Smelt 1 kelp into 1 dried_kelp', 'Collect 1 kelp', 'Craft 1 furnace', 'reach kelp']);
    assert.deepStrictEqual(v.progress.recipeEdges.dried_kelp, { task: 'Smelt 1 kelp into 1 dried_kelp', status: 'untried', runs: 0, fails: 0 });
    assert.strictEqual(v.progress.recipeEdges.kelp.task, 'Collect 1 kelp');
    assert.strictEqual(v.progress.recipeEdges.furnace.task, 'Craft 1 furnace');
    // a reach step produces no item; no edge may be keyed on it
    for (const key of Object.keys(v.progress.recipeEdges)) assert.notStrictEqual(key, 'reach kelp');
    // the live failure pattern: "Collect 1 kelp" fails four attempts; the edge must now see it
    for (let i = 0; i < 4; i++) v._noteEdgeOutcome('Collect 1 kelp', false);
    assert.strictEqual(v.progress.recipeEdges.kelp.fails, 4);
    assert.strictEqual(v.progress.recipeEdges.kelp.runs, 4);
    assert.ok(v._edgeSuccess('kelp', 'collect') < 1, 'the kelp collect posterior must drop below its prior');
});

test('fix205b wiring: the game-data decompose registers edges before queueing subgoals', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
    assert.match(src, /_noteEdgePlanTasks\(\[task, \.\.\.subs\]\)/);
});
