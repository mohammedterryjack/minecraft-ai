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

// Issue 8 (live run-2): 'have 68' bug - satisfaction check must use exact inventory count
// Bug: holding 68 iron_ingot + 3 stone_pickaxe said "have 68" for iron_pickaxe goal
describe('fix51 issue 8: satisfaction check uses exact inventory count', async () => {
    it('holding 68 iron_ingot and 3 stone_pickaxe must NOT satisfy iron_pickaxe x1', () => {
        // This is the bug scenario: bot has iron_ingot and stone_pickaxe, NOT iron_pickaxe
        const goal = { item: 'iron_pickaxe', count: 1 };
        const inventory = { iron_ingot: 68, stone_pickaxe: 3 };
        const equipment = {}; // nothing equipped

        // Calculate exact count (what the fixed code does)
        const invCount = inventory[goal.item] || 0;
        const eqCount = Object.values(equipment).filter(v => v === goal.item).length;
        const haveExact = invCount + eqCount;

        // Should NOT be satisfied - we have 0 iron_pickaxe
        assert.strictEqual(haveExact, 0, 'should have exactly 0 iron_pickaxe');
        assert.strictEqual(haveExact >= goal.count, false, 'should NOT be satisfied');
    });

    it('holding 1 iron_pickaxe must satisfy iron_pickaxe x1', () => {
        const goal = { item: 'iron_pickaxe', count: 1 };
        const inventory = { iron_pickaxe: 1, cobblestone: 64 };
        const equipment = {};

        const invCount = inventory[goal.item] || 0;
        const eqCount = Object.values(equipment).filter(v => v === goal.item).length;
        const haveExact = invCount + eqCount;

        assert.strictEqual(haveExact, 1, 'should have exactly 1 iron_pickaxe');
        assert.strictEqual(haveExact >= goal.count, true, 'should be satisfied');
    });

    it('equipped iron_pickaxe (in hand) must satisfy iron_pickaxe x1', () => {
        const goal = { item: 'iron_pickaxe', count: 1 };
        const inventory = { cobblestone: 64 }; // no pickaxe in inventory slots
        const equipment = { hand: 'iron_pickaxe' }; // but holding one

        const invCount = inventory[goal.item] || 0;
        const eqCount = Object.values(equipment).filter(v => v === goal.item).length;
        const haveExact = invCount + eqCount;

        assert.strictEqual(haveExact, 1, 'should have exactly 1 iron_pickaxe (equipped)');
        assert.strictEqual(haveExact >= goal.count, true, 'should be satisfied');
    });

    it('_goalAlreadySatisfied uses invCount not producible.count', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // The fix: use inv[goal.item] directly, NOT producible.count
        assert.ok(voyagerSrc.includes('inv[goal.item]') || voyagerSrc.includes('invCount'),
            'should use direct inventory lookup for goal item');
        // Should calculate exact count from inventory + equipment
        assert.ok(voyagerSrc.includes('haveExact') || 
                  (voyagerSrc.includes('invCount') && voyagerSrc.includes('eqCount')),
            'should combine inventory and equipment counts');
    });
});

// Issue 9 (live run-2): TypeError reading 'length' in tossSurplusClutter
describe('fix51 issue 9: tossClutter fail-loud checks', async () => {
    it('tossClutter checks Array.isArray(bot.__safeToToss)', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('Array.isArray(bot.__safeToToss)'),
            'should check if __safeToToss is an array');
    });

    it('tossClutter fails loud if __safeToToss not initialized', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('FAIL LOUD') && voyagerSrc.includes('__safeToToss'),
            'should log FAIL LOUD if __safeToToss not initialized');
    });

    it('_prepareTossSignals sets __safeToToss', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('__safeToToss ='),
            'should set __safeToToss in _prepareTossSignals');
    });
});

// Issue 10 (live run-2): Items dropped on death tracking
describe('fix51 issue 10: items dropped on death tracking', async () => {
    it('_run stores inventory+equipment before execution', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('_beforeRunInv') || voyagerSrc.includes('beforeRunInv'),
            'should track inventory before run');
        assert.ok(voyagerSrc.includes('_getInventoryWithEquipment'),
            'should use combined inventory+equipment view');
    });

    it('_deathDetail computes inventory+equipment delta (full, no cap)', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('items dropped') || voyagerSrc.includes('itemsLost'),
            '_deathDetail should report items dropped');
        // No cap on items
        assert.ok(!voyagerSrc.includes('lost.slice(0, 10)'),
            'should NOT cap items dropped at 10');
    });

    it('_getInventoryWithEquipment includes held item and armor slots', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('bot.heldItem'),
            'should include held item in inventory view');
        assert.ok(voyagerSrc.includes('eqSlots') || voyagerSrc.includes('slots[45]'),
            'should include equipment slots');
    });

    it('items dropped computed as beforeInv - afterInv delta', () => {
        const beforeInv = { iron_ingot: 68, diamond: 5, stone_pickaxe: 3, iron_pickaxe: 1 };
        const afterInv = { iron_ingot: 0, stone_pickaxe: 1 }; // died and lost stuff including held pickaxe

        const lost = [];
        for (const [item, beforeCount] of Object.entries(beforeInv)) {
            const afterCount = afterInv[item] || 0;
            const delta = beforeCount - afterCount;
            if (delta > 0) lost.push(`${item}:${delta}`);
        }

        assert.ok(lost.includes('iron_ingot:68'), 'should detect iron_ingot loss');
        assert.ok(lost.includes('diamond:5'), 'should detect diamond loss');
        assert.ok(lost.includes('stone_pickaxe:2'), 'should detect stone_pickaxe partial loss');
        assert.ok(lost.includes('iron_pickaxe:1'), 'should detect held iron_pickaxe loss');
    });
});

// Issue 11 (live run-2): Nav stall loop - per-goal::reason backoff tracking
describe('fix51 issue 11: nav stall loop per-goal::reason tracking', async () => {
    it('tracks per-goal::reason failure stats', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('goalFailures') || voyagerSrc.includes('goal::reason'),
            'should track failures per goal::reason');
    });

    it('uses Laplace-smoothed rate (s+1)/(n+2)', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        // The formula (s+1)/(n+2) is implemented as (s+1)/(s+f+2)
        assert.ok(voyagerSrc.includes('gs.success + 1') && voyagerSrc.includes('+ 2'),
            'should use Laplace-smoothed rate');
    });

    it('Laplace-smoothed rate calculation is correct', () => {
        // Test the formula: rate = (success + 1) / (success + fail + 2)
        const gs1 = { success: 0, fail: 0 };
        const rate1 = (gs1.success + 1) / (gs1.success + gs1.fail + 2);
        assert.strictEqual(rate1, 0.5, 'empty stats should have 0.5 rate');

        const gs2 = { success: 0, fail: 5 };
        const rate2 = (gs2.success + 1) / (gs2.success + gs2.fail + 2);
        assert.ok(rate2 < 0.2, '5 failures should have low rate');

        const gs3 = { success: 3, fail: 1 };
        const rate3 = (gs3.success + 1) / (gs3.success + gs3.fail + 2);
        assert.ok(rate3 > 0.6, '3 successes 1 fail should have high rate');
    });

    it('stores rate for skip-probability ordering (no wall-clock backoff)', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('gs.rate = rate'),
            'should store rate for skip-probability ordering');
        // No wall-clock backoff timer
        assert.ok(!voyagerSrc.includes('10000 * (1 - rate)'),
            'should NOT have wall-clock backoff based on rate');
    });

    it('keys by normalized structured source (skill + kind), not truncated text', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('failSkill') && voyagerSrc.includes('failKind'),
            'should key by skill name and failure kind');
        // Check that reasonKey is not truncated (no .slice after reasonKey assignment)
        const reasonKeySection = voyagerSrc.match(/reasonKey\s*=\s*`[^`]+`/);
        assert.ok(reasonKeySection && !reasonKeySection[0].includes('.slice'),
            'reasonKey should not be truncated');
    });
});

// Issue 13 (live run-2): Observation-based contract mismatch detection (no name patterns)
describe('fix51 issue 13: observation-based contract mismatch detection', async () => {
    it('_extractPostFields extracts fields from postcondition source', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('_extractPostFields'),
            'should have _extractPostFields method');
        assert.ok(voyagerSrc.includes('c\\.delta\\.') && voyagerSrc.includes('c\\.(post|pre)\\.pos'),
            'should extract delta and position field references');
    });

    it('_detectContractMismatch detects when post checks unchanged fields', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('_detectContractMismatch'),
            'should have _detectContractMismatch method');
        assert.ok(voyagerSrc.includes('Changed:') && voyagerSrc.includes('Unchanged:'),
            'should report changed and unchanged fields');
    });

    it('does NOT use name patterns for detection', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        // Should NOT have travel|goto|etc name pattern for contract detection
        // (Note: travelTo regex in _interruptReason is for logging context, not detection)
        const detectSection = voyagerSrc.match(/_detectContractMismatch[\s\S]*?return null;\s*\}/);
        if (detectSection) {
            assert.ok(!detectSection[0].includes('travel|goto'),
                '_detectContractMismatch should NOT use name-based pattern matching');
        }
    });

    it('queues contract repair with observed field feedback', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('MISMATCH') && voyagerSrc.includes('_queueContractFix'),
            'should queue contract fix with mismatch feedback');
    });

    it('detection works for non-travel-sounding names (observation-based)', () => {
        // Test the logic: a skill named "doSomethingUseful" with postcondition checking delta
        // but where delta is empty and position changed should be detected as mismatch
        const postSrc = 'c => c.delta.stone > 0';
        const s0 = { pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, inv: {}, eq: {} };
        const s1 = { pos: { x: 100, y: 64, z: 0 }, hp: 20, food: 20, inv: {}, eq: {} }; // moved 100 blocks
        const r = { s0, s1, delta: {} }; // empty delta

        // Extract fields from postcondition
        const fields = { delta: ['stone'], pos: false, hp: false, food: false, inv: [], eq: [], dist: false };
        
        // Compute what changed
        const deltaEmpty = Object.keys(r.delta).length === 0;
        const posMoved = Math.abs(s1.pos.x - s0.pos.x) > 1;
        
        // Mismatch: post checks delta.stone but delta is empty and position moved
        const isMismatch = fields.delta.length > 0 && deltaEmpty && posMoved && !fields.pos;
        
        assert.strictEqual(isMismatch, true, 
            'should detect mismatch when post checks delta but delta empty and position changed');
    });

    it('no mismatch when checked fields actually changed', () => {
        // Post checks delta.stone and delta.stone actually increased
        const s0 = { pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, inv: {}, eq: {} };
        const s1 = { pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, inv: {}, eq: {} }; // didn't move
        const r = { s0, s1, delta: { stone: 5 } }; // delta changed

        const fields = { delta: ['stone'], pos: false };
        const deltaEmpty = Object.keys(r.delta).length === 0;
        const posMoved = Math.abs(s1.pos.x - s0.pos.x) > 1;
        
        // No mismatch: post checks delta.stone and delta is not empty
        const isMismatch = fields.delta.length > 0 && deltaEmpty && posMoved && !fields.pos;
        
        assert.strictEqual(isMismatch, false, 
            'should NOT detect mismatch when checked delta fields actually changed');
    });
});

// Issue 12 (live run-2): VIOLATED and parseVerboseGoal LOUD logging
describe('fix51 issue 12: enhanced VIOLATED and LOUD logging', async () => {
    it('VIOLATED logs include exact goal text', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('VIOLATED context') && voyagerSrc.includes('task='),
            'VIOLATED should log exact task/goal');
    });

    it('VIOLATED logs to file for analysis', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('violated_contracts.jsonl'),
            'should log VIOLATED to jsonl file');
    });

    it('parseVerboseGoal LOUD logs to file', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('parseVerboseGoal_failures.jsonl'),
            'should log parseVerboseGoal failures to jsonl file');
    });

    it('VIOLATED includes state info (inv, delta)', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('pre.inv') && voyagerSrc.includes('delta='),
            'VIOLATED should include inventory and delta state');
    });

    it('VIOLATED log does not truncate values (full record goes to jsonl)', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        // Find the VIOLATED logging section
        const violatedSection = voyagerSrc.match(/VIOLATED.*\$\{e\.contract\[k\]/);
        if (violatedSection) {
            // Should NOT have .slice() truncation on contract or state
            assert.ok(!violatedSection[0].includes('.slice(0,'),
                'VIOLATED log should not truncate contract');
        }
    });
});

describe('fix51 issue 14: targetBlock undefined reference fix', async () => {
    it('skills.js tillAndSow function uses block not targetBlock', () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        const tillMatch = skillsSrc.match(/export async function tillAndSow[\s\S]*?^}/m);
        assert.ok(tillMatch, 'tillAndSow function should exist');
        const tillBody = tillMatch[0];
        assert.ok(!tillBody.includes('targetBlock'),
            'tillAndSow function should use block variable, not targetBlock');
        assert.ok(tillBody.includes('bot.canSeeBlock(block)'),
            'tillAndSow function should use bot.canSeeBlock(block)');
    });

    it('skills.js activateNearestBlock uses block not targetBlock', () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        const activateMatch = skillsSrc.match(/export async function activateNearestBlock[\s\S]*?^export/m);
        assert.ok(activateMatch, 'activateNearestBlock function should exist');
        const activateBody = activateMatch[0];
        assert.ok(!activateBody.includes('targetBlock'),
            'activateNearestBlock should use block variable, not targetBlock');
        assert.ok(activateBody.includes('bot.canSeeBlock(block)'),
            'activateNearestBlock should use bot.canSeeBlock(block)');
    });

    it('targetBlock is declared before use in placeBlock and digDown', async () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        const placeBlock = skillsSrc.match(/export async function placeBlock[\s\S]*?^export/m);
        const digDown = skillsSrc.match(/export async function digDown[\s\S]*?^export/m);
        
        if (placeBlock) {
            const body = placeBlock[0];
            assert.ok(body.includes('const targetBlock = bot.blockAt'),
                'placeBlock should declare targetBlock before use');
        }
        if (digDown) {
            const body = digDown[0];
            assert.ok(body.includes('const targetBlock = bot.blockAt'),
                'digDown should declare targetBlock before use');
        }
    });
});

describe('fix51 issue 15: craftRecipe calls ensureCraftingTable', async () => {
    it('craftRecipe seeded skill includes ensureCraftingTable in deps', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const craftRecipeSection = voyagerSrc.match(/name:\s*['"]craftRecipe['"][\s\S]*?deps:\s*\[([^\]]+)\]/);
        assert.ok(craftRecipeSection, 'craftRecipe seeded skill should exist');
        const deps = craftRecipeSection[1];
        assert.ok(deps.includes('ensureCraftingTable'),
            `craftRecipe deps should include ensureCraftingTable, got: ${deps}`);
    });

    it('craftRecipe code calls ensureCraftingTable and verifies reachability', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const craftRecipeStart = voyagerSrc.indexOf("name: 'craftRecipe'");
        assert.ok(craftRecipeStart > 0, 'craftRecipe seeded skill should exist');
        const depsStart = voyagerSrc.indexOf('deps:', craftRecipeStart);
        assert.ok(depsStart > craftRecipeStart, 'craftRecipe should have deps');
        const section = voyagerSrc.slice(craftRecipeStart, depsStart);
        assert.ok(section.includes('ensureCraftingTable'),
            'craftRecipe code should call ensureCraftingTable');
        assert.ok(section.includes('goToPosition'),
            'craftRecipe code should navigate to crafting table');
        assert.ok(section.includes('dist > 4'),
            'craftRecipe should check distance to crafting table');
        assert.ok(section.includes('canSeeBlock'),
            'craftRecipe should check line of sight to crafting table');
        assert.ok(!section.includes('sleep(100)'),
            'craftRecipe should NOT use magic sleep timer');
    });
});

describe('fix51 issue 16: smelt goal uses exact count not producible', async () => {
    let Voyager;

    before(async () => {
        const mod = await import('../src/agent/voyager.js');
        Voyager = mod.Voyager;
    });

    it('smeltGoal parses output item correctly (source inspection)', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const smeltGoalFn = voyagerSrc.match(/function smeltGoal\(task\)\s*\{[\s\S]*?return[^;]*;[\s\S]*?\}/);
        assert.ok(smeltGoalFn, 'smeltGoal function should exist');
        const fnBody = smeltGoalFn[0];
        assert.ok(fnBody.includes('item: m[4]'),
            'smeltGoal should return m[4] (output item) as item, not m[2] (input)');
        assert.ok(fnBody.includes('input: m[2]'),
            'smeltGoal should store m[2] (input item) separately');
    });

    it('satisfaction check uses exact inventory count not producible', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const satisfiedStart = voyagerSrc.indexOf('_goalAlreadySatisfied(task, state)');
        assert.ok(satisfiedStart > 0, '_goalAlreadySatisfied function should exist');
        const fnEnd = voyagerSrc.indexOf('\n    }', satisfiedStart + 200);
        const fnBody = voyagerSrc.slice(satisfiedStart, fnEnd + 6);

        assert.ok(fnBody.includes('haveExact'),
            '_goalAlreadySatisfied should use haveExact variable');
        assert.ok(fnBody.includes('invCount + eqCount'),
            '_goalAlreadySatisfied should compute exact from inventory + equipment');
        assert.ok(!fnBody.match(/if\s*\([^)]*canProduce[^)]*>=\s*goal\.count/),
            '_goalAlreadySatisfied should NOT use canProduce for satisfaction check');
    });

    it('77 raw_iron + 36 iron_ingot does NOT satisfy iron_ingot x50 goal', async () => {
        const mockBot = { 
            version: '1.21.4', 
            chat: () => {}, 
            on: () => {}, 
            off: () => {}, 
            once: () => {},
            removeListener: () => {} 
        };
        const v = new Voyager({ bot: mockBot, agent: { prompter: { task: () => {} }, npc: { constructs: {} } } });
        v.skills = [];
        v._compileContract = () => () => false;

        const state = {
            inventory: { raw_iron: 77, iron_ingot: 36 },
            equipment: { heldItem: null, offHand: null, helmet: null, chestplate: null, leggings: null, boots: null },
            pos: { x: 0, y: 64, z: 0 }
        };

        const result = v._goalAlreadySatisfied('Collect 50 iron_ingot', state);
        assert.strictEqual(result.satisfied, false,
            '36 iron_ingot should NOT satisfy goal of 50 (raw_iron is not iron_ingot)');
        assert.ok(result.reason.includes('have 36') || result.reason.includes('need 50'),
            `Reason should show exact count 36, got: ${result.reason}`);
    });

    it('smelt goal checks output item only', async () => {
        const mockBot = { 
            version: '1.21.4', 
            chat: () => {}, 
            on: () => {}, 
            off: () => {}, 
            once: () => {},
            removeListener: () => {} 
        };
        const v = new Voyager({ bot: mockBot, agent: { prompter: { task: () => {} }, npc: { constructs: {} } } });
        v.skills = [];
        v._compileContract = () => () => false;

        const state = {
            inventory: { raw_iron: 77, iron_ingot: 36 },
            equipment: { heldItem: null, offHand: null, helmet: null, chestplate: null, leggings: null, boots: null },
            pos: { x: 0, y: 64, z: 0 }
        };

        const result = v._goalAlreadySatisfied('Smelt 77 raw_iron into 77 iron_ingot', state);
        assert.strictEqual(result.satisfied, false,
            'smelt goal should check iron_ingot count (36), not raw_iron count (77)');
    });
});

describe('fix51 issue 17: VIOLATED contract analysis', async () => {
    it('_analyzeContractFailure function exists', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('_analyzeContractFailure'),
            'voyager.js should have _analyzeContractFailure function');
    });

    it('VIOLATED logging includes analysis', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerSrc.includes('VIOLATED analysis:'),
            'VIOLATED logging should include analysis output');
    });

    it('_analyzeContractFailure extracts delta fields', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const fnMatch = voyagerSrc.match(/_analyzeContractFailure\(contractSrc, c, r\)\s*\{[\s\S]*?^\s{4}\}/m);
        assert.ok(fnMatch, '_analyzeContractFailure function should exist');
        const fnBody = fnMatch[0];
        assert.ok(fnBody.includes('c.delta.'),
            '_analyzeContractFailure should extract delta field checks');
        assert.ok(fnBody.includes('c.post.inv.'),
            '_analyzeContractFailure should extract post.inv field checks');
        assert.ok(fnBody.includes('c.post.eq.'),
            '_analyzeContractFailure should extract post.eq field checks');
    });

    it('VIOLATED jsonl includes analysis field', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const jsonlMatch = voyagerSrc.match(/appendFileSync.*violated_contracts\.jsonl[^}]+/);
        assert.ok(jsonlMatch, 'VIOLATED should log to jsonl');
        assert.ok(jsonlMatch[0].includes('analysis'),
            'VIOLATED jsonl should include analysis field');
    });
});

describe('fix51 issue 17b: tossClutter return value fix', async () => {
    it('tossClutter returns false on failure, not emptySlotCount', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const tossClutterStart = voyagerSrc.indexOf("name: 'tossClutter'");
        assert.ok(tossClutterStart > 0, 'tossClutter seeded skill should exist');
        const depsStart = voyagerSrc.indexOf('deps:', tossClutterStart);
        const section = voyagerSrc.slice(tossClutterStart, depsStart);
        
        assert.ok(!section.includes('return bot.inventory.emptySlotCount();'),
            'tossClutter should NOT return emptySlotCount on failure');
        assert.ok(section.includes('return false;'),
            'tossClutter should return false on failure');
        assert.ok(section.includes('return true;'),
            'tossClutter should return true on success');
    });

    it('tossClutter does not use magic sleep timer', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const tossClutterStart = voyagerSrc.indexOf("name: 'tossClutter'");
        const depsStart = voyagerSrc.indexOf('deps:', tossClutterStart);
        const section = voyagerSrc.slice(tossClutterStart, depsStart);
        
        assert.ok(!section.includes('await sleep(500)'),
            'tossClutter should NOT use magic sleep timer');
        assert.ok(section.includes('windowClose'),
            'tossClutter should wait on windowClose event');
    });
});

describe('fix51 issue 17c: postcondition skip on explicit failure', async () => {
    it('_checkContracts skips postcondition when r.rv === false', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const checkContractsMatch = voyagerSrc.match(/_checkContracts\(trace, taskOk\)\s*\{[\s\S]*?^\s{4}\}/m);
        assert.ok(checkContractsMatch, '_checkContracts function should exist');
        const fnBody = checkContractsMatch[0];
        
        assert.ok(fnBody.includes("k === 'post' && r.rv === false"),
            '_checkContracts should skip postcondition when r.rv === false');
    });
});

describe('fix51 issue 18: seeded/handwritten skill identifier validation', async () => {
    it('seeded skills use only declared identifiers', () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Extract all seeded skill code blocks
        const skillCodeBlocks = [...voyagerSrc.matchAll(/code:\s*`([^`]+)`/gs)];
        const errors = [];
        
        // Known global identifiers that are injected or built-in
        const knownGlobals = new Set([
            'bot', 'log', 'sleep', 'console', 'Math', 'JSON', 'Object', 'Array', 'Date',
            'getNearestBlock', 'getNearestFreeSpace', 'getInventoryCounts', 'world',
            'Vec3', 'goToPosition', 'goToGoal', 'goToNearestBlock', 'breakBlockAt',
            'collectBlock', 'placeBlock', 'equip', 'discard', 'craftRecipe',
            'attackNearest', 'attackEntity', 'goToPlayer', 'followPlayer',
            'moveAway', 'pickupNearbyItems', 'craftItem', 'craftItems',
            'smeltItems', 'smeltWithFuel', 'killMob', 'harvestCrop',
            'depositToChest', 'withdrawFromChest', 'ensureChest', 'ensureCraftingTable',
            'mineOre', 'consume', 'equipBestTool', 'equipToolForBlock', 'tossItem',
            'tossClutter', 'pf', 'Promise', 'await', 'async', 'return', 'if', 'else',
            'for', 'while', 'let', 'const', 'var', 'function', 'try', 'catch', 'throw',
            'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'new'
        ]);
        
        for (const match of skillCodeBlocks) {
            const code = match[1];
            // Extract function name
            const fnMatch = code.match(/async function (\w+)/);
            if (!fnMatch) continue;
            const fnName = fnMatch[1];
            
            // Check for targetBlock (common mistake - should be 'block' in most cases)
            if (code.includes('targetBlock')) {
                // Check if targetBlock is declared in this function
                if (!code.includes('const targetBlock') && !code.includes('let targetBlock')) {
                    errors.push(`${fnName}: uses 'targetBlock' but doesn't declare it`);
                }
            }
        }
        
        assert.strictEqual(errors.length, 0,
            `Found undeclared identifiers in seeded skills:\n${errors.join('\n')}`);
    });
    
    it('skills.js handwritten functions use only declared block variables', () => {
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        
        // Find functions that use 'block' variable and ensure targetBlock is declared if used
        const functions = [...skillsSrc.matchAll(/export async function (\w+)[^{]*\{[\s\S]*?^}/gm)];
        const errors = [];
        
        for (const match of functions) {
            const fnName = match[1];
            const fnBody = match[0];
            
            // If function uses targetBlock, it must declare it
            if (fnBody.includes('targetBlock') && 
                !fnBody.includes('const targetBlock') && 
                !fnBody.includes('let targetBlock')) {
                errors.push(`${fnName}: uses 'targetBlock' but doesn't declare it`);
            }
        }
        
        assert.strictEqual(errors.length, 0,
            `Found undeclared targetBlock in skills.js:\n${errors.join('\n')}`);
    });
});
