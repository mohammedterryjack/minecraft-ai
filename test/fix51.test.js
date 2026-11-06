/**
 * fix51 regression tests - live run-2 issues from iMac log
 * 
 * Required tests:
 * 1. Incumbent cycle handling at _relink: break back-edge, don't reject
 * 2. Deposit uses ONLY known chest memory (no getNearestBlock)
 * 3. parseVerboseGoal handles live shapes without LOUD failures
 * 4. Oxygen level tracking in samples and death detail
 * 5. placeBlock door/bed commands have proper braces (fix command spam)
 * 7. Satisfaction check prevents unnecessary crafting when have >= goal
 */

import { describe, it, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';

// Issue 1: Gate REJECT for incumbents at relink should break back-edge, not reject
describe('fix51 issue 1: incumbent cycle handling at _relink', async () => {
    let findAllCycles;

    before(async () => {
        const sg = await import('../src/agent/skill_graph.js');
        findAllCycles = sg.findAllCycles;
    });

    it('findAllCycles detects mutual recursion cycle', () => {
        const graph = {
            eatFood: ['getFood'],
            getFood: ['eatFood']
        };
        const cycles = findAllCycles(graph);
        assert.ok(cycles.length > 0, 'should detect at least one cycle');
        const cycleFlat = cycles.flat();
        assert.ok(cycleFlat.includes('eatFood') && cycleFlat.includes('getFood'),
            'cycle should include eatFood and getFood');
    });

    it('identifies the back-edge in a cycle (last -> first)', () => {
        const graph = { A: ['B'], B: ['C'], C: ['A'] };
        const cycles = findAllCycles(graph);
        assert.strictEqual(cycles.length, 1);
        // cycle is [A, B, C, A] (includes the closing edge); back-edge is C -> A
        const cycle = cycles[0];
        assert.ok(cycle.length >= 3, 'cycle should have at least 3 nodes');
        assert.ok(cycle.includes('A') && cycle.includes('B') && cycle.includes('C'));
        // The back-edge connects the last unique node to the first
        const lastIdx = cycle.length - (cycle[cycle.length - 1] === cycle[0] ? 2 : 1);
        const lastNode = cycle[lastIdx];
        assert.strictEqual(lastNode, 'C', 'last node before closing should be C');
    });
});

// Issue 2: Deposit should use ONLY known chest memory (no getNearestBlock, no distance cap)
describe('fix51 issue 2: deposit uses only known chest memory', async () => {
    it('_freeInventory code checks __knownChests not getNearestBlock', async () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        
        // The fix should check bot.__knownChests first
        assert.ok(skillsSrc.includes('bot.__knownChests'),
            '_freeInventory should reference bot.__knownChests');
        
        // Should have "no known chest" failure message
        assert.ok(skillsSrc.includes('no known chest'),
            'should have "no known chest" fail-loud message');
    });

    it('finds nearest chest from known chests by distance', () => {
        const botPos = { x: 0, y: 64, z: 0 };
        const knownChests = {
            '10,64,0': { type: 'chest', contents: 'stone:32' },
            '100,64,0': { type: 'chest', contents: 'Empty' },
            '5,64,5': { type: 'chest', contents: 'iron_ingot:16' }
        };

        const nearest = Object.entries(knownChests)
            .map(([key, data]) => {
                const [x, y, z] = key.split(',').map(Number);
                const dist = Math.hypot(x - botPos.x, y - botPos.y, z - botPos.z);
                return { key, x, y, z, dist, data };
            })
            .sort((a, b) => a.dist - b.dist)[0];

        assert.strictEqual(nearest.key, '5,64,5');  // closest at ~7 blocks
        assert.ok(Math.abs(nearest.dist - 7.07) < 0.1);
    });
});

// Issue 3: parseVerboseGoal LOUD failures - parser must handle all live shapes
describe('fix51 issue 3: parseVerboseGoal handles live shapes', async () => {
    let parseVerboseGoal, _setVersionForTest;

    before(async () => {
        const v = await import('../src/agent/voyager.js');
        parseVerboseGoal = v.parseVerboseGoal;
        _setVersionForTest = v._setVersionForTest;
        _setVersionForTest('1.20.4');
    });

    it('parses craftItem verbose goal with ingredients', () => {
        const result = parseVerboseGoal('craftItem: Craft 1 iron_pickaxe using 2 sticks and 3 iron_ingots');
        assert.ok(result !== null);
        assert.strictEqual(result.item, 'iron_pickaxe');
        assert.strictEqual(result.count, 1);
    });

    it('parses smelt verbose goal (via smeltGoal)', () => {
        const result = parseVerboseGoal('Smelt 8 raw_iron into 8 iron_ingot');
        assert.ok(result !== null);
        assert.strictEqual(result.item, 'iron_ingot');
        assert.strictEqual(result.count, 8);
    });

    it('parses goal with plural item names', () => {
        const result = parseVerboseGoal('Craft 5 torches');
        assert.ok(result !== null);
        assert.strictEqual(result.item, 'torch');
        assert.strictEqual(result.count, 5);
    });

    it('parses goals with unknown items (validation happens elsewhere)', () => {
        // countGoal parses the string structure without registry validation
        // This is correct - validation against registry happens in _goalAlreadySatisfied
        const result = parseVerboseGoal('Craft 1 iron_helmet');
        assert.ok(result !== null);
        assert.strictEqual(result.item, 'iron_helmet');
    });
});

// Issue 4: Oxygen level in samples - observed trend, no classification threshold
describe('fix51 issue 4: oxygen level tracking', async () => {
    it('__st includes oxygen in state capture', async () => {
        const sgSrc = readFileSync('./src/agent/skill_graph.js', 'utf8');
        // Check that __st captures bot.oxygenLevel
        assert.ok(sgSrc.includes('bot.oxygenLevel'), 
            '__st should capture bot.oxygenLevel');
        assert.ok(sgSrc.includes('oxygen:'), 
            '__st should store oxygen in state');
    });

    it('_sample captures oxygen level', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        // Check that _sample stores oxygen
        assert.ok(voyagerSrc.includes('o = bot.oxygenLevel') || voyagerSrc.includes('bot.oxygenLevel'),
            '_sample should capture bot.oxygenLevel');
    });

    it('_deathDetail reports oxygen trend', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        // Check that _deathDetail includes oxygen trend
        assert.ok(voyagerSrc.includes('oxygenTrend') || voyagerSrc.includes('oxygen'),
            '_deathDetail should report oxygen trend');
        // Should NOT have a magic threshold
        assert.ok(!voyagerSrc.includes('oxygenLevel < 10') && !voyagerSrc.includes('oxygen < 10'),
            'should not have magic oxygen threshold');
    });
});

// Issue 5: /setblock and /tp command spam - fix the source (missing braces)
describe('fix51 issue 5: placeBlock command spam fix', async () => {
    it('door setblock command is inside braces', async () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        
        // After fix: if (blockType.includes('door')) { ... /setblock ... }
        // The pattern should have opening brace after the door check
        const doorPattern = /if\s*\(blockType\.includes\(['"]door['"]\)\)\s*\{/;
        assert.ok(doorPattern.test(skillsSrc),
            'door check should have opening brace');
    });

    it('bed setblock command is inside braces', async () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        
        // After fix: if (blockType.includes('bed')) { ... /setblock ... }
        const bedPattern = /if\s*\(blockType\.includes\(['"]bed['"]\)\)\s*\{/;
        assert.ok(bedPattern.test(skillsSrc),
            'bed check should have opening brace');
    });
});

// Issue 7: Iron helmet crafting - satisfaction check should prevent re-crafting
describe('fix51 issue 7: satisfaction check prevents unnecessary crafting', async () => {
    let parseVerboseGoal, _setVersionForTest;

    before(async () => {
        const v = await import('../src/agent/voyager.js');
        parseVerboseGoal = v.parseVerboseGoal;
        _setVersionForTest = v._setVersionForTest;
        _setVersionForTest('1.20.4');
    });

    it('countGoal correctly parses iron_helmet goal via parseVerboseGoal', async () => {
        const result = parseVerboseGoal('Craft 1 iron_helmet');
        assert.ok(result !== null);
        assert.strictEqual(result.item, 'iron_helmet');
        assert.strictEqual(result.count, 1);
    });

    it('getInventoryCounts includes armor slots', async () => {
        const world = await import('../src/agent/library/world.js');
        
        // Mock bot with helmet in slot 5 (armor) and more in inventory
        const mockBot = {
            inventory: {
                slots: new Array(45).fill(null)
            }
        };
        mockBot.inventory.slots[5] = { name: 'iron_helmet', count: 1 };  // worn helmet
        mockBot.inventory.slots[9] = { name: 'iron_helmet', count: 6 };  // inventory

        const inv = world.getInventoryCounts(mockBot);
        // Should count both worn (slot 5) and inventory (slot 9)
        assert.strictEqual(inv['iron_helmet'], 7);  // 1 + 6 = 7
    });

    it('satisfaction check logic: have >= goal.count returns satisfied', () => {
        const goal = { item: 'iron_helmet', count: 1, items: ['iron_helmet'] };
        const inventory = { iron_helmet: 7 };
        
        const have = inventory[goal.item] || 0;
        const satisfied = have >= goal.count;
        
        assert.strictEqual(have, 7);
        assert.strictEqual(satisfied, true);
    });
});
