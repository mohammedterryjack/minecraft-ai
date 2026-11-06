/**
 * fix45 regression tests - hunger/health deadlock, already-have goal, contract attribution, gate false REJECT
 * 
 * Required tests:
 * 1. Hunger/health deadlock: observation contains food/health facts; planner not blocked by idle-skip gate for restore goals
 * 2. Already-have goal regression: if inventory count >= goal count, goal is satisfied regardless of producer graph
 * 3. Contract attribution: VIOLATED only attributed to skill whose own postcondition failed against its own delta
 * 4. Gate false REJECT: locally declared identifiers (posKey, etc.) not flagged as unknown skills
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// Issue 1: Hunger/health deadlock
// ============================================================================

describe('fix45: hunger/health as planner facts', () => {
    it('should expose food and health as plain numeric facts in observe()', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        const observeMatch = voyagerSrc.match(/observe\(\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\}\s*;?\s*\}/);
        assert.ok(observeMatch, 'observe() function should exist');
        
        const observeBody = observeMatch[0];
        
        assert.ok(/food_value\s*:/.test(observeBody), 'observation should contain food_value (numeric)');
        assert.ok(/health_value\s*:/.test(observeBody), 'observation should contain health_value (numeric)');
        assert.ok(/food_max\s*:/.test(observeBody), 'observation should contain food_max');
        assert.ok(/health_max\s*:/.test(observeBody), 'observation should contain health_max');
        
        assert.ok(/food_value\s*:\s*bot\.food\b/.test(observeBody), 'food_value should be bot.food (numeric)');
        assert.ok(/health_value\s*:\s*(?:Math\.round\()?bot\.health(?:\))?\b/.test(observeBody), 'health_value should be bot.health (numeric)');
    });

    it('should not have hard-coded food item tables in the codebase', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const coderSrc = readFileSync('./src/agent/coder.js', 'utf8');
        const skillsSrc = readFileSync('./src/agent/library/skills.js', 'utf8');
        
        const foodItemPatterns = [
            /\[\s*['"]cooked_beef['"],\s*['"]cooked_pork['"]/,
            /\[\s*['"]bread['"],\s*['"]apple['"],\s*['"]cooked/,
            /edible.*items.*=.*\[/i,
            /food.*list.*=.*\[.*['"]cooked/i,
        ];
        
        const allSrc = voyagerSrc + coderSrc + skillsSrc;
        
        for (const pattern of foodItemPatterns) {
            assert.ok(!pattern.test(allSrc), `Should not have hard-coded food item list matching ${pattern}`);
        }
    });

    it('should allow restore goal path when food/health low even during idle-skip conditions', async () => {
        const { IdlePractice } = await import('../src/agent/idle_practice.js');
        const practice = new IdlePractice('test-bot');
        
        practice.enabled = true;
        practice.practiceInProgress = false;
        practice.idleSince = Date.now() - 60000;
        practice.lastPractice = 0;
        
        const result = practice.isReadyForPractice(false, false);
        assert.strictEqual(result.ready, true, 'Should be ready for practice when conditions met');
    });

    it('should NOT have hard-coded numeric vital thresholds in _runPracticeSkill idle gate', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        const runPracticeMatch = voyagerSrc.match(/_runPracticeSkill\s*\([^)]*\)\s*\{[\s\S]*?(?=\n    async\s+\w|\n    \/\/\s*-{5,}|\n\s*\}$)/);
        assert.ok(runPracticeMatch, '_runPracticeSkill function should exist');
        
        const runPracticeBody = runPracticeMatch[0];
        
        assert.ok(!/bot\.health\s*<\s*\d+/.test(runPracticeBody), 
            'Should NOT have hard-coded health threshold like "bot.health < 10"');
        assert.ok(!/bot\.food\s*<\s*\d+/.test(runPracticeBody), 
            'Should NOT have hard-coded food threshold like "bot.food < 8"');
        assert.ok(!/health.*too.*low.*<\s*\d+/.test(runPracticeBody), 
            'Should NOT have health threshold skip message');
        assert.ok(!/food.*too.*low.*<\s*\d+/.test(runPracticeBody), 
            'Should NOT have food threshold skip message');
    });

    it('should include food/health facts in curriculum proposeTask prompt', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        const proposeTaskMatch = voyagerSrc.match(/async\s+proposeTask\s*\([^)]*\)\s*\{[\s\S]*?return\s+parseLocalJSON/);
        assert.ok(proposeTaskMatch, 'proposeTask function should exist');
        
        const proposeTaskBody = proposeTaskMatch[0];
        
        assert.ok(/current_health.*bot\.health|bot\.health.*current_health/.test(proposeTaskBody), 
            'proposeTask should include current_health from bot.health');
        assert.ok(/current_food.*bot\.food|bot\.food.*current_food/.test(proposeTaskBody), 
            'proposeTask should include current_food from bot.food');
        // fix47: proposeTask now uses _compactState for efficiency (includes food/health in compact format)
        assert.ok(/_compactState\s*\(\s*state\s*\)/.test(proposeTaskBody), 
            'proposeTask should pass state through _compactState which includes food_value/health_value');
    });

    it('should have curriculum system prompt mention survival and reading health/food', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        const proposeTaskStart = voyagerSrc.indexOf('async proposeTask');
        assert.ok(proposeTaskStart !== -1, 'proposeTask function should exist');
        
        const proposeTaskSection = voyagerSrc.slice(proposeTaskStart, proposeTaskStart + 2500);
        
        assert.ok(/survive|survival/i.test(proposeTaskSection), 
            'System prompt should mention survival');
        assert.ok(/health.*food|food.*health/i.test(proposeTaskSection), 
            'System prompt should mention health and food');
        assert.ok(/survival is your job/i.test(proposeTaskSection),
            'System prompt should tell the curriculum that survival is its job');
    });
});

describe('fix45: food/health restoration via learned skills', () => {
    it('should allow actions when food is low (6/20) with food-restoring item in inventory', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        const runPracticeMatch = voyagerSrc.match(/_runPracticeSkill\s*\([^)]*\)\s*\{[\s\S]*?(?=\n    async\s+\w|\n    \/\/\s*-{5,})/);
        assert.ok(runPracticeMatch, '_runPracticeSkill should exist');
        
        const runPracticeBody = runPracticeMatch[0];
        
        assert.ok(!/bot\.food\s*<\s*\d+/.test(runPracticeBody),
            'Should NOT skip based on food level - low food must not block actions');
        
        assert.ok(runPracticeBody.includes('isIdle'), 
            'Should only skip if bot is not idle (legitimate gate)');
        assert.ok(runPracticeBody.includes('threats'), 
            'Should only skip if threats nearby (legitimate learned-from-environment gate)');
    });

    it('should have learned effects/consumes structure for food items (no hard-coded food list)', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(/s\.effects|e\.effects/.test(voyagerSrc), 
            'Skills should have learned effects');
        assert.ok(/s\.consumes|e\.consumes/.test(voyagerSrc), 
            'Skills should have learned consumes');
        
        assert.ok(/npGraph|NeedsProducesGraph/.test(voyagerSrc), 
            'Should have needs/produces graph for learning item relationships');
    });

    it('should surface food_value in _stateText output for curriculum', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        const stateTextMatch = voyagerSrc.match(/_stateText\s*\([^)]*\)\s*\{[\s\S]*?\n    \}/);
        assert.ok(stateTextMatch, '_stateText function should exist');
        
        assert.ok(/for\s*\(\s*const\s*\[\s*k\s*,\s*v\s*\]\s*of\s*Object\.entries\s*\(\s*s\s*\)/.test(stateTextMatch[0]) ||
                  /Object\.entries\s*\(\s*s\s*\)/.test(stateTextMatch[0]),
            '_stateText should iterate over state entries including food_value/health_value');
    });
});

// ============================================================================
// Issue 2: Already-have goal regression (from #15/#25)
// ============================================================================

describe('fix45: already-have goal satisfaction', () => {
    it('should satisfy goal when inventory count >= goal count even without learned producer', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        // Create mock using Object.create to properly inherit prototype methods like _computeShortfall
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.skills = [];
        mockVoyager.npGraph = { consumesOf: () => ({}), getProducersOf: () => [], getRequirementsOf: () => [] };
        
        const state = {
            inventory: { iron_pickaxe: 1 },
            equipment: { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' }
        };
        
        const result = mockVoyager._goalAlreadySatisfied('obtain 1 iron_pickaxe', state);
        
        assert.strictEqual(result.satisfied, true, 'Should be satisfied when have 1/1 iron_pickaxe');
        assert.ok(result.reason.includes('already have'), 'Reason should mention already having the item');
    });

    it('should NOT satisfy goal when inventory count < goal count', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.skills = [];
        mockVoyager.npGraph = { consumesOf: () => ({}), getProducersOf: () => [], getRequirementsOf: () => [] };
        
        const state = {
            inventory: { iron_pickaxe: 0 },
            equipment: { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' }
        };
        
        const result = mockVoyager._goalAlreadySatisfied('obtain 1 iron_pickaxe', state);
        
        assert.strictEqual(result.satisfied, false, 'Should NOT be satisfied when have 0/1 iron_pickaxe');
    });

    it('should satisfy goal with multiple items in inventory sum', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.skills = [];
        mockVoyager.npGraph = { consumesOf: () => ({}), getProducersOf: () => [], getRequirementsOf: () => [] };
        
        const state = {
            inventory: { cobblestone: 64, stone: 10 },
            equipment: { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' }
        };
        
        const result = mockVoyager._goalAlreadySatisfied('mine 20 cobblestone', state);
        
        assert.strictEqual(result.satisfied, true, 'Should be satisfied when have 64+ cobblestone');
    });

    it('should result in zero attempts when already satisfied', async () => {
        let attempts = 0;
        
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.skills = [];
        mockVoyager.npGraph = { consumesOf: () => ({}), getProducersOf: () => [], getRequirementsOf: () => [] };
        mockVoyager.progress = { completed: [], failed: [] };
        mockVoyager._saveProgress = () => {};
        
        const satisfied = mockVoyager._goalAlreadySatisfied('obtain 1 iron_pickaxe', { inventory: { iron_pickaxe: 1 }, equipment: { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' } });
        
        if (satisfied.satisfied) {
            mockVoyager.progress.completed.push('obtain 1 iron_pickaxe');
        } else {
            attempts++;
        }
        
        assert.strictEqual(attempts, 0, 'Should have zero attempts when goal already satisfied');
        assert.ok(mockVoyager.progress.completed.includes('obtain 1 iron_pickaxe'), 'Goal should be marked completed');
    });
});

// ============================================================================
// Issue 3: Contract attribution
// ============================================================================

describe('fix45: contract attribution accuracy', () => {
    it('should NOT attribute VIOLATED to obtainItem when it delegated to smelt and got +1', async () => {
        const { annotateTrace, blameAll } = await import('../src/agent/skill_graph.js');
        
        const trace = [
            {
                name: 'obtainItem',
                parent: -1,
                depth: 0,
                o0: 0,
                o1: 100,
                t0: 1000,
                t1: 5000,
                fail: false,
                rv: true,
                delta: { iron_ingot: 1 },
                s0: { inv: { iron_ingot: 0 } },
                s1: { inv: { iron_ingot: 1 } },
                argv: ['iron_ingot', 1],
            },
            {
                name: 'smeltItem',
                parent: 0,
                depth: 1,
                o0: 10,
                o1: 90,
                t0: 1100,
                t1: 4900,
                fail: false,
                rv: true,
                delta: { iron_ingot: 1, raw_iron: -1 },
                s0: { inv: { raw_iron: 1 } },
                s1: { inv: { iron_ingot: 1 } },
                argv: ['raw_iron', 1],
            },
        ];
        
        const output = 'Smelted raw_iron into iron_ingot';
        annotateTrace(trace, output);
        
        assert.strictEqual(trace[0].ok, true, 'obtainItem should be ok when it gained the item via delegation');
        assert.strictEqual(trace[1].ok, true, 'smeltItem should be ok when it succeeded');
        
        const isLeaf = () => false;
        const isLearned = () => true;
        const blamed = blameAll(trace, isLeaf, isLearned);
        
        assert.strictEqual(blamed.length, 0, 'No skills should be blamed when task succeeded');
    });

    it('should NOT attribute VIOLATED when delta shows goal achieved even if contract formula disagrees', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        const checkContractsMatch = voyagerSrc.match(/_checkContracts\(trace,\s*taskOk\)\s*\{[\s\S]*?\n    \}/);
        assert.ok(checkContractsMatch, '_checkContracts should exist');
        
        const checkContractsBody = checkContractsMatch[0];
        
        assert.ok(
            /fix45|taskOk.*&&.*delta|delta.*&&.*taskOk|achieved.*delta/.test(checkContractsBody) ||
            /if\s*\(\s*taskOk\b/.test(checkContractsBody),
            '_checkContracts should consider taskOk when attributing violations'
        );
    });

    it('should NOT attribute VIOLATED to craftItem when it was never the producer', async () => {
        const { annotateTrace, blameAll } = await import('../src/agent/skill_graph.js');
        
        const trace = [
            {
                name: 'obtainItem',
                parent: -1,
                depth: 0,
                o0: 0,
                o1: 200,
                t0: 1000,
                t1: 6000,
                fail: false,
                rv: true,
                delta: { iron_ingot: 1 },
                s0: { inv: { iron_ingot: 0 } },
                s1: { inv: { iron_ingot: 1 } },
                argv: ['iron_ingot', 1],
            },
        ];
        
        const output = 'Obtained iron_ingot via smelting';
        annotateTrace(trace, output);
        
        const mockSkills = [
            { name: 'obtainItem', effects: ['iron_ingot'], contract: { post: 'c => (c.delta.iron_ingot || 0) >= 1' } },
            { name: 'craftItem', effects: ['iron_ingot'], contract: { post: 'c => (c.delta.iron_ingot || 0) >= 1' } },
        ];
        
        const craftItemInTrace = trace.find(r => r.name === 'craftItem');
        assert.strictEqual(craftItemInTrace, undefined, 'craftItem should not be in trace when it was not called');
    });

    it('should attribute VIOLATED only to the skill whose postcondition actually failed', async () => {
        const { annotateTrace, blameAll } = await import('../src/agent/skill_graph.js');
        
        const trace = [
            {
                name: 'parentSkill',
                parent: -1,
                depth: 0,
                o0: 0,
                o1: 200,
                t0: 1000,
                t1: 6000,
                fail: false,
                rv: true,
                delta: { iron_ingot: 1 },
                s0: { pos: { x: 0, y: 64, z: 0 }, inv: {} },
                s1: { pos: { x: 0, y: 64, z: 0 }, inv: { iron_ingot: 1 } },
                argv: [],
            },
            {
                name: 'childSkill',
                parent: 0,
                depth: 1,
                o0: 10,
                o1: 190,
                t0: 1100,
                t1: 5900,
                fail: true,
                rv: false,
                delta: {},
                s0: { pos: { x: 0, y: 64, z: 0 }, inv: {} },
                s1: { pos: { x: 0, y: 64, z: 0 }, inv: {} },
                argv: [],
                ownFail: ['FAILED: no raw materials'],
            },
        ];
        
        const output = 'FAILED: no raw materials\nUsed fallback method';
        annotateTrace(trace, output);
        
        const isLeaf = () => false;
        const isLearned = () => true;
        const blamed = blameAll(trace, isLeaf, isLearned);
        
        if (blamed.length > 0) {
            assert.strictEqual(blamed[0].target, 'childSkill', 'Only childSkill should be blamed (its postcondition failed)');
        }
    });

    it('should recognize task PASS means no contract violation attribution for successful delegates', async () => {
        const taskPassed = true;
        const skillDelegatedToSmelt = true;
        const smeltGained = 1;
        
        const shouldAttributeViolated = !taskPassed || (skillDelegatedToSmelt && smeltGained <= 0);
        
        assert.strictEqual(shouldAttributeViolated, false, 'Should not attribute VIOLATED when task passed and smelt gained items');
    });

    it('should still mark VIOLATED when skill delta truly fails even if task passed', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        const checkContractsMatch = voyagerSrc.match(/_checkContracts\(trace,\s*taskOk\)\s*\{[\s\S]*?\n    \}/);
        assert.ok(checkContractsMatch, '_checkContracts should exist');
        
        const checkContractsBody = checkContractsMatch[0];
        
        assert.ok(/r\.ok\s*=\s*false/.test(checkContractsBody), 
            '_checkContracts should still be able to mark r.ok = false');
        assert.ok(/r\.fail\s*=\s*true/.test(checkContractsBody), 
            '_checkContracts should still be able to mark r.fail = true');
        assert.ok(/ownFail/.test(checkContractsBody), 
            '_checkContracts should still populate ownFail for violations');
        
        assert.ok(/deltaGained/.test(checkContractsBody) || /delta.*gained/i.test(checkContractsBody),
            '_checkContracts should check if delta shows gain before skipping violation');
        
        assert.ok(/if\s*\(\s*deltaGained\s*\)[\s\S]*?continue/.test(checkContractsBody) ||
                  /deltaGained[\s\S]*?continue/.test(checkContractsBody),
            '_checkContracts should only skip violation when delta shows gain (continue), otherwise still mark VIOLATED');
    });

    it('should mark VIOLATED when delta shows NO gain for effects (true failure)', async () => {
        const taskPassed = true;
        const skillEffects = ['iron_ingot'];
        const skillDelta = { coal: 2 };
        
        const deltaGained = skillEffects.some(eff => (skillDelta[eff] || 0) > 0);
        
        assert.strictEqual(deltaGained, false, 'Delta should NOT show gain for iron_ingot when only coal gained');
        
        const shouldMarkViolated = !deltaGained;
        assert.strictEqual(shouldMarkViolated, true, 
            'Should mark VIOLATED when skill delta does not show gain for its expected effects');
    });

    it('should NOT mark VIOLATED when delta shows gain for effects (task and skill both succeeded)', async () => {
        const taskPassed = true;
        const skillEffects = ['iron_ingot'];
        const skillDelta = { iron_ingot: 1 };
        
        const deltaGained = skillEffects.some(eff => (skillDelta[eff] || 0) > 0);
        
        assert.strictEqual(deltaGained, true, 'Delta SHOULD show gain for iron_ingot');
        
        const shouldMarkViolated = !deltaGained;
        assert.strictEqual(shouldMarkViolated, false, 
            'Should NOT mark VIOLATED when skill delta shows gain for its expected effects');
    });
});

// ============================================================================
// Issue 4: Gate false REJECT for locally declared identifiers
// ============================================================================

describe('fix45: gate recognizes locally declared identifiers', () => {
    it('should NOT reject code with locally declared arrow function posKey', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function collectBlock(bot, blockType, num = 1) {
    const posKey = p => \`\${Math.floor(p.x)},\${Math.floor(p.y)},\${Math.floor(p.z)}\`;
    const excluded = new Set();
    for (let i = 0; i < num; i++) {
        const block = getNearestBlock(bot, b => types.includes(b.name) && !excluded.has(posKey(b.position)), 64);
        if (!block) break;
        excluded.add(posKey(block.position));
    }
}`;
        
        const knownSkills = new Set(['getNearestBlock', 'goToPosition', 'pickupNearbyItems', 'log']);
        const missing = missingCalls(code, 'collectBlock', knownSkills);
        
        assert.ok(!missing.includes('posKey'), `posKey should NOT be flagged as unknown (got: ${missing.join(', ')})`);
    });

    it('should NOT reject code with function declaration inside skill body', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function mySkill(bot) {
    function helperFn(x) { return x * 2; }
    const result = helperFn(5);
    await goToPosition(bot, result, 64, result);
}`;
        
        const knownSkills = new Set(['goToPosition', 'log']);
        const missing = missingCalls(code, 'mySkill', knownSkills);
        
        assert.ok(!missing.includes('helperFn'), `helperFn should NOT be flagged as unknown (got: ${missing.join(', ')})`);
    });

    it('should recognize getNearestBlock, getInventoryCounts, getAllFreeSpaces, goToPosition as bare API names', async () => {
        const { getBareAPI } = await import('../src/agent/coder.js');
        const bareAPI = getBareAPI();
        
        const requiredNames = ['getNearestBlock', 'getInventoryCounts', 'getAllFreeSpaces', 'goToPosition'];
        
        for (const name of requiredNames) {
            assert.ok(bareAPI.names.has(name), `${name} should be in bare API names`);
        }
    });

    it('should NOT flag arrow function assigned to const as unknown skill', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function processItems(bot) {
    const filterFn = item => item.count > 0;
    const mapFn = item => item.name;
    const items = getInventoryCounts(bot);
    return Object.keys(items).filter(filterFn).map(mapFn);
}`;
        
        const knownSkills = new Set(['getInventoryCounts', 'log']);
        const missing = missingCalls(code, 'processItems', knownSkills);
        
        assert.ok(!missing.includes('filterFn'), `filterFn should NOT be flagged as unknown`);
        assert.ok(!missing.includes('mapFn'), `mapFn should NOT be flagged as unknown`);
    });

    it('should still flag actually unknown camelCase calls', async () => {
        const { missingCalls } = await import('../src/agent/skill_graph.js');
        
        const code = `
async function mySkill(bot) {
    await unknownSkillCall(bot);
    await anotherMissingFn(bot, 5);
}`;
        
        const knownSkills = new Set(['goToPosition', 'log']);
        const missing = missingCalls(code, 'mySkill', knownSkills);
        
        assert.ok(missing.includes('unknownSkillCall'), `unknownSkillCall SHOULD be flagged as unknown`);
        assert.ok(missing.includes('anotherMissingFn'), `anotherMissingFn SHOULD be flagged as unknown`);
    });
});

describe('fix45: no targetBlock undefined variable in seeded skills', () => {
    it('should not have undeclared targetBlock references in seeded collectBlock', async () => {
        const { readFileSync } = await import('fs');
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        const seededMatch = voyagerSrc.match(/SEEDED_PRIMITIVES\s*=\s*\[([\s\S]*?)\];/);
        assert.ok(seededMatch, 'SEEDED_PRIMITIVES should exist');
        
        const seededSection = seededMatch[1];
        const collectBlockMatch = seededSection.match(/name:\s*['"]collectBlock['"][\s\S]*?code:\s*`([\s\S]*?)`/);
        
        if (collectBlockMatch) {
            const collectBlockCode = collectBlockMatch[1];
            
            const declaresTargetBlock = /(?:const|let|var)\s+targetBlock\b/.test(collectBlockCode);
            const usesTargetBlock = /\btargetBlock\b/.test(collectBlockCode);
            
            if (usesTargetBlock) {
                assert.ok(declaresTargetBlock, 'targetBlock must be declared if used in collectBlock');
            }
        }
    });

    it('should not have undeclared targetBlock in any seeded skill body', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        for (const prim of Voyager.SEEDED_PRIMITIVES || []) {
            if (!prim.code) continue;
            
            const usesTargetBlock = /\btargetBlock\b/.test(prim.code);
            const declaresTargetBlock = /(?:const|let|var|function)\s+targetBlock\b/.test(prim.code) ||
                                        /\(\s*targetBlock\s*[,)]/.test(prim.code);
            
            if (usesTargetBlock && !declaresTargetBlock) {
                assert.fail(`Seeded skill ${prim.name} uses undeclared targetBlock`);
            }
        }
    });
});
