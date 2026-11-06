import { describe, it } from 'node:test';
import assert from 'node:assert';
import { missingCalls } from '../src/agent/skill_graph.js';
import { Voyager } from '../src/agent/voyager.js';

describe('fix51 watcher 09:22', () => {
    it('JS globals like isFinite are not unknown skills', () => {
        const code = 'async function mineBlocks(bot, n) { if (!isFinite(n)) return 0; return encodeURIComponent("x"); }';
        assert.deepStrictEqual(missingCalls(code, 'mineBlocks', new Set()), []);
        assert.deepStrictEqual(missingCalls('async function a(bot){ await notARealSkill(bot); }', 'a', new Set()), ['notARealSkill']);
    });
    it('tossClutter with space already free returns 0 (no stacks removed) so seeded post holds', async () => {
        const prim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'tossClutter');
        const fn = new Function('log', 'getInventoryCounts', 'moveAway', 'depositToChest', 'getNearestBlock', `return (${prim.code});`)(() => {}, () => ({}), async () => {}, async () => false, () => null);
        const bot = { entity: { position: { clone: () => ({}) } }, inventory: { emptySlotCount: () => 4, items: () => [] }, __safeToToss: [], __depositCandidates: ['cobblestone'], __uncertainItems: [] };
        const ret = await fn(bot, 4);
        assert.strictEqual(ret, 0);
        // learned live contract (09:17 log): c => !c.ret || Object.keys(c.delta).some(k => (c.delta[k]||0) < 0)
        const post = c => !c.ret || Object.keys(c.delta).some(k => (c.delta[k]||0) < 0);
        assert.strictEqual(post({ ret, delta: {} }), true);
    });
    it('regression rerun skips past tasks whose goal is not among the skill learned effects (callee inherits caller task)', async () => {
        const v = Object.create(Voyager.prototype);
        let staged = false;
        v.agent = { coder: { _stageCode: async () => { staged = true; return null; } } };
        v.observe = () => ({ inventory: {} });
        const entry = { name: 'pickupNearbyItems', effects: [], stats: { tasks: ['Mine 5 iron_ore'] } };
        const r = await v._regressionRun(entry, 'async function pickupNearbyItems(bot) { }');
        assert.strictEqual(r, null);
        assert.strictEqual(staged, false);
    });
});
