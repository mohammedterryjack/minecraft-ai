/**
 * fix141 (live icefox2000, 17-18 Nov 2026):
 * The bot starved (food 17/20, health 7/20) while huntAndEat > getFood > killMob returned 0 for hours:
 * killMob glances within 48 blocks and gives up when no passive mob is nearby (mobs spawn in patches,
 * https://minecraft.wiki/w/Mob_spawning), but nothing told the planner the bot needs to GO somewhere.
 * PSN blamed the callees that merely reported the miss (equipBestTool/pickupNearbyItems -> null/FAIL)
 * and repaired them; repair dedup then blocked retries and idle practice found "no eligible practice".
 * Root fix: a mob miss is a LOCATION need, mirrored from fix87's reach needs: the new reason 'approach'
 * chains the subgoal "approach <mob>", verified by the mob appearing in observe().nearby_entities.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { isMobEntityName, markEntityOutOfRange, peekPreconditionUnmet, clearPreconditionUnmet } from '../src/agent/precondition.js';
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

describe('fix141: mob classification comes from the game data', () => {
    it('classifies spawnable wandering categories as mobs and everything else as not', () => {
        for (const m of ['cow', 'pig', 'sheep', 'chicken', 'zombie', 'skeleton', 'spider', 'salmon', 'bat', 'squid', 'villager']) {
            assert.strictEqual(isMobEntityName(registry.entitiesByName, m), true, `${m} must be a mob`);
        }
        for (const n of ['minecart', 'item', 'armor_stand', 'arrow', 'egg', 'tnt']) {
            assert.strictEqual(isMobEntityName(registry.entitiesByName, n), false, `${n} must not be a mob`);
        }
    });
    it('rejects empty names and a missing registry loudly', () => {
        assert.throws(() => isMobEntityName(registry.entitiesByName, ''), /non-empty string/);
        assert.throws(() => isMobEntityName(undefined, 'cow'), /entitiesByName required/);
    });
});

describe('fix141: markEntityOutOfRange stamps an approach need', () => {
    it('stamps {item, count 1, reason approach} for a mob and clears after peek', () => {
        const bot = { registry };
        const stamped = markEntityOutOfRange(bot, 'cow');
        assert.ok(stamped, 'markPreconditionUnmet marker returned');
        const peeked = peekPreconditionUnmet(bot);
        assert.ok(peeked, 'the need must be peekable');
        assert.strictEqual(peeked.need.item, 'cow');
        assert.strictEqual(peeked.need.count, 1);
        assert.strictEqual(peeked.need.reason, 'approach');
        assert.ok(peekPreconditionUnmet(bot), 'peek is non-destructive');
        clearPreconditionUnmet(bot);
        assert.strictEqual(peekPreconditionUnmet(bot), null);
    });
    it('reports its own failure for a valid non-mob entity and throws for a name no entity has', () => {
        const bot = { registry };
        assert.strictEqual(markEntityOutOfRange(bot, 'armor_stand'), null); // no need stamped
        assert.strictEqual(peekPreconditionUnmet(bot), null);
        assert.throws(() => markEntityOutOfRange(bot, 'not_a_real_entity'), /not an entity in the game data/);
    });
});

function mk() {
    const v = Object.create(Voyager.prototype);
    v.skills = [];
    v.progress = { blockers: [], recipeEdges: {}, subgoals: [], chain: [] };
    v._saveProgress = () => {};
    v._prereqChain = () => [];
    v._recordGoalOutcome = () => {};
    v.agent = { bot: { entity: { position: { distanceTo: () => 999 } }, entities: {} } };
    return v;
}

describe('fix141: the approach goal is a first-class goal', () => {
    it('parses "approach <mob>" and refuses non-mobs (which fall through to open)', () => {
        const v = mk();
        const g = v._resolveGoal('approach cow');
        assert.strictEqual(g.kind, 'approach');
        assert.strictEqual(g.item, 'cow');
        assert.strictEqual(g.verb, 'approach');
        assert.notStrictEqual(v._resolveGoal('approach armor_stand').kind, 'approach');
        assert.strictEqual(v._resolveGoal('approach cow').verb, 'approach');
    });
    it('holds when the mob is in observe().nearby_entities and throws for wrong state', () => {
        const v = mk();
        const g = v._resolveGoal('approach cow');
        assert.strictEqual(v._approachHolds(g, { nearby_entities: ['cow', 'zombie'] }), true);
        assert.strictEqual(v._approachHolds(g, { nearby_entities: ['pig'] }), false);
        assert.throws(() => v._approachHolds(g, {}), /nearby_entities \(array\) required/);
        assert.throws(() => v._approachHolds({ verb: 'reach', item: 'cow' }, { nearby_entities: [] }), /non-approach/);
    });
    it('keys the goal and the need to the same "approach <mob>" key', () => {
        const v = mk();
        const g = v._resolveGoal('approach cow');
        assert.strictEqual(v._goalKey(g), 'approach cow');
        assert.strictEqual(v._needKey({ item: 'cow', count: 1, reason: 'approach' }), 'approach cow');
    });
});

describe('fix141: mob precheck miss chains an approach subgoal', () => {
    it('_precheck for a killMob route with no mob within 48 reports the approach need', () => {
        const v = mk();
        v.observe = () => ({ nearby_entities: [], nearby_blocks: [], position: '0, 64, 0' });
        const pc = v._precheck({ name: 'killMob', call: 'await killMob(bot, "cow", 1);' });
        assert.strictEqual(pc.ok, false);
        assert.match(pc.why, /no cow within 48 blocks/);
        assert.strictEqual(pc.need.item, 'cow');
        assert.strictEqual(pc.need.reason, 'approach');
    });
    it('_subgoalForNeed maps an approach need to the "approach <mob>" task', () => {
        const v = mk();
        const sub = v._subgoalForNeed({ item: 'cow', count: 1, reason: 'approach', source: 'precheck' }, { inventory: {} }, 'Kill 1 cow', []);
        assert.strictEqual(sub.task, 'approach cow');
    });
    it('a failed "approach cow" does not chain itself (recorded, not cycled)', () => {
        const v = mk();
        // _chainNeeds must not throw the fix81 cycle; with only the self-need it resolves nothing to chain
        const chained = v._chainNeeds('approach cow', [{ item: 'cow', count: 1, reason: 'approach', source: 'goToMob' }], { inventory: {} });
        // returns a promise in production paths only when it proceeds; the guard skips the need first
        assert.ok(chained === false || typeof chained?.then === 'function');
    });
});
