// fix190: consume-evidence keep floors that consist of a skill's OWN (or a child skill's) tossing could never
// drain. fix182 subtracted disposal at measurement time, but the poisoned evidence predates the tally and the
// keep floor blocks discard() BEFORE the toss skill runs, so no new measured run ever arrives:
// "keeping all 12 dirt: 33 reserved", "keeping all 9 granite: 64 reserved" (mindcraft.log 25 Nov; cleanupInventory
// consumeEvidence granite x64 = its own toss, discardBulkLitter leaf_litter x74 via a variable loop, goHoglin
// diorite x44 through child clearInventoryForHoglinDrops). Rule: evidence measured WITH a disposal tally is
// marked accounted; unaccounted evidence on a skill that can dispose (transitive call graph of disposal
// primitives) reports nothing until re-measured — the fix70 stance for never-re-verified records. fix190 also
// taps bot.toss/bot.tossStack into the tally so measured runs attribute EVERY disposal path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordConsumeEvidence, verifiedConsumes, annotateMayDispose } from '../src/agent/consume_evidence.js';

test('a run measured with a tally marks its evidence accounted', () => {
    const s = { name: 'smeltIron' };
    recordConsumeEvidence(s, { raw_iron: 5, coal: 4 }, { raw_iron: 1, coal: 2 }, new Map());
    assert.equal(s.consumeEvidence.accounted, true);
    assert.deepEqual(verifiedConsumes(s), { raw_iron: 4, coal: 2 });
});

test('a run measured without a tally is not accounted', () => {
    const s = { name: 'legacyStyle' };
    recordConsumeEvidence(s, { granite: 64 }, { granite: 0 });
    assert.ok(!s.consumeEvidence.accounted);
    recordConsumeEvidence(s, { granite: 64 }, { granite: 0 }, new Map());
    assert.equal(s.consumeEvidence.accounted, true);
    recordConsumeEvidence(s, { granite: 60 }, { granite: 30 });
    assert.ok(!s.consumeEvidence.accounted, 'an unaccounted run revokes the accounted mark');
});

test('unaccounted evidence on a disposing skill reports nothing (the fix182 deadlock drain)', () => {
    const s = {
        name: 'discardBulkLitter',
        mayDispose: true,
        consumeEvidence: { runs: 2, items: { leaf_litter: { runs: 2, max: 74 }, oak_sapling: { runs: 2, max: 33 } } },
    };
    assert.deepEqual(verifiedConsumes(s), {});
});

test('accounted evidence on a disposing skill stands (the tally attributed it)', () => {
    const s = {
        name: 'smeltThenTossSlag',
        mayDispose: true,
        consumeEvidence: { runs: 2, accounted: true, items: { diorite: { runs: 2, max: 20 }, coal: { runs: 2, max: 2 } } },
    };
    assert.deepEqual(verifiedConsumes(s), { diorite: 20, coal: 2 });
});

test('unaccounted evidence on a skill that cannot dispose stands (unchanged behaviour)', () => {
    const s = {
        name: 'smeltWithFuel',
        consumeEvidence: { runs: 3, items: { coal: { runs: 3, max: 2 }, raw_iron: { runs: 2, max: 5 } } },
    };
    assert.deepEqual(verifiedConsumes(s), { coal: 2 });
});

test('annotateMayDispose seeds on disposal calls and propagates through the call graph', () => {
    const skills = [
        { name: 'tossDirt', code: "async function tossDirt(bot) { await tossItem(bot, 'dirt', 10); }" },
        { name: 'cleanupInventory', code: "async function cleanupInventory(bot) { for (const i of junk) await discard(bot, i); }" },
        { name: 'clearInventoryForHoglinDrops', code: "async function clearInventoryForHoglinDrops(bot) { for (const i of junk) await bot.tossStack(i); }" },
        { name: 'goHoglin', code: "async function goHoglin(bot) { await clearInventoryForHoglinDrops(bot); return true; }" },
        { name: 'walkToTown', code: "async function walkToTown(bot) { await bot.pathfinder.goto(g); }" },
    ];
    const n = annotateMayDispose(skills);
    assert.equal(n, 4);
    assert.deepEqual(new Set(skills.filter(s => s.mayDispose).map(s => s.name)),
        new Set(['tossDirt', 'cleanupInventory', 'clearInventoryForHoglinDrops', 'goHoglin']));
    assert.ok(!skills.find(s => s.name === 'walkToTown').mayDispose);
});

test('_beginMeasuredRun taps bot.toss and bot.tossStack into the discard tally', async () => {
    const { tallyDisposal } = await import('../src/agent/library/skills.js');
    const { Voyager } = await import('../src/agent/voyager.js');
    const bot = {
        _runDiscardTally: null,
        tossStack: async () => { bot._stackTossed = true; },
        toss: async () => { bot._tossed = true; },
    };
    const v = Object.create(Voyager.prototype);
    v.agent = { bot };
    v._beginMeasuredRun();
    await bot.tossStack({ name: 'granite', count: 19 });
    await bot.toss('dirt', 10);
    assert.equal(bot._stackTossed, true, 'original tossStack must still run');
    assert.equal(bot._tossed, true, 'original toss must still run');
    assert.equal(tallyDisposal && bot._runDiscardTally.get('granite'), 19);
    assert.equal(bot._runDiscardTally.get('dirt'), 10);
    v._beginMeasuredRun();   // second run: fresh tally, taps not stacked
    assert.equal(bot._runDiscardTally.size, 0);
    await bot.tossStack({ name: 'diorite', count: 4 });
    assert.equal(bot._runDiscardTally.get('diorite'), 4);
});
