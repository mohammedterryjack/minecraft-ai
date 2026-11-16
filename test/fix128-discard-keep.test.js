/**
 * fix128 (live icefox2000, 16 Nov 2026): generated tossSurplusClutterSafe ran
 * discard("raw_iron",5) (log line 77413) and discard("raw_iron",7) (line 98185) and raw_iron
 * hit 0 while smeltFiveRawIron's measured consumeEvidence is 5 and smelting goals were pending
 * — the same evidence that gates idle practice ("would consume scarce", voyager.js) was never
 * wired into the primitive that actually throws items away. fix84/fix92 built keep-reserves
 * (surplusFromConsumption, capacityPlan: "A stack can be emptied only when the rest of that
 * kind still covers its reserve") but only for the plan path. discard() is the chokepoint every
 * free-up code goes through, so the keep-floor lives there: bot.itemKeeps is published per task
 * by Voyager._publishItemKeeps() from verifiedConsumes + pending-goal demand.
 */
import { describe, it, beforeEach } from 'node:test';
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

describe('fix128 discard() respects the published keep-floor', () => {
    it('caps a discard that would cut into the reserve instead of emptying the item', async () => {
        const bot = mkBot({ raw_iron: 7 }, new Map([['raw_iron', 5]]));
        assert.strictEqual(await discard(bot, 'raw_iron', 7), true);
        assert.deepStrictEqual(bot.tossed, [{ name: 'raw_iron', n: 2 }]);
        assert.match(bot.output, /Capping discard of raw_iron to 2/);
    });

    it('refuses outright when everything held is reserved, and names the alternative', async () => {
        const bot = mkBot({ raw_iron: 5 }, new Map([['raw_iron', 5]]));
        assert.strictEqual(await discard(bot, 'raw_iron'), false);
        assert.deepStrictEqual(bot.tossed, []);
        assert.match(bot.output, /FAILED: keeping all 5 raw_iron/);
        assert.match(bot.output, /putInChest/);
    });

    it('unreserved items discard unchanged (no behaviour change without a keep)', async () => {
        const bot = mkBot({ cobblestone: 64 }, new Map([['raw_iron', 5]]));
        assert.strictEqual(await discard(bot, 'cobblestone'), true);
        assert.deepStrictEqual(bot.tossed, [{ name: 'cobblestone', n: 64 }]);
    });
});
