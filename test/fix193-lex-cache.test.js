// fix193: lexical routing hot path — cached per-skill fields and the memoised poly-merge must preserve exact
// semantics (the old per-pair regexes blocked the event loop ~37 s per library pass; 196 live [loop-stall] hits).
import test from 'node:test';
import assert from 'node:assert/strict';
import { wordOverlapScore, makeOverlapQuery, makeOverlapTarget, overlapWithFields, overlapWithSet } from '../src/utils/text.js';
import { Voyager } from '../src/agent/voyager.js';

test('overlapWithFields equals wordOverlapScore exactly (incl. digits and empty-token artifacts)', () => {
    const qs = [
        'Craft 1 stone_pickaxe', 'Mine 3 cobblestone within 16 blocks', 'Approach the cod 3',
        'collect 5 oak_wood and craft 1 chest', 'Smelt 3 cod into 3 cooked_cod', '', '   ', 'a_b c1 2',
    ];
    const ts = [
        'Craft 1 stone_pickaxe', 'Mine 5 cobblestone', 'Approach the squid', 'collect oak_wood',
        'Craft 4 sticks from birch_planks', '', '12345', 'a b',
    ];
    for (const a of qs) {
        const q = makeOverlapQuery(a);
        for (const b of ts) {
            assert.equal(overlapWithFields(q, makeOverlapTarget(b)), wordOverlapScore(a, b), `fields(${a}, ${b})`);
            assert.equal(overlapWithSet(q, b), wordOverlapScore(a, b), `set(${a}, ${b})`);
        }
    }
});

test('_lexFields caches per skill object and invalidates when code changes', () => {
    const v = Object.create(Voyager.prototype);
    const s = { name: 'mineOre', task: 'Mine 3 coal_ore', code: 'async function mineOre(bot) {}' };
    const f1 = v._lexFields(s);
    assert.equal(f1.reqArgs.length, 0);
    assert.equal(v._lexFields(s), f1, 'same object returned from cache');
    s.code = 'async function mineOre(bot, count) {}';
    const f2 = v._lexFields(s);
    assert.notEqual(f2, f1, 'code change invalidates');
    assert.deepEqual(f2.reqArgs, ['count']);
});

test('_lexicalReplay picks the same winner cached or uncached, and honours required args', () => {
    const mk = (name, task, code) => ({ name, task, code, stats: { success: 1, fail: 0 } });
    const skills = [
        mk('craftPickaxe', 'Craft 1 diamond_pickaxe', 'async function craftPickaxe(bot) {}'),
        mk('craftSword', 'Craft 1 diamond_sword', 'async function craftSword(bot) {}'),
    ];
    const v = Object.create(Voyager.prototype); v.skills = skills;
    const r1 = v._lexicalReplay('Craft 1 diamond_pickaxe');
    assert.equal(r1.name, 'craftPickaxe');
    const r2 = v._lexicalReplay('Craft 1 diamond_pickaxe');  // cached fields path
    assert.deepEqual(r2, r1);
    skills[0].code = 'async function craftPickaxe(bot, count) {}';   // fix111: bare call cannot fill args
    const r3 = v._lexicalReplay('Craft 1 diamond_pickaxe');
    assert.notEqual(r3?.name, 'craftPickaxe');
});

test('_polyMerge runs once per library size, re-runs when the library changes', () => {
    const v = Object.create(Voyager.prototype);
    let calls = 0;
    v._findReplay = () => { calls++; return null; };
    v._saveSkills = () => {};
    v.skills = [{ name: 'aSkill', task: 'Do a thing', code: 'async function aSkill(bot) {}' }];
    v._polyMerge();
    assert.equal(calls, 1);
    v._polyMerge();
    assert.equal(calls, 1, 'memoised: no library change, no sweep');
    v.skills.push({ name: 'bSkill', task: 'Do another thing', code: 'async function bSkill(bot) {}' });
    v._polyMerge();
    assert.equal(calls, 3, 'new library size re-runs the pass');
});
