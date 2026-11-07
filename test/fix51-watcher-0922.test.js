import { describe, it } from 'node:test';
import assert from 'node:assert';
import { missingCalls } from '../src/agent/skill_graph.js';
import { Voyager, _setVersionForTest } from '../src/agent/voyager.js';

describe('fix51 watcher 09:22', () => {
    it('JS globals like isFinite are not unknown skills', () => {
        const code = 'async function mineBlocks(bot, n) { if (!isFinite(n)) return 0; return encodeURIComponent("x"); }';
        assert.deepStrictEqual(missingCalls(code, 'mineBlocks', new Set()), []);
        assert.deepStrictEqual(missingCalls('async function a(bot){ await notARealSkill(bot); }', 'a', new Set()), ['notARealSkill']);
    });
    it('tossClutter that drops items without freeing a slot returns false, and the seeded post does not hold', async () => {
        const prim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'tossClutter');
        const fn = new Function(`return (${prim.code});`)();
        let count = 24;
        const bot = {
            interrupt_code: false,
            currentWindow: null,
            registry: { itemsByName: { dirt: { id: 1, stackSize: 64 } } },
            inventory: { emptySlotCount: () => 0, items: () => [{ name: 'dirt', type: 1, count }] },
            async toss(_type, _meta, n) { count -= n; },
        };
        const ret = await fn(bot, 1, [{ item: 'dirt', remove: 20, keep: 4 }]);
        assert.strictEqual(ret, false);
        assert.strictEqual(count, 4);
        const post = new Function('c', `return (${prim.contract.post})(c);`);
        assert.strictEqual(post({ pre: { free: 0 }, post: { free: 0 } }), false);
        assert.strictEqual(post({ pre: { free: 0 }, post: { free: 1 } }), true);
    });
    it('regression rerun skips past tasks whose goal is not among the skill learned effects (callee inherits caller task)', async () => {
        _setVersionForTest('1.20.4');
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
