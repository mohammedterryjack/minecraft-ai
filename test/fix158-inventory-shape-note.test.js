/**
 * fix158: the lint gate kept rejecting hallucinated `bot.inventory.find` (mindcraft.log
 * "API gate: bot.inventory.find does not exist (closest real members: ...)" 21 Nov, twice in
 * one 800-line window) — the fix155 API_SHAPE_NOTES covered bot.entities as a map but said
 * nothing about bot.inventory being an Inventory object (prismarine-windows: items()/slots()/
 * withSlots()/firstEmptySlot()), so the model kept treating it as an array.
 * The note must name the real call shape, and must not itself cite an API that doesn't exist
 * (an earlier draft said countItem(bot, name) — no such bare skill; caught in review).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { API_SHAPE_NOTES } from '../src/agent/prompt_cut.js';
import * as skills from '../src/agent/library/skills.js';

describe('fix158: API_SHAPE_NOTES covers bot.inventory shape', () => {
    it('states inventory is an object not an array and names items()', () => {
        assert.match(API_SHAPE_NOTES, /bot\.inventory is an Inventory object, NOT an array/);
        assert.match(API_SHAPE_NOTES, /bot\.inventory\.find\/filter\/map is not a function/);
        assert.match(API_SHAPE_NOTES, /bot\.inventory\.items\(\)/);
    });
    it('only cites APIs that exist (no invented bare skills)', async () => {
        const world = await import('../src/agent/library/world.js');
        const cited = API_SHAPE_NOTES.match(/\b(getNearestBlocks|getNearbyBlockTypes|getNearbyEntities|getNearestEntityWhere|countItem|craftItem)\(/g) ?? [];
        for (const ref of cited) {
            const name = ref.replace('(', '');
            const fn = skills[name] ?? world[name];
            assert.strictEqual(typeof fn, 'function', `API_SHAPE_NOTES cites ${name} but neither skills.js nor world.js exports it`);
        }
    });
    it('Inventory members cited are real in the installed prismarine-windows', async () => {
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        const windows = require('prismarine-windows')('1.20.4');
        const inv = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
        for (const m of ['items', 'count', 'findInventoryItem', 'firstEmptySlotRange']) {
            assert.strictEqual(typeof inv[m], 'function', `inventory.${m} is not a function`);
        }
    });
});
