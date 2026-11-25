// fix182: disposal is not consumption. The toss skills' own tossing was recorded as consuming
// granite/leaf_litter in every measured run, _publishItemKeeps reserved them (granite 64,
// leaf_litter 74 — mindcraft.log 69905/72688 "keeping all 19 granite: 64 reserved"), and
// discard() then refused every later free-up. tallyDisposal (library/skills.js) counts what a
// run threw away or stored; recordConsumeEvidence excludes it from consumption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordConsumeEvidence, verifiedConsumes } from '../src/agent/consume_evidence.js';

test('a drop fully explained by disposal records no consumption', () => {
    const s = { name: 'discardBulkLitter' };
    recordConsumeEvidence(s, { leaf_litter: 74, cobblestone: 10 }, { leaf_litter: 0, cobblestone: 10 }, new Map([['leaf_litter', 74]]));
    assert.deepEqual(s.consumeEvidence.items, {});
    assert.equal(s.consumeEvidence.runs, 1);
    assert.deepEqual(verifiedConsumes(s), {});
});

test('a drop larger than the tally still records what the run really spent', () => {
    const s = { name: 'craftAndToss' };
    // 50 granite gone, 30 tossed -> 20 spent as input
    recordConsumeEvidence(s, { granite: 100, crafting_table: 1 }, { granite: 50, crafting_table: 1 }, new Map([['granite', 30]]));
    assert.deepEqual(s.consumeEvidence.items.granite, { runs: 1, max: 20 });
});

test('items with no disposal keep recording consumption unchanged', () => {
    const s = { name: 'smeltIron' };
    recordConsumeEvidence(s, { raw_iron: 5, coal: 4 }, { raw_iron: 1, coal: 2 }, new Map());
    assert.deepEqual(s.consumeEvidence.items.raw_iron, { runs: 1, max: 4 });
    assert.deepEqual(s.consumeEvidence.items.coal, { runs: 1, max: 2 });
});

test('one new disposal-only measured run drains the pre-fix verified consumption', () => {
    // simulate the polluted granite 64 evidence from before fix182 (2/2 runs)
    const s = { name: 'tossGranite', consumeEvidence: { runs: 2, items: { granite: { runs: 2, max: 64 } } } };
    assert.deepEqual(verifiedConsumes(s), { granite: 64 });
    // the same skill runs again under fix182: it only tosses granite
    recordConsumeEvidence(s, { granite: 19 }, { granite: 0 }, new Map([['granite', 19]]));
    assert.deepEqual(verifiedConsumes(s), {});   // 1 of 3 runs -> no longer every-run evidence
});

test('tallyDisposal only counts when a measured run window is installed', async () => {
    const { tallyDisposal } = await import('../src/agent/library/skills.js');
    const bot = {};
    tallyDisposal(bot, 'granite', 10);
    assert.equal(bot._runDiscardTally, undefined);
    const tally = new Map();
    bot._runDiscardTally = tally;
    tallyDisposal(bot, 'granite', 10);
    tallyDisposal(bot, 'granite', 5);
    tallyDisposal(bot, 'dirt', 0);
    assert.deepEqual([...tally.entries()], [['granite', 15]]);
});
