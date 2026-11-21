/**
 * fix156: "no inventory tool can harvest stone" was a dead-end error — 17x in one post-fix155
 * window while the bot sat on oak logs and never crafted the pickaxe the block needs. The seeded
 * primitive equipToolForBlock (voyager.js:9446 seeds skills.equipToolForBlock.toString()) must
 * name the registry-required tools cheapest-tier first and point at skills.craftItem, the entry
 * point that gathers its own ingredients (actionable-error precedent: the shelter failure
 * recommending !gatherUntil).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { equipToolForBlock } from '../src/agent/library/skills.js';

// cobblestone harvestTools from the 26.1 registry (ids, all pickaxe tiers)
const PICKAXES = {
    458: { id: 458, name: 'wooden_pickaxe' },
    484: { id: 484, name: 'stone_pickaxe' },
    510: { id: 510, name: 'iron_pickaxe' },
    602: { id: 602, name: 'diamond_pickaxe' },
    772: { id: 772, name: 'netherite_pickaxe' },
    471: { id: 471, name: 'golden_pickaxe' },
};
const SPEEDS = { 458: 2, 471: 3, 484: 4, 510: 6, 602: 8, 772: 9 }; // mineable/pickaxe table

function makeBot() {
    return {
        output: '', // the library log() appends here (skills.js:39)
        food: 20,
        health: 20,
        inventory: { items: () => [] }, // oak logs only would still be filtered: no pickaxe
        heldItem: null,
        registry: {
            items: PICKAXES,
            materials: { 'mineable/pickaxe': SPEEDS },
            blocksArray: [],
        },
        unequip: async () => {},
        equip: async () => {},
    };
}
const cobble = {
    name: 'cobblestone',
    diggable: true,
    material: 'mineable/pickaxe',
    harvestTools: Object.fromEntries(Object.keys(SPEEDS).map((id) => [id, true])),
};

describe('fix156: harvest refusal names the required tool and the craft entry point', () => {
    it('refusal lists every registry harvestTool slowest-dig (cheapest tier) first', async () => {
        const bot = makeBot();
        const res = await equipToolForBlock(bot, cobble);
        assert.strictEqual(res, null);
        const msg = bot.output.trim();
        assert.ok(msg.startsWith('FAILED: no inventory tool can harvest cobblestone'), msg);
        for (const p of Object.values(PICKAXES)) assert.ok(msg.includes(p.name), `${p.name} missing from: ${msg}`);
        assert.ok(msg.indexOf('wooden_pickaxe') < msg.indexOf('stone_pickaxe'), 'cheapest tier must be listed first: ' + msg);
        assert.ok(msg.includes('craftItem(bot, "wooden_pickaxe")'), `craft entry point missing: ${msg}`);
        assert.ok(!msg.includes('skills.craftItem'), 'seeded code must stay bare-name (fix47/fix50 gate)');
    });
    it('still returns null without the hint branch when the block needs no tool', async () => {
        const bot = makeBot();
        const dirt = { name: 'dirt', diggable: true, material: 'mineable/shovel', harvestTools: undefined };
        assert.strictEqual(await equipToolForBlock(bot, dirt), null);
        assert.strictEqual(bot.output, '', 'no-harvest-tool dirt must stay silent');
    });
});
