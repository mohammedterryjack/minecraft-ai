// fix170: Voyager's curriculum proposes the frontier of what is acquirable from the agent's
// current state (Wang et al. 2023, arXiv:2305.16291 §3.1). missingPrerequisites computes that
// frontier as a fixed point over the game registry (hold -> craft -> mine -> smelt). Structure
// -only items (smithing templates) are unreachable from any inventory the bot can assemble and
// must be rejected at intake with a named blocker, not burn 4 attempts. obsidian/diamond are
// NOT blocked: their chains close through craftable tools, which is the correct frontier.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import minecraftData from 'minecraft-data';
import { Voyager } from '../src/agent/voyager.js';

const registry = minecraftData('26.1');
const none = new Set();

describe('fix170: tech-tree frontier gate', () => {
    it('structure-only items are blocked at intake', () => {
        assert.deepEqual(Voyager.missingPrerequisites(registry, 'netherite_upgrade_smithing_template', none), ['netherite_upgrade_smithing_template']);
        assert.deepEqual(Voyager.missingPrerequisites(registry, 'snout_armor_trim_smithing_template', none), ['snout_armor_trim_smithing_template']);
    });
    it('the full tool chain closes: obsidian, diamond and netherite gear are frontier-reachable', () => {
        assert.equal(Voyager.missingPrerequisites(registry, 'obsidian', none), null);
        assert.equal(Voyager.missingPrerequisites(registry, 'diamond', none), null);
        assert.equal(Voyager.missingPrerequisites(registry, 'netherite_pickaxe', none), null);
    });
    it('held items and hand-minable blocks are never blocked', () => {
        for (const item of ['dirt', 'cobblestone', 'oak_log', 'oak_planks', 'stick', 'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'iron_ingot', 'diamond_pickaxe', 'glass_bottle', 'furnace', 'chest'])
            assert.equal(Voyager.missingPrerequisites(registry, item, none), null, `${item} must be frontier-reachable`);
    });
    it('mob loot (no recipe, no block entry) is not blocked', () => {
        for (const item of ['rotten_flesh', 'spider_eye', 'string', 'bone'])
            assert.equal(Voyager.missingPrerequisites(registry, item, none), null, `${item} drops from mobs`);
    });
    it('a leaf with no recipe and no block entry counts as loot, not a blocker', () => {
        const fake = {
            itemsByName: { widget: { id: 1 }, gadget: { id: 2 } },
            blocksByName: {},
            items: { 1: { name: 'widget' }, 2: { name: 'gadget' } },
            recipes: { 1: [{ ingredients: [2], inShape: null }] },
        };
        assert.equal(Voyager.missingPrerequisites(fake, 'widget', none), null);
    });
    it('recipe cycles never pass silently', () => {
        const cyc = {
            itemsByName: { a: { id: 1 }, b: { id: 2 } },
            blocksByName: {},
            items: { 1: { name: 'a' }, 2: { name: 'b' } },
            recipes: { 1: [{ ingredients: [2], inShape: null }], 2: [{ ingredients: [1], inShape: null }] },
        };
        assert.deepEqual(Voyager.missingPrerequisites(cyc, 'a', none), ['a']);
    });
    it('the intake hook calls the gate with held inventory and equipment', () => {
        const src = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.match(src, /Voyager\.missingPrerequisites\(capBot\.registry, g\.item, held\)/);
    });
});
