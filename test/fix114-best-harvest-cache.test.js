/**
 * fix114: memoized bot.pathfinder.bestHarvestTool.
 * The plugin default (mineflayer-pathfinder index.js:46) nbt-decodes every tool per
 * inventory item per A* node; the cache wraps that same default and must return the
 * identical answer until an input (inventory item instances, effects) changes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { installCachedBestHarvestTool, _wrapBestHarvestToolForTest } from '../src/utils/harvest_tool_cache.js';

function mkBot(items = [], effects = {}) {
    const bot = {
        inventory: { items: () => items.slice() },
        entity: { effects },
        pathfinder: {},
    };
    return bot;
}

// A stand-in for the plugin default that records each block it was asked about.
function recordingDefault(choose) {
    const calls = [];
    const fn = (block) => { calls.push(block ? block.name : null); return choose(block); };
    fn.calls = calls;
    return fn;
}

describe('fix114 bestHarvestTool cache', () => {
    it('asks the default once per block name while inputs are unchanged', () => {
        const bot = mkBot([{ type: 1, nbt: null }]);
        const def = recordingDefault(() => 'pick');
        _wrapBestHarvestToolForTest(bot, def);
        for (let i = 0; i < 1000; i++) {
            assert.strictEqual(bot.pathfinder.bestHarvestTool({ name: 'stone' }), 'pick');
        }
        assert.strictEqual(def.calls.length, 1);
        assert.strictEqual(bot.pathfinder.bestHarvestTool({ name: 'iron_ore' }), 'pick');
        assert.strictEqual(def.calls.length, 2); // one more block name, not 1001
    });

    it('recomputes when an inventory instance is replaced', () => {
        const bot = mkBot([{ type: 1, nbt: null }]);
        let want = 'wood_pick';
        const def = recordingDefault(() => want);
        _wrapBestHarvestToolForTest(bot, def);
        assert.strictEqual(bot.pathfinder.bestHarvestTool({ name: 'stone' }), 'wood_pick');
        bot.inventory.items = () => [{ type: 2, nbt: null }]; // slot replaced by packet
        want = 'iron_pick';
        assert.strictEqual(bot.pathfinder.bestHarvestTool({ name: 'stone' }), 'iron_pick');
        assert.strictEqual(def.calls.length, 2);
    });

    it('recomputes when effects change (amplifier included)', () => {
        const bot = mkBot([{ type: 1, nbt: null }], { Haste: { id: 3, amplifier: 0 } });
        let want = 'no_haste';
        const def = recordingDefault(() => want);
        _wrapBestHarvestToolForTest(bot, def);
        bot.pathfinder.bestHarvestTool({ name: 'stone' });
        bot.entity.effects = { Haste: { id: 3, amplifier: 0 } }; // same content, new object
        bot.pathfinder.bestHarvestTool({ name: 'stone' });
        assert.strictEqual(def.calls.length, 1); // content-keyed, not identity-keyed
        bot.entity.effects = { Haste: { id: 3, amplifier: 1 } };
        want = 'haste_1';
        assert.strictEqual(bot.pathfinder.bestHarvestTool({ name: 'stone' }), 'haste_1');
        assert.strictEqual(def.calls.length, 2);
    });

    it('installs once and delegates a null block to the default', () => {
        const bot = mkBot([]);
        const def = recordingDefault((block) => (block ? 'tool' : 'null-block'));
        _wrapBestHarvestToolForTest(bot, def);
        installCachedBestHarvestTool(bot); // second install must not double-wrap
        assert.strictEqual(bot.pathfinder.bestHarvestTool({ name: 'stone' }), 'tool');
        assert.strictEqual(bot.pathfinder.bestHarvestTool(null), 'null-block');
    });

    it('throws without a plugin default to wrap', () => {
        assert.throws(() => installCachedBestHarvestTool({ pathfinder: {} }), /fix114/);
    });
});
