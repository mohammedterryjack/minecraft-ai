// fix175: the obtain planner treats world-absence of a mob as a fact. Game data says pigs drop
// porkchop; if no pig has been seen in this world, a Kill task for it can only fail — and the task
// gate (voyager "never been sighted in this world") rejected it every step, livelocking the hunger
// serve against the queue (23 Nov 2026: 375 instant steps in 6 minutes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { obtainPlanner } from '../src/agent/recipe_plan.js';

const itemDefs = ['porkchop', 'hoglin', 'pig'];
const registry = {
    items: itemDefs.map((name, i) => ({ id: i, name })),
    itemsByName: Object.fromEntries(itemDefs.map((name, i) => [name, { id: i, name }])),
    blocksByName: {},
    blockLoot: {},
    entityLoot: [
        // hoglin drops 1-3 raw porkchop; pig drops 1-2 (hoglin has the higher expected yield)
        { entity: 'hoglin', drops: [{ item: 'porkchop', dropChance: 1, stackSizeRange: [1, 3] }] },
        { entity: 'pig', drops: [{ item: 'porkchop', dropChance: 1, stackSizeRange: [1, 2] }] },
    ],
};
const p = (mobSighted) => obtainPlanner({
    registry,
    recipesOf: () => [],
    known: () => false,
    proven: () => false,
    edgeSuccess: () => 1,
    smeltInputs: () => [],
    present: () => false,
    mobSighted,
});

test('fix175: mobSighted is a required option', () => {
    assert.throws(() => obtainPlanner({
        registry, recipesOf: () => [], known: () => false, proven: () => false,
        edgeSuccess: () => 1, smeltInputs: () => [], present: () => false,
    }), /\[fix175\] obtainPlanner: mobSighted\(entity\) required/);
});

test('fix175: sighted droppers yield the Kill task naming the highest-yield one', () => {
    const pre = p((m) => m === 'pig' || m === 'hoglin').prerequisites('porkchop', 1, {});
    assert.strictEqual(pre.how, 'obtain');
    assert.strictEqual(pre.task, 'Kill 1 hoglin');
    assert.deepStrictEqual(pre.from, ['hoglin', 'pig']);
});

test('fix175: an unseen dropper is no source: the obtain stays opaque, never a Kill for an absent mob', () => {
    const pre = p(() => false).prerequisites('porkchop', 1, {});
    assert.strictEqual(pre.how, 'obtain');
    assert.ok(!/^Kill /.test(pre.task), `absent mob must not be tasked: ${pre.task}`);
    assert.strictEqual(pre.task, 'Obtain 1 porkchop');
    assert.deepStrictEqual(pre.from, []);
});

test('fix175: a partially sighted world only offers the seen dropper', () => {
    const pre = p((m) => m === 'pig').prerequisites('porkchop', 1, {});
    assert.strictEqual(pre.task, 'Kill 1 pig');
    assert.deepStrictEqual(pre.from, ['pig']);
});
