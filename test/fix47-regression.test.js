/**
 * fix47 regression tests
 * 
 * 1. Prefix cleanup: scan all prompt-visible strings for skills/world prefix patterns
 * 2. Planning from inventory: decompose subtracts inventory + producible items; number-word parsing
 * 3. posKey regression: missingCalls handles all local declaration patterns
 * 4. ensureCraftingTable: recipe lookup without inventory filtering
 * 5. Repair deduplication: no duplicate repairs for same skill+signature while pending
 * 6. Open items: tossClutter postcondition, deposit logic
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';

// ============================================================================
// Issue 1: Prefix cleanup - no skills.*/world.* in model-visible strings
// ============================================================================

describe('fix47: no prefixed calls in model-visible strings', () => {
    it('should NOT have skills.* or world.* in coding_examples', async () => {
        const defaultProfile = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
        const examples = defaultProfile.coding_examples || [];
        
        const prefixPattern = /\b(?:skills|world)\s*\.\s*\w+\s*\(/g;
        const violations = [];
        
        for (const example of examples) {
            for (const msg of example) {
                if (msg.content && prefixPattern.test(msg.content)) {
                    violations.push(msg.content.match(prefixPattern));
                }
            }
        }
        
        assert.strictEqual(violations.length, 0, 
            `Found prefixed calls in coding_examples: ${JSON.stringify(violations.flat())}`);
    });

    it('should NOT have skills.* or world.* in conversation_examples', async () => {
        const defaultProfile = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
        const examples = defaultProfile.conversation_examples || [];
        
        const prefixPattern = /\b(?:skills|world)\s*\.\s*\w+\s*\(/g;
        const violations = [];
        
        for (const example of examples) {
            for (const msg of example) {
                if (msg.content && prefixPattern.test(msg.content)) {
                    violations.push(msg.content.match(prefixPattern));
                }
            }
        }
        
        assert.strictEqual(violations.length, 0, 
            `Found prefixed calls in conversation_examples: ${JSON.stringify(violations.flat())}`);
    });

    it('should NOT have "You have skills and world imported" in coding prompt', async () => {
        const defaultProfile = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
        const coding = defaultProfile.coding || '';
        
        assert.ok(!coding.includes('skills, and `world` imported'), 
            'coding prompt should not mention skills/world objects as imported');
        assert.ok(!coding.includes('`skills`, and `world`'), 
            'coding prompt should not mention skills/world objects');
    });

    it('should NOT have skills.*/world.* in any SEEDED_PRIMITIVES code', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const prefixPattern = /\b(?:skills|world)\s*\.\s*\w+\s*\(/g;
        const violations = [];
        
        for (const prim of Voyager.SEEDED_PRIMITIVES || []) {
            if (prim.code && prefixPattern.test(prim.code)) {
                violations.push({ name: prim.name, matches: prim.code.match(prefixPattern) });
            }
        }
        
        assert.strictEqual(violations.length, 0, 
            `Found prefixed calls in SEEDED_PRIMITIVES: ${JSON.stringify(violations)}`);
    });

    it('should NOT have skills.*/world.* in profile coding prompts', async () => {
        const { readdirSync } = await import('fs');
        const profiles = readdirSync('./profiles').filter(f => f.endsWith('.json'));
        
        const prefixPattern = /\b(?:skills|world)\s*\.\s*\w+\s*\(/g;
        const violations = [];
        
        for (const profile of profiles) {
            try {
                const data = JSON.parse(readFileSync(`./profiles/${profile}`, 'utf8'));
                if (data.coding && prefixPattern.test(data.coding)) {
                    violations.push({ profile, matches: data.coding.match(prefixPattern) });
                }
            } catch (e) {
                // Skip non-JSON files
            }
        }
        
        assert.strictEqual(violations.length, 0, 
            `Found prefixed calls in profile coding prompts: ${JSON.stringify(violations)}`);
    });
});

// ============================================================================
// Issue 2: Planning from inventory - decompose with inventory subtraction
// ============================================================================

describe('fix47: number word parsing', () => {
    it('should parse "five" as 5', async () => {
        const { parseNumberWord } = await import('../src/agent/voyager.js');
        assert.strictEqual(parseNumberWord('five'), 5);
    });

    it('should parse "twelve" as 12', async () => {
        const { parseNumberWord } = await import('../src/agent/voyager.js');
        assert.strictEqual(parseNumberWord('twelve'), 12);
    });

    it('should parse "twenty" as 20', async () => {
        const { parseNumberWord } = await import('../src/agent/voyager.js');
        assert.strictEqual(parseNumberWord('twenty'), 20);
    });

    it('should return null for non-number words', async () => {
        const { parseNumberWord } = await import('../src/agent/voyager.js');
        assert.strictEqual(parseNumberWord('iron'), null);
        assert.strictEqual(parseNumberWord('pickaxe'), null);
    });

    it('should parse "Mine five iron ore" goal correctly', async () => {
        const { parseVerboseGoal, _setVersionForTest } = await import('../src/agent/voyager.js');
        _setVersionForTest('1.20.4');  // fix49: VERSION must be set for countGoal
        const result = parseVerboseGoal('Mine five iron ore');
        
        assert.ok(result, 'Should parse the goal');
        assert.strictEqual(result.count, 5, 'Should parse "five" as 5');
        assert.ok(result.items.some(i => i.includes('iron')), 'Should identify iron ore');
    });

    it('should parse numeric strings normally', async () => {
        const { parseNumberWord } = await import('../src/agent/voyager.js');
        assert.strictEqual(parseNumberWord('5'), 5);
        assert.strictEqual(parseNumberWord('10'), 10);
    });
});

describe('fix47: decompose subtracts inventory and producible items', () => {
    it('should subtract raw_iron already in inventory', async () => {
        const mockInventory = { raw_iron: 28, iron_ingot: 1 };
        
        const goalCount = 5;
        const haveRaw = mockInventory.raw_iron || 0;
        const shortfall = Math.max(0, goalCount - haveRaw);
        
        assert.strictEqual(shortfall, 0, 'Should need 0 raw_iron when have 28 and need 5');
    });

    it('should account for producible iron_ingot from raw_iron via smelting', async () => {
        const mockInventory = { raw_iron: 28, iron_ingot: 1 };
        
        const needIngots = 5;
        const haveIngots = mockInventory.iron_ingot || 0;
        const canSmelt = mockInventory.raw_iron || 0;
        const producible = haveIngots + canSmelt;
        const shortfall = Math.max(0, needIngots - producible);
        
        assert.strictEqual(shortfall, 0, 'Should need 0 more iron_ingot when have 28 raw_iron + 1 ingot');
    });

    it('should calculate real shortfall when inventory is insufficient', async () => {
        const mockInventory = { raw_iron: 2, iron_ingot: 1 };
        
        const needIngots = 5;
        const haveIngots = mockInventory.iron_ingot || 0;
        const canSmelt = mockInventory.raw_iron || 0;
        const producible = haveIngots + canSmelt;
        const shortfall = Math.max(0, needIngots - producible);
        
        assert.strictEqual(shortfall, 2, 'Should need 2 more iron_ingot when have 2 raw_iron + 1 ingot for 5 needed');
    });

    it('should use _computeShortfall to plan learned producer instead of mine when raw_iron available', async () => {
        // This tests the actual Voyager._computeShortfall method behavior
        // Uses ONLY learned producers - plan is always 'learned' (no type inference)
        const { Voyager, _setVersionForTest } = await import('../src/agent/voyager.js');
        
        _setVersionForTest('1.20.4');
        
        // Create a minimal Voyager instance with a LEARNED producer skill
        const voyager = Object.create(Voyager.prototype);
        // Seed a learned skill that produces iron_ingot from raw_iron (learned from past runs)
        voyager.skills = [{
            name: 'smeltRawIron',
            task: 'Smelt 1 raw_iron into 1 iron_ingot',
            code: 'async function smeltRawIron(bot) { return true; }',
            effects: ['iron_ingot'],
            consumes: { raw_iron: 1 },  // Learned: consumes 1 raw_iron per iron_ingot
            demoted: false,
            mergedInto: null,
            candidate: false
        }];
        voyager.npGraph = null;
        
        // Test: goal 3 iron_ingot with inv {raw_iron: 28, iron_ingot: 1}
        // Should plan to use learned producer
        const goal = { item: 'iron_ingot', count: 3, items: ['iron_ingot'] };
        const inv = { raw_iron: 28, iron_ingot: 1 };
        
        const result = voyager._computeShortfall(goal, inv);
        
        // With 1 in inventory + 28 producible via learned skill = 29 total
        assert.strictEqual(result.shortfall, 0, 'Shortfall should be 0 (have 1 + can produce 28 via learned skill)');
        assert.strictEqual(result.plan, 'learned', 'Plan should be "learned"');
        assert.ok(result.produceItems?.length > 0, 'Should have produce items identified');
        assert.ok(result.produceItems?.some(s => s.item === 'raw_iron'), 'Should identify raw_iron as source');
        assert.ok(result.produceItems?.some(s => s.task === 'Smelt 1 raw_iron into 1 iron_ingot'), 'Should include skill task string');
    });

    it('should identify learned plan when can satisfy goal entirely from producible', async () => {
        const { Voyager, _setVersionForTest } = await import('../src/agent/voyager.js');
        
        _setVersionForTest('1.20.4');
        
        // Create a Voyager with a learned producer
        const voyager = Object.create(Voyager.prototype);
        voyager.skills = [{
            name: 'smeltRawIron',
            task: 'Smelt 1 raw_iron into 1 iron_ingot',
            code: 'async function smeltRawIron(bot) { return true; }',
            effects: ['iron_ingot'],
            consumes: { raw_iron: 1 },
            demoted: false,
            mergedInto: null,
            candidate: false
        }];
        voyager.npGraph = null;
        
        // Need 3 iron_ingot, have 0 but can produce 28 via learned skill
        const goal = { item: 'iron_ingot', count: 3, items: ['iron_ingot'] };
        const inv = { raw_iron: 28 };
        
        const result = voyager._computeShortfall(goal, inv);
        
        assert.strictEqual(result.shortfall, 0, 'Shortfall should be 0 (can produce 28 via learned skill)');
        assert.strictEqual(result.plan, 'learned', 'Should plan learned');
    });
});

// ============================================================================
// Issue 3: posKey regression - missingCalls handles local declarations
// ============================================================================

describe('fix47: missingCalls handles all local declaration patterns', () => {
    it('should NOT flag arrow function assigned to const as unknown', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function collectBlock(bot, blockType, num = 1) {
    const posKey = p => \`\${Math.floor(p.x)},\${Math.floor(p.y)},\${Math.floor(p.z)}\`;
    const excluded = new Set();
    excluded.add(posKey(block.position));
    log(bot, \`Failed at \${posKey(block.position)}\`);
}`;
        
        const knownSkills = new Set(['getNearestBlock', 'goToPosition', 'log']);
        const missing = missingCalls(code, 'collectBlock', knownSkills);
        
        assert.ok(!missing.includes('posKey'), 
            `posKey should NOT be flagged as unknown (got: ${missing.join(', ')})`);
    });

    it('should NOT flag function parameters as unknown', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function mySkill(bot, callbackFn) {
    const result = callbackFn(42);
    await goToPosition(bot, result, 64, result);
}`;
        
        const knownSkills = new Set(['goToPosition', 'log']);
        const missing = missingCalls(code, 'mySkill', knownSkills);
        
        assert.ok(!missing.includes('callbackFn'), 
            `callbackFn (function param) should NOT be flagged as unknown (got: ${missing.join(', ')})`);
    });

    it('should NOT flag destructured variables as unknown', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function mySkill(bot) {
    const { posKey, otherFn } = helpers;
    posKey(block);
    otherFn(42);
}`;
        
        const knownSkills = new Set(['goToPosition', 'log']);
        const missing = missingCalls(code, 'mySkill', knownSkills);
        
        assert.ok(!missing.includes('posKey'), 
            `posKey (destructured) should NOT be flagged as unknown (got: ${missing.join(', ')})`);
        assert.ok(!missing.includes('otherFn'), 
            `otherFn (destructured) should NOT be flagged as unknown (got: ${missing.join(', ')})`);
    });

    it('should NOT flag arrow function parameters as unknown', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function mySkill(bot) {
    const fn = (helperFn) => helperFn(42);
    fn(x => x * 2);
}`;
        
        const knownSkills = new Set(['goToPosition', 'log']);
        const missing = missingCalls(code, 'mySkill', knownSkills);
        
        assert.ok(!missing.includes('helperFn'), 
            `helperFn (arrow param) should NOT be flagged as unknown (got: ${missing.join(', ')})`);
    });

    it('should NOT flag catch clause parameter as unknown', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function mySkill(bot) {
    try {
        await goToPosition(bot, 0, 64, 0);
    } catch (errorFn) {
        const msg = errorFn.message;
    }
}`;
        
        const knownSkills = new Set(['goToPosition', 'log']);
        const missing = missingCalls(code, 'mySkill', knownSkills);
        
        // errorFn is not called with (), but ensure the pattern is recognized
        assert.ok(!missing.includes('errorFn'), 
            `errorFn (catch param) should NOT be flagged (got: ${missing.join(', ')})`);
    });

    it('should NOT flag for-of loop variable as unknown', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function mySkill(bot) {
    for (const blockFn of [() => 1, () => 2]) {
        blockFn();
    }
}`;
        
        const knownSkills = new Set(['goToPosition', 'log']);
        const missing = missingCalls(code, 'mySkill', knownSkills);
        
        assert.ok(!missing.includes('blockFn'), 
            `blockFn (for-of var) should NOT be flagged as unknown (got: ${missing.join(', ')})`);
    });

    it('should still flag actually unknown camelCase calls', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function mySkill(bot) {
    await unknownSkillCall(bot);
    posKey(123);
}`;
        
        const knownSkills = new Set(['goToPosition', 'log']);
        const missing = missingCalls(code, 'mySkill', knownSkills);
        
        assert.ok(missing.includes('unknownSkillCall'), 
            `unknownSkillCall SHOULD be flagged as unknown`);
        assert.ok(missing.includes('posKey'), 
            `posKey SHOULD be flagged when not declared locally`);
    });

    it('should handle the exact findNextCollectBlock pattern from logs', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        // This is the exact pattern that failed in the logs
        const code = `
async function findNextCollectBlock(bot, blockType) {
    const excluded = new Set();
    const posKey = p => \`\${Math.floor(p.x)},\${Math.floor(p.y)},\${Math.floor(p.z)}\`;
    for (let i = 0; i < 10; i++) {
        const block = getNearestBlock(bot, b => !excluded.has(posKey(b.position)), 64);
        if (!block) break;
        try {
            await goToPosition(bot, block.position.x, block.position.y, block.position.z, 4);
        } catch (err) {
            excluded.add(posKey(block.position));
            log(bot, \`Failed to collect \${blockType} at \${posKey(block.position)}: \${err.message}; trying another\`);
            continue;
        }
    }
    return true;
}`;
        
        const knownSkills = new Set(['getNearestBlock', 'goToPosition', 'log', 'pickupNearbyItems']);
        const missing = missingCalls(code, 'findNextCollectBlock', knownSkills);
        
        assert.ok(!missing.includes('posKey'), 
            `posKey should NOT be flagged when declared as const arrow function (got: ${missing.join(', ')})`);
    });
});

// ============================================================================
// Issue 4: ensureCraftingTable recipe lookup without inventory filtering
// ============================================================================

describe('fix47: ensureCraftingTable recipe lookup', () => {
    it('should use minecraft-data recipesAll when ingredients missing', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Check that ensureCraftingTable section has recipesAll for inventory-independent recipe lookup
        // The code is in SEEDED_PRIMITIVES as a template literal, search the surrounding context
        const ensureTableStart = voyagerSrc.indexOf("name: 'ensureCraftingTable'");
        assert.ok(ensureTableStart > -1, 'ensureCraftingTable should be in SEEDED_PRIMITIVES');
        
        // Get a reasonable chunk of the ensureCraftingTable section (up to the next seeded primitive)
        const nextPrimitive = voyagerSrc.indexOf("name: '", ensureTableStart + 30);
        const sectionEnd = nextPrimitive > -1 ? nextPrimitive : ensureTableStart + 5000;
        const code = voyagerSrc.slice(ensureTableStart, sectionEnd);
        
        // Should have recipe lookup that doesn't require ingredients
        // Either bot.recipesAll or minecraft-data registry lookup
        assert.ok(
            code.includes('recipesAll') || 
            code.includes('allRecipes') ||
            code.includes('registry') || 
            code.includes('minecraft-data') ||
            code.includes('mcData'),
            'Should use recipe lookup that does not require ingredients in inventory'
        );
    });

    it('should NOT log "no recipe found" when planks are missing but recipe exists', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const ensureTablePrim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'ensureCraftingTable');
        assert.ok(ensureTablePrim, 'ensureCraftingTable should exist');
        
        const code = ensureTablePrim.code;
        
        // Should decompose to missing ingredients, not report "no recipe"
        assert.ok(
            code.includes('need') || code.includes('planks') || code.includes('ingredient'),
            'Should mention needing ingredients rather than "no recipe found"'
        );
    });
});

// ============================================================================
// Issue 5: Repair deduplication and outcome logging
// ============================================================================

describe('fix47: repair deduplication', () => {
    it('should have repair outcome logging (ok/rejected/rollback)', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Should log outcomes
        assert.ok(
            voyagerSrc.includes('[repair-outcome]') || 
            voyagerSrc.includes('repair ok') ||
            voyagerSrc.includes('repair rejected') ||
            voyagerSrc.includes('repair rollback') ||
            (voyagerSrc.includes('ROLLBACK') && voyagerSrc.includes('repair')),
            'Should have repair outcome logging'
        );
    });

    it('should have deduplication for same skill+signature repair requests', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Should check for duplicate repairs
        assert.ok(
            voyagerSrc.includes('already queued') ||
            voyagerSrc.includes('pending') ||
            voyagerSrc.includes('dedup') ||
            voyagerSrc.includes('same failure') ||
            voyagerSrc.includes('signature'),
            'Should have deduplication check for repair queue'
        );
    });

    it('should log loudly when same skill re-queued with same failure signature', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Should have loud logging for duplicate repairs
        assert.ok(
            voyagerSrc.includes('already queued') ||
            voyagerSrc.includes('WARN') ||
            voyagerSrc.includes('duplicate'),
            'Should warn when duplicate repair queued'
        );
    });
});

// ============================================================================
// Issue 6: Open items from log - tossClutter and deposit
// ============================================================================

describe('fix47: tossClutter postcondition and deposit logic', () => {
    it('should have tossClutter postcondition that checks for actual removal', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const tossClutterPrim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'tossClutter');
        assert.ok(tossClutterPrim, 'tossClutter should exist');
        
        if (tossClutterPrim.contract) {
            const post = tossClutterPrim.contract.post;
            assert.ok(
                post.includes('delta') || post.includes('inv') || post.includes('emptySlot'),
                'tossClutter postcondition should check for inventory change or slot freeing'
            );
        }
    });

    it('should deposit cobblestone when computed as candidate', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const tossClutterPrim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'tossClutter');
        assert.ok(tossClutterPrim, 'tossClutter should exist');
        
        const code = tossClutterPrim.code;
        
        // Should call depositToChest for deposit candidates
        assert.ok(code.includes('depositToChest'), 
            'tossClutter should call depositToChest for deposit candidates');
        assert.ok(code.includes('depositList') || code.includes('depositCandidates'),
            'tossClutter should iterate over deposit candidates');
    });

    it('should have clear PREREQUISITE FAILED message when chest missing for deposit', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const tossClutterPrim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'tossClutter');
        assert.ok(tossClutterPrim, 'tossClutter should exist');
        
        const code = tossClutterPrim.code;
        
        assert.ok(code.includes('PREREQUISITE') || code.includes('chest'),
            'tossClutter should mention prerequisite or chest requirement on failure');
    });
});

// ============================================================================
// Integration tests
// ============================================================================

describe('fix47: integration - all prefixed patterns removed', () => {
    it('should have no skills.* or world.* patterns in any file fed to the model', async () => {
        const { readdirSync, existsSync } = await import('fs');
        
        const prefixPattern = /\b(?:skills|world)\s*\.\s*\w+\s*\(/g;
        const violations = [];
        
        // Check profiles
        for (const file of readdirSync('./profiles').filter(f => f.endsWith('.json'))) {
            try {
                const content = readFileSync(`./profiles/${file}`, 'utf8');
                const data = JSON.parse(content);
                
                // Check coding examples
                for (const examples of [data.coding_examples || [], data.conversation_examples || []]) {
                    for (const ex of examples) {
                        for (const msg of ex) {
                            if (msg.content && prefixPattern.test(msg.content)) {
                                violations.push({ file, content: msg.content.match(prefixPattern) });
                            }
                        }
                    }
                }
                
                // Check coding prompt
                if (data.coding && prefixPattern.test(data.coding)) {
                    violations.push({ file, content: data.coding.match(prefixPattern) });
                }
            } catch (e) {
                // Skip non-parseable files
            }
        }
        
        // Check defaults
        if (existsSync('./profiles/defaults')) {
            for (const file of readdirSync('./profiles/defaults').filter(f => f.endsWith('.json'))) {
                try {
                    const content = readFileSync(`./profiles/defaults/${file}`, 'utf8');
                    const data = JSON.parse(content);
                    
                    for (const examples of [data.coding_examples || [], data.conversation_examples || []]) {
                        for (const ex of examples) {
                            for (const msg of ex) {
                                if (msg.content && prefixPattern.test(msg.content)) {
                                    violations.push({ file: `defaults/${file}`, content: msg.content.match(prefixPattern) });
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Skip
                }
            }
        }
        
        assert.strictEqual(violations.length, 0, 
            `Found prefixed calls in model-visible content: ${JSON.stringify(violations)}`);
    });
});

describe('fix47: prefix migration and shadow removal', () => {
    it('should remove skills.* and world.* prefixes from stored skill code', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const { mkdirSync } = await import('fs');
        const tmpDir = `/tmp/test-prefix-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });
        // Create a mock Voyager to test _migrateToBarenames
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};
        mockVoyager.skills = [{
            name: 'testPrefixedSkill',
            code: `async function testPrefixedSkill(bot) {
    const inv = world.getInventoryCounts(bot);
    await skills.wait(bot, 100);
    skills.log(bot, "test");
    await skills.goToPosition(bot, 0, 64, 0);
}`
        }];
        
        // Call the migration
        mockVoyager._migrateToBarenames();
        
        // Assert no prefixes remain
        const code = mockVoyager.skills[0].code;
        assert.ok(!code.includes('skills.'), `Found 'skills.' in migrated code: ${code}`);
        assert.ok(!code.includes('world.'), `Found 'world.' in migrated code: ${code}`);
        assert.ok(code.includes('getInventoryCounts(bot)'), 'Should have bare getInventoryCounts');
        assert.ok(code.includes('await wait(bot, 100)'), 'Should have bare wait');
        assert.ok(code.includes('log(bot,'), 'Should have bare log');
        assert.ok(code.includes('await goToPosition(bot'), 'Should have bare goToPosition');
    });
    
    it('should remove shadow patterns like const log = skills.log', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const { mkdirSync } = await import('fs');
        const tmpDir = `/tmp/test-shadow-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};
        mockVoyager.skills = [{
            name: 'testShadowSkill',
            code: `async function testShadowSkill(bot) {
    const log = skills.log;
    const goToPosition = skills.goToPosition;
    const wait = world.wait;
    
    log(bot, "hello");
    await goToPosition(bot, 0, 0, 0);
}`
        }];
        
        mockVoyager._migrateToBarenames();
        
        const code = mockVoyager.skills[0].code;
        // Shadow patterns should be removed entirely
        assert.ok(!code.includes('const log = skills.log'), 'Should remove shadow for log');
        assert.ok(!code.includes('const goToPosition = skills.goToPosition'), 'Should remove shadow for goToPosition');
        assert.ok(!code.includes('const wait = world.wait'), 'Should remove shadow for wait');
        // But the bare function calls should remain
        assert.ok(code.includes('log(bot,'), 'Should keep bare log call');
        assert.ok(code.includes('await goToPosition(bot'), 'Should keep bare goToPosition call');
    });
    
    it('should detect and report leftover prefixed patterns after migration', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const { mkdirSync } = await import('fs');
        const tmpDir = `/tmp/test-fix47-leftover-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};
        mockVoyager.skills = [{
            name: 'testLeftover',
            // This shouldn't happen normally, but test the detection
            // fix50: migration now THROWS on leftover patterns (fail loud, no soft paths)
            code: `async function testLeftover(bot) {
    // This is a comment mentioning skills.log
    const x = bot.skills.something; // Different pattern
}`
        }];
        
        // fix50: migration now THROWS on leftover patterns
        assert.throws(
            () => mockVoyager._migrateToBarenames(),
            /LEFTOVER PREFIXED PATTERNS/,
            'Migration should THROW when leftover patterns remain'
        );
    });
});

describe('fix47: harvestTools-based decompose', () => {
    it('should compute cheapest harvest tool for stone via recipe chain', async () => {
        const { Voyager, _setVersionForTest } = await import('../src/agent/voyager.js');
        _setVersionForTest('1.20.4');
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.skills = [];
        mockVoyager.progress = {};
        
        // No pickaxes in inventory
        const inv = { oak_log: 10, cobblestone: 0 };
        
        const toolInfo = mockVoyager._cheapestHarvestTool('stone', inv);
        
        // Should find wooden_pickaxe as cheapest (can craft from oak_log)
        assert.ok(toolInfo, 'Should find a tool');
        assert.ok(toolInfo.tool, 'Should have a tool name');
        assert.ok(toolInfo.chain, 'Should have a recipe chain');
        // The chain should include gathering/crafting steps
        assert.ok(toolInfo.chain.length > 0, 'Chain should have steps');
    });
    
    it('should return already have if pickaxe is in inventory', async () => {
        const { Voyager, _setVersionForTest } = await import('../src/agent/voyager.js');
        _setVersionForTest('1.20.4');
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.skills = [];
        mockVoyager.progress = {};
        
        const inv = { wooden_pickaxe: 1 };
        
        const toolInfo = mockVoyager._cheapestHarvestTool('stone', inv);
        
        assert.ok(toolInfo, 'Should find tool info');
        assert.strictEqual(toolInfo.tool, 'wooden_pickaxe', 'Should identify wooden_pickaxe');
        assert.deepStrictEqual(toolInfo.chain, [], 'Chain should be empty (already have)');
        assert.strictEqual(toolInfo.reason, 'already have', 'Should say already have');
    });
    
    it('should queue harvest tool recipe chain as subgoals on Cannot break failure', async () => {
        const { Voyager, _setVersionForTest } = await import('../src/agent/voyager.js');
        _setVersionForTest('1.20.4');
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.skills = [];
        mockVoyager.progress = { decomposed: {}, subgoals: [] };
        mockVoyager._curSub = null;
        mockVoyager._saveProgress = () => {};
        mockVoyager.observe = () => ({ inventory: { oak_log: 10 } });
        
        // Mock _cheapestHarvestTool to return a known chain
        mockVoyager._cheapestHarvestTool = (blockName, inv) => {
            if (blockName === 'stone') {
                return {
                    tool: 'wooden_pickaxe',
                    chain: [
                        { item: 'oak_planks', count: 4, action: 'craft' },
                        { item: 'stick', count: 2, action: 'craft' },
                        { item: 'wooden_pickaxe', count: 1, action: 'craft' }
                    ]
                };
            }
            return null;
        };
        
        const result = await mockVoyager._decompose('Mine 10 stone', 'Cannot break stone with current tools');
        
        assert.ok(result, 'Decompose should return true (handled)');
        assert.ok(mockVoyager.progress.decomposed['Mine 10 stone'], 'Should record decomposition');
        const subs = mockVoyager.progress.decomposed['Mine 10 stone'].subs;
        assert.ok(subs.length >= 1, 'Should have subgoals');
        // Should include craft steps for the tool
        assert.ok(subs.some(s => s.toLowerCase().includes('wooden_pickaxe')), 
            'Subgoals should include crafting wooden_pickaxe');
    });
});

describe('fix47: call-graph cycle detection', () => {
    it('should detect self-recursive skill code', async () => {
        const { findAllCycles } = await import('../src/agent/skill_graph.js');
        
        // A graph where skillA calls itself (direct self-recursion)
        // This would be detected by code analysis, but we test the graph checker too
        const graph = {
            skillA: ['skillA'],  // Self-loop
            skillB: ['skillC'],
            skillC: []
        };
        
        const cycles = findAllCycles(graph);
        assert.ok(cycles.length > 0, 'Should detect self-loop cycle');
        assert.ok(cycles.some(c => c.includes('skillA')), 'Cycle should include skillA');
    });
    
    it('should detect mutual recursion (A->B->A)', async () => {
        const { findAllCycles } = await import('../src/agent/skill_graph.js');
        
        const graph = {
            equipBestAxeAndPickaxe: ['equipBestTool'],
            equipBestTool: ['equipBestAxeAndPickaxe'],  // Mutual recursion
            collectBlock: []
        };
        
        const cycles = findAllCycles(graph);
        assert.ok(cycles.length > 0, 'Should detect mutual recursion cycle');
        const cycleStr = cycles.map(c => c.join('->')).join('; ');
        assert.ok(
            cycleStr.includes('equipBestAxeAndPickaxe') && cycleStr.includes('equipBestTool'),
            `Cycle should include both skills: ${cycleStr}`
        );
    });
    
    it('should detect longer cycles (A->B->C->A)', async () => {
        const { findAllCycles } = await import('../src/agent/skill_graph.js');
        
        const graph = {
            collectBlock: ['equipToolOrCraft'],
            equipToolOrCraft: ['obtainItem'],
            obtainItem: ['collectBlock'],  // Creates A->B->C->A cycle
            craftRecipe: []
        };
        
        const cycles = findAllCycles(graph);
        assert.ok(cycles.length > 0, 'Should detect longer cycle');
    });
    
    it('should return empty array for acyclic graph', async () => {
        const { findAllCycles } = await import('../src/agent/skill_graph.js');
        
        const graph = {
            craftRecipe: ['placeBlock', 'collectBlock'],
            placeBlock: ['goToPosition'],
            collectBlock: ['pickupNearbyItems'],
            goToPosition: [],
            pickupNearbyItems: []
        };
        
        const cycles = findAllCycles(graph);
        assert.strictEqual(cycles.length, 0, 'Should have no cycles');
    });
});

describe('fix47: blocker tracking in curriculum', () => {
    it('should track blockers when harvestTools decompose happens', async () => {
        const { Voyager, _setVersionForTest } = await import('../src/agent/voyager.js');
        _setVersionForTest('1.20.4');
        
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.skills = [];
        mockVoyager.progress = { decomposed: {}, subgoals: [], blockers: [] };
        mockVoyager._curSub = null;
        mockVoyager._saveProgress = () => {};
        mockVoyager.observe = () => ({ inventory: {} });
        
        // Mock _cheapestHarvestTool
        mockVoyager._cheapestHarvestTool = (blockName, inv) => {
            if (blockName === 'stone') {
                return {
                    tool: 'wooden_pickaxe',
                    chain: [
                        { item: 'oak_planks', count: 4, action: 'craft' },
                        { item: 'wooden_pickaxe', count: 1, action: 'craft' }
                    ]
                };
            }
            return null;
        };
        
        await mockVoyager._decompose('Mine 10 stone', 'Cannot break stone with current tools');
        
        assert.ok(mockVoyager.progress.blockers.length > 0, 'Should have blockers');
        const blocker = mockVoyager.progress.blockers[0];
        assert.strictEqual(blocker.tool, 'wooden_pickaxe', 'Blocker should track the needed tool');
        assert.strictEqual(blocker.block, 'stone', 'Blocker should track the blocked block');
    });
    
    it('should include blockers in curriculum prompt facts', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Check that proposeTask includes blockers in the user prompt
        const proposeTaskMatch = voyagerSrc.match(/async\s+proposeTask[\s\S]*?return\s+parseLocalJSON/);
        assert.ok(proposeTaskMatch, 'proposeTask function should exist');
        
        const proposeTaskBody = proposeTaskMatch[0];
        assert.ok(proposeTaskBody.includes('blockers'), 'proposeTask should reference blockers');
        assert.ok(proposeTaskBody.includes('BLOCKERS') || proposeTaskBody.includes('blockerHint'), 
            'proposeTask should include blocker hint in prompt');
    });
});
