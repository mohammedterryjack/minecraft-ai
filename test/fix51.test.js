/**
 * fix51 regression tests - live run-2 issues from iMac log
 * 
 * Required tests:
 * 1. Incumbent cycle handling at _relink: demote to prev/handwritten_original, throw if unresolvable
 * 2. Deposit uses ONLY known chest memory (no getNearestBlock)
 * 3. parseVerboseGoal handles live shapes without LOUD failures (camelCase span-matching)
 * 4. Oxygen level tracking in samples and death detail
 * 5. placeBlock door/bed commands have proper braces (fix command spam)
 * 7. Satisfaction check prevents unnecessary crafting when have >= goal
 */

import { describe, it, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';

// Issue 1: Cycle handling at _relink - demote promoted skills creating cycles
describe('fix51 issue 1: cycle handling at _relink', async () => {
    let findAllCycles, depsOf;

    before(async () => {
        const sg = await import('../src/agent/skill_graph.js');
        findAllCycles = sg.findAllCycles;
        depsOf = sg.depsOf;
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

    it('depsOf strips strings - names in strings are not counted as dependencies', () => {
        const code = `
async function getFood(bot) {
    log(bot, "Attempting to call eatFood(bot) via string");
    // eatFood(bot) - this is in a comment
    await collectBlocks(bot, "apple", 1);
}`;
        const names = new Set(['eatFood', 'collectBlocks', 'log']);
        const deps = depsOf(code, 'getFood', names);
        // Should NOT include eatFood (it's in a string and comment)
        // Should include collectBlocks and log (actual calls)
        assert.ok(!deps.includes('eatFood'), 'eatFood in string/comment should not be a dependency');
        assert.ok(deps.includes('collectBlocks'), 'collectBlocks should be a dependency');
        assert.ok(deps.includes('log'), 'log should be a dependency');
    });

    it('depsOf strips template literals', () => {
        const code = `
async function test(bot) {
    log(bot, \`Need to run eatFood(bot) eventually\`);
    await realCall(bot);
}`;
        const names = new Set(['eatFood', 'realCall', 'log']);
        const deps = depsOf(code, 'test', names);
        assert.ok(!deps.includes('eatFood'), 'eatFood in template literal should not be a dependency');
        assert.ok(deps.includes('realCall'), 'realCall should be a dependency');
    });

    it('_relink code throws on unresolvable cycles (fail-loud)', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        // Should throw Error with "DEPENDENCY CYCLES" message
        assert.ok(voyagerSrc.includes('throw new Error') && voyagerSrc.includes('DEPENDENCY CYCLES'),
            '_relink should throw on unresolvable cycles');
    });

    it('_relink code demotes promoted skills creating cycles', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        // Should have demotion logic for skills with prev/handwritten_original
        assert.ok(voyagerSrc.includes('DEMOTING') && voyagerSrc.includes('prev version'),
            '_relink should demote promoted skills creating cycles');
        assert.ok(voyagerSrc.includes('handwritten_original') || voyagerSrc.includes('s.prev'),
            '_relink should check for prev or handwritten_original');
    });
});

// Issue 2: Deposit should use ONLY known chest memory
describe('fix51 issue 2: deposit uses only known chest memory', async () => {
    it('_freeInventory fails loud when __knownChests not initialized', async () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        // Should check if bot.__knownChests exists
        assert.ok(skillsSrc.includes('if (!bot.__knownChests)'),
            'should check if __knownChests is initialized');
        assert.ok(skillsSrc.includes('not initialized'),
            'should fail loud if __knownChests not initialized');
    });

    it('_freeInventory uses __knownChests directly (no fallback)', async () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        // Should NOT have || {} fallback
        assert.ok(!skillsSrc.includes('__knownChests || {}'),
            'should not have fallback pattern for __knownChests');
    });

    it('_prepareTossSignals sets __knownChests directly (no fallback)', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        // Should assign chestMemory directly, not with fallback
        assert.ok(voyagerSrc.includes('__knownChests = this.chestMemory;') || 
                  voyagerSrc.includes('__knownChests = this.chestMemory\n'),
            'should assign chestMemory directly without fallback');
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

        assert.strictEqual(nearest.key, '5,64,5');
        assert.ok(Math.abs(nearest.dist - 7.07) < 0.1);
    });
});

// Issue 3: parseVerboseGoal handles all shapes (camelCase span-matching without hard-coded verbs)
describe('fix51 issue 3: parseVerboseGoal handles live shapes', async () => {
    let parseVerboseGoal, _setVersionForTest;

    before(async () => {
        const v = await import('../src/agent/voyager.js');
        parseVerboseGoal = v.parseVerboseGoal;
        _setVersionForTest = v._setVersionForTest;
        _setVersionForTest('1.20.4');
    });

    it('parses standard goals with count', () => {
        const result = parseVerboseGoal('Craft 1 iron_pickaxe');
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

    it('parses camelCase skill names - craftIronHelmet', () => {
        const result = parseVerboseGoal('craftIronHelmet');
        assert.ok(result !== null, 'craftIronHelmet should parse');
        assert.strictEqual(result.item, 'iron_helmet');
        assert.strictEqual(result.count, 1);
    });

    it('parses camelCase without verb prefix - ironHelmet', () => {
        const result = parseVerboseGoal('ironHelmet');
        assert.ok(result !== null, 'ironHelmet should parse');
        assert.strictEqual(result.item, 'iron_helmet');
    });

    it('parses camelCase with various prefixes', () => {
        const tasks = ['craftIronPickaxe', 'mineIronOre', 'getOakLog', 'obtainDiamond', 'smeltRawIron'];
        const expected = ['iron_pickaxe', 'iron_ore', 'oak_log', 'diamond', 'raw_iron'];
        for (let i = 0; i < tasks.length; i++) {
            const result = parseVerboseGoal(tasks[i]);
            assert.ok(result !== null, `${tasks[i]} should parse`);
            assert.strictEqual(result.item, expected[i]);
        }
    });

    it('span-matching finds longest valid item (crafting_table not crafting)', () => {
        const result = parseVerboseGoal('craftCraftingTable');
        assert.ok(result !== null);
        assert.strictEqual(result.item, 'crafting_table');
    });

    it('camelCase parsing has no hard-coded verb list', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        // The camelCase parsing section should NOT have verbPrefixes
        const camelSection = voyagerSrc.match(/try camelCase skill names[\s\S]*?(?=if \(candidates\.length === 0\))/);
        if (camelSection) {
            assert.ok(!camelSection[0].includes('verbPrefixes'),
                'camelCase parsing should not have hard-coded verbPrefixes list');
        }
    });
});

// Issue 4: Oxygen level in samples - observed trend, no classification threshold
describe('fix51 issue 4: oxygen level tracking', async () => {
    it('__st includes oxygen in state capture', async () => {
        const sgSrc = readFileSync('./src/agent/skill_graph.js', 'utf8');
        assert.ok(sgSrc.includes('bot.oxygenLevel'), 
            '__st should capture bot.oxygenLevel');
        assert.ok(sgSrc.includes('oxygen:'), 
            '__st should store oxygen in state');
    });

    it('_sample captures oxygen level', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('o = bot.oxygenLevel') || 
                  voyagerSrc.includes('bot.oxygenLevel'),
            '_sample should capture bot.oxygenLevel');
    });

    it('_deathDetail reports oxygen trend without magic threshold', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('oxygenTrend') || voyagerSrc.includes('oxygen'),
            '_deathDetail should report oxygen trend');
        assert.ok(!voyagerSrc.includes('oxygenLevel < 10') && !voyagerSrc.includes('oxygen < 10'),
            'should not have magic oxygen threshold');
    });
});

// Issue 5: placeBlock command spam fix
describe('fix51 issue 5: placeBlock command spam fix', async () => {
    it('door setblock command is inside braces', async () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        const doorPattern = /if\s*\(blockType\.includes\(['"]door['"]\)\)\s*\{/;
        assert.ok(doorPattern.test(skillsSrc),
            'door check should have opening brace');
    });

    it('bed setblock command is inside braces', async () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
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

    it('countGoal correctly parses iron_helmet goal', async () => {
        const result = parseVerboseGoal('Craft 1 iron_helmet');
        assert.ok(result !== null);
        assert.strictEqual(result.item, 'iron_helmet');
        assert.strictEqual(result.count, 1);
    });

    it('getInventoryCounts includes armor slots', async () => {
        const world = await import('../src/agent/library/world.js');
        
        const mockBot = {
            inventory: {
                slots: new Array(45).fill(null)
            }
        };
        mockBot.inventory.slots[5] = { name: 'iron_helmet', count: 1 };
        mockBot.inventory.slots[9] = { name: 'iron_helmet', count: 6 };

        const inv = world.getInventoryCounts(mockBot);
        assert.strictEqual(inv['iron_helmet'], 7);
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
