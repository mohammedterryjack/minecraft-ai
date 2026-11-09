/**
 * fix95 (live icefox2000, 9 Nov 2026, d99d916; 14:00-19:00 GMT):
 *  A. Hunger never served: 337 "Collect 1 apple (stale: parent "need:hunger" is already completed)" in progress.failed,
 *     58 in the last 1h27m. need:hunger completed once, and "completed ever" made every later food plan stale.
 *  B. A search for an item name that is not a block (wheat_seeds) returned null with no I/O; generated code retried it
 *     3,500 times in a row and the watchdog SIGKILLed the process (13:47:31 GMT). 7,061 such lines since 14:00.
 *  C. craftItem (task "Craft N of an item") picked as the producer subgoal threw [fix86] on every step; the same step
 *     error twice exited the process (17:15 GMT).
 *  D. tossOneRawCopper.pre returned undefined in idle practice: an unhandled rejection.
 *  E. logCactusAbsence was picked for practice 76 times in 1h27m: NO VERDICT each time (its post cannot verify a run
 *     and the repair was already rejected), stats unchanged, so the ranking never moved.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { itemSourceBlocks } from '../src/utils/item_sources.js';
import { getNearestBlock } from '../src/agent/library/world.js';
import { gatherUntil, collectBlock } from '../src/agent/library/skills.js';
import { peekPreconditionUnmet } from '../src/agent/precondition.js';
import { _setVersionForTest as setMcVersion } from '../src/utils/mcdata.js';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
    setMcVersion(VER);
});

describe('fix95 A: a recurring need is not "completed forever"', () => {
    function rig(completedAt) {
        const v = Object.create(Voyager.prototype);
        v.progress = {
            subgoals: [], failed: [], completed: ['need:hunger'], completedAt,
            decomposed: { 'need:hunger': { subs: ['Collect 1 apple'], skills: [], at: 1000, reason: 'needs: 1 apple (input, game data)' } },
        };
        v._curSub = null;
        v._resolveGoal = () => ({ kind: 'item', item: 'apple', count: 1 });
        return v;
    }
    const sub = { task: 'Collect 1 apple', parent: 'need:hunger', depth: 1 };
    it('a food plan decomposed after the need last completed still runs (live: it was dropped as stale 337 times)', () => {
        assert.strictEqual(rig({ 'need:hunger': 999 })._staleSubgoal(sub, {}), null);
        assert.strictEqual(rig({})._staleSubgoal(sub, {}), null);
    });
    it('a plan whose parent completed after it was decomposed is stale', () => {
        assert.match(rig({ 'need:hunger': 1001 })._staleSubgoal(sub, {}), /completed after it was decomposed/);
    });
    it('a decomposition without a time is refused loudly', () => {
        const v = rig({});
        delete v.progress.decomposed['need:hunger'].at;
        assert.throws(() => v._staleSubgoal(sub, {}), /\.at must be a time/);
    });
    it('_markCompleted records the history entry and when it completed', () => {
        const v = Object.create(Voyager.prototype);
        v.progress = { completed: [], completedAt: {} };
        const t0 = Date.now();
        v._markCompleted('need:hunger');
        assert.deepStrictEqual(v.progress.completed, ['need:hunger']);
        assert.ok(v.progress.completedAt['need:hunger'] >= t0);
        assert.throws(() => v._markCompleted(''), /task string/);
    });
});

describe('fix95 B: an item is searched for by the blocks that yield it', () => {
    it('itemSourceBlocks reads the loot tables (no silk touch) and keeps only blocks of this version', () => {
        assert.deepStrictEqual(itemSourceBlocks(registry, 'wheat_seeds').sort(), ['fern', 'large_fern', 'tall_grass', 'wheat']);
        assert.deepStrictEqual(itemSourceBlocks(registry, 'cobblestone').sort(), ['cobblestone', 'stone']);
        assert.deepStrictEqual(itemSourceBlocks(registry, 'apple').sort(), ['dark_oak_leaves', 'oak_leaves']);
        assert.deepStrictEqual(itemSourceBlocks(registry, 'cooked_beef'), []);
        assert.ok(!itemSourceBlocks(registry, 'wheat_seeds').includes('grass'), '1.20 loot key "grass" is not a 1.20.4 block');
    });
    it('getNearestBlock refuses an item name loudly and names the blocks that drop it', () => {
        const bot = { registry, findBlocks: () => { throw new Error('must not search'); }, blockAt: () => null };
        assert.throws(() => getNearestBlock(bot, 'wheat_seeds', 16), /not a block in the game data; the blocks that drop it are .*tall_grass/);
        assert.throws(() => getNearestBlock(bot, 'cooked_beef', 16), /no block drops it/);
    });
    function gatherBot() {
        const searched = [];
        return {
            searched,
            registry, output: '',
            interrupt_code: false,
            inventory: { slots: new Array(46).fill(null) },
            entity: { position: { x: 0, y: 64, z: 0 } },
            findBlocks: ({ matching }) => { searched.push(matching); return []; },
            blockAt: () => null,
        };
    }
    it('gatherUntil searches the source blocks and reports a reach need for them', async () => {
        const bot = gatherBot();
        assert.strictEqual(await gatherUntil(bot, 'wheat_seeds', 1, 32), false);
        const ids = ['fern', 'large_fern', 'tall_grass', 'wheat'].map(n => registry.blocksByName[n].id).sort();
        assert.deepStrictEqual([...bot.searched[0]].sort(), ids);
        const need = peekPreconditionUnmet(bot).need;
        assert.deepStrictEqual(need.anyOf.slice().sort(), ['fern', 'large_fern', 'tall_grass', 'wheat']);
        assert.strictEqual(need.reason, 'reach');
    });
    it('gatherUntil and collectBlock throw for an item no block yields, before any search', async () => {
        const bot = gatherBot();
        await assert.rejects(gatherUntil(bot, 'cooked_beef', 1, 32), /no block in the game data drops cooked_beef/);
        await assert.rejects(collectBlock(bot, 'cooked_beef', 1), /no block drops it/);
        assert.strictEqual(bot.searched.length, 0);
    });
});

describe('fix95 C: a generic producer task is not a subgoal and does not throw', () => {
    it('craftItem makes iron_pickaxe but "Craft N of an item" is not a subgoal: null, so the game data names it', () => {
        const v = Object.create(Voyager.prototype);
        v.skills = [{ name: 'craftItem', task: 'Craft N of an item', code: 'async function craftItem(bot) { return false; }', effects: ['iron_pickaxe'], consumes: {}, demoted: false, candidate: false, mergedInto: null }];
        v.npGraph = null;
        v._boltzmann = list => list[0];
        assert.strictEqual(v._subgoalToObtainItem('iron_pickaxe', 1, {}, new Set()), null);
        assert.strictEqual(v._taskIsGenericFor(v.skills[0], 'iron_pickaxe'), true);
        assert.strictEqual(v._taskIsGenericFor({ task: 'Craft 1 iron_pickaxe' }, 'iron_pickaxe'), false);
    });
});

function state(inv) {
    return { pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, sky: 15, alive: true, dim: 'overworld', inv, free: 30,
        eq: { heldItem: null, offHand: null, helmet: null, chestplate: null, leggings: null, boots: null } };
}
function contractRig(pre, post, rec) {
    const v = Object.create(Voyager.prototype);
    v.skills = [{ name: 's', description: 's', code: 'async function s(bot) { return; }', deps: [], effects: [], stats: { success: 0, fail: 0, tasks: [] }, contract: { pre, post, text: 's' } }];
    v.progress = { repairQueue: [] };
    v._saveProgress = () => {};
    v._saveSkills = () => {};
    v._cursorLimited = () => false;
    v.agent = { bot: { __psnTrace: [rec] } };
    return v;
}

describe('fix95 D: a learned pre that returns a non-boolean is a bad contract, not an unhandled rejection', () => {
    it('_postVerifiesRun reports it (ok false) and practice queues the contract repair', () => {
        const s0 = state({});
        const s1 = state({ raw_copper: 0 });
        const rec = { name: 's', parent: -1, depth: 0, argv: [], rv: true, fail: false, s0, s1, delta: {} };
        const v = contractRig("c => c.pre.inv['raw_copper'] && c.pre.alive", "c => c.post.inv['raw_copper'] === 0", rec);
        const r = v._postVerifiesRun(v.skills[0]);
        assert.strictEqual(r.ok, false);
        assert.match(r.why, /returned undefined, not a boolean/);
        const verdict = v._practiceRunChanged(v.skills[0], {}, {});
        assert.strictEqual(verdict.ok, null);
        assert.strictEqual(v._repairQueue.length, 1);
        assert.match(v._repairQueue[0].evidence, /not a boolean/);
    });
});

describe('fix95 E: a contract shown unable to verify a run is not practised on again until it changes', () => {
    it('the skill is not judgeable on that contract; a repaired contract is', () => {
        const s = state({});
        const rec = { name: 's', parent: -1, depth: 0, argv: [], rv: undefined, fail: false, s0: s, s1: s, delta: {} };
        const v = contractRig('c => c.pre.alive', "c => !c.ret && c.pre.dim !== 'the_end'", rec);
        const e = v.skills[0];
        assert.strictEqual(v._practiceJudgeable(e), true);
        const first = v._practiceRunChanged(e, {}, {});
        assert.strictEqual(first.ok, null);
        assert.match(first.detail, /not practised on this post again/);
        assert.strictEqual(v._practiceJudgeable(e), false);
        e.contract = { ...e.contract, post: 'c => c.post.inv.cactus > c.pre.inv.cactus' };
        assert.strictEqual(v._practiceJudgeable(e), true);
        e.contract = { ...e.contract, post: "c => !c.ret && c.pre.dim !== 'the_end'", pre: 'c => c.pre.hp > 0' };
        assert.strictEqual(v._practiceJudgeable(e), true, 'a changed pre is a changed contract');
    });
});
