/**
 * fix145 (live icefox2000, 18 Nov 2026): clearInventoryForHoglinDrops failed 11x with
 * "FAILED: keeping all 0 cobblestone: 218 reserved by consumption evidence or pending goals"
 * (mindcraft.log 124110-124112) — the fix128 keep-floor fired even when the bot held ZERO of
 * the item. A reserve cannot protect items that do not exist; the message was false (nothing
 * was reserved because nothing was held), and PSN repair kept patching the caller on the
 * false reservation premise instead of seeing the real state (item absent). discard() with
 * held=0 must take the honest "You do not have any X to discard" path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Registry from 'prismarine-registry';
import { discard } from '../src/agent/library/skills.js';

const registry = Registry('1.20.4');

function mkBot(counts, keeps) {
    const stacks = Object.entries(counts).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id }));
    const bot = {
        registry,
        output: '',
        interrupt_code: false,
        inventory: {
            items: () => stacks.filter((s) => s.count > 0),
            findInventoryItem: (name) => stacks.find((s) => s.name === name && s.count > 0),
        },
        tossed: [],
        async toss(type, _v, n) {
            const st = stacks.find((s) => s.type === type && s.count > 0);
            st.count -= n;
            bot.tossed.push({ name: st.name, n });
        },
    };
    if (keeps) bot.itemKeeps = keeps;
    return bot;
}

describe('fix145 keep-floor must not fire when nothing is held', () => {
    it('held=0 with a reserve reports "nothing to discard", not a reservation failure', async () => {
        const bot = mkBot({ coal: 3 }, new Map([['cobblestone', 218]]));
        assert.strictEqual(await discard(bot, 'cobblestone', 32), false);
        assert.deepStrictEqual(bot.tossed, []);
        assert.match(bot.output, /You do not have any cobblestone to discard/);
        assert.doesNotMatch(bot.output, /reserved/);
        assert.doesNotMatch(bot.output, /FAILED: keeping all 0/);
    });

    it('held=0 for an item absent from the keeps map is unchanged', async () => {
        const bot = mkBot({ coal: 3 }, new Map([['raw_iron', 5]]));
        assert.strictEqual(await discard(bot, 'gravel'), false);
        assert.match(bot.output, /You do not have any gravel to discard/);
    });

    it('held>0 fully reserved still refuses with the reservation message (fix128 intact)', async () => {
        const bot = mkBot({ cobblestone: 10 }, new Map([['cobblestone', 218]]));
        assert.strictEqual(await discard(bot, 'cobblestone'), false);
        assert.match(bot.output, /FAILED: keeping all 10 cobblestone: 218 reserved/);
        assert.match(bot.output, /putInChest/);
    });

    it('held>0 above the reserve still discards only the surplus (fix128 intact)', async () => {
        const bot = mkBot({ cobblestone: 300 }, new Map([['cobblestone', 218]]));
        assert.strictEqual(await discard(bot, 'cobblestone'), true);
        assert.deepStrictEqual(bot.tossed, [{ name: 'cobblestone', n: 82 }]);
        assert.match(bot.output, /Capping discard of cobblestone to 82/);
    });
});
