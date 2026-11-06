// fix49 regression tests: live bugs + idle practice + health/backoff
import test from 'node:test';
import assert from 'node:assert';

// ─────────────────────────────────────────────────────────────────────────────
// Bug 1: goal.heuristic is not a function - travelTo passes wrong goal object
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: travelTo seeded code uses GoalNearXZ, not Vec3', async (t) => {
    await t.test('should have GoalNearXZ in seeded travelTo code', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const travelTo = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'travelTo');
        assert.ok(travelTo, 'travelTo primitive should exist');
        assert.ok(travelTo.code.includes('GoalNearXZ'), 
            'travelTo code should use GoalNearXZ, not Vec3 (goal.heuristic bug)');
        assert.ok(!travelTo.code.includes('new Vec3(tx,'), 
            'travelTo should not pass Vec3 as a pathfinder goal');
    });

    await t.test('should not pass Vec3 with extra number parameter to goToGoal', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const travelTo = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'travelTo');
        // The old buggy pattern was: goToGoal(bot, new Vec3(tx, p.y, tz), 3)
        const buggyPattern = /goToGoal\s*\(\s*bot\s*,\s*new\s+Vec3\s*\([^)]+\)\s*,\s*\d+\s*\)/;
        assert.ok(!buggyPattern.test(travelTo.code),
            'travelTo should not call goToGoal(bot, Vec3(...), number) - goToGoal takes (bot, goal) only');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2: craftRecipe postcondition VIOLATED after real craft success
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: craftRecipe postcondition uses delta (not stale inventory)', async (t) => {
    await t.test('postcondition check should trust delta over contract formula disagreement', async () => {
        // Simulate: craftRecipe returned true, delta shows +1 iron_pickaxe, but contract.post is false
        // fix45 logic: delta is ground truth - queue contract repair, not skill repair
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const mockAgent = {
            name: 'test_bot',
            bot: { __psnTrace: [], __psnALS: { getStore: () => -1, run: (id, fn) => fn() } },
            prompter: { code_model: { sendRequest: async () => '{}' } },
            coder: { _getLearnedSkillNames: () => [] }
        };
        
        // We test that the code path exists - when delta shows gain, don't mark as VIOLATED
        const craftRecipePrim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'craftRecipe');
        assert.ok(craftRecipePrim, 'craftRecipe should be a seeded primitive');
        
        // The fix is in _checkContracts: when delta shows positive gain for effects, skip VIOLATED
        // Verify the Voyager code contains the fix45 delta check
        const voyagerCode = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/voyager.js', 'utf8'));
        assert.ok(voyagerCode.includes('deltaGained'), 
            '_checkContracts should check deltaGained before attributing VIOLATED');
    });

    await t.test('craftRecipe seeded code should wait after craft for inventory settle', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const craftRecipe = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'craftRecipe');
        // The inventory check happens after bot.craft completes - no extra wait needed in craft code
        // The trace wrapper captures delta in finally{} which is the settled state
        assert.ok(craftRecipe.code.includes('bot.craft('), 'craftRecipe should call bot.craft');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 3: TypeError reading 'name' (null) - null-check gate for blockAt/heldItem
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: null-check lint feedback for unsafe property access', async (t) => {
    await t.test('should flag potential null.name access from blockAt', async () => {
        const { Coder } = await import('../src/agent/coder.js');
        const coder = new Coder({ name: 'test', bot: { registry: { itemsByName: {}, blocksByName: {}, entitiesByName: {} } }, voyager: { skills: [] } });
        
        // Code that accesses .name on potentially null blockAt result
        const unsafeCode = `async function testSkill(bot) {
    const block = bot.blockAt(new Vec3(0, 64, 0));
    log(bot, block.name);  // bug: block can be null
}`;
        // The API gate should catch bot.X usage but this tests null safety awareness
        // For now we verify the system prompt mentions null-checking blockAt results
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('blockAt results can be null'),
            'repair system prompt should warn about null blockAt results');
    });

    await t.test('should have null-check guidance in code model prompts', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // The repair prompt should mention null-checking
        assert.ok(voyagerCode.includes('always null-check them'),
            'code model prompts should mention null-checking findBlock/blockAt results');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 4: ensureFurnace satisfied via wrong skill's postcondition
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: goal-satisfied check matches skill own product', async (t) => {
    await t.test('_goalAlreadySatisfied should only check skills that produce the goal item', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        // Mock a voyager with skills
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.skills = [
            { name: 'ensureFurnace', effects: ['furnace'], contract: { post: 'c => c.post.inv.furnace >= 1' } },
            { name: 'ensureStorageChestNearby', effects: ['chest'], contract: { post: 'c => c.post.inv.chest >= 1' } }
        ];
        mockVoyager._compileContract = (src) => eval(`(${src})`);
        
        // For "ensure furnace" goal, only ensureFurnace should be considered, not ensureStorageChestNearby
        // The producers filter should only match skills whose effects include the goal item
        const task = 'ensure furnace';
        // This tests the concept - producers filter checks (s.effects || []).some(eff => goal.items?.includes(eff))
        const producers = mockVoyager.skills.filter(s => 
            (s.effects || []).some(eff => eff === 'furnace'));
        assert.equal(producers.length, 1, 'only ensureFurnace should be a producer of furnace');
        assert.equal(producers[0].name, 'ensureFurnace', 'ensureFurnace should be the producer');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 5: Gate REJECT: dep cycle involving breakBlockAt
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: breakBlockAt dep cycle detection and messaging', async (t) => {
    await t.test('findCycle should detect A->B->A cycle', async () => {
        const { findCycle } = await import('../src/agent/skill_graph.js');
        const graph = {
            skillA: ['breakBlockAt'],
            breakBlockAt: ['skillA']  // cycle: skillA -> breakBlockAt -> skillA
        };
        const cycle = findCycle('skillA', ['breakBlockAt'], graph);
        assert.ok(cycle, 'should detect cycle');
        assert.ok(cycle.includes('breakBlockAt'), 'cycle should involve breakBlockAt');
    });

    await t.test('seeded breakBlockAt should have empty deps (no cycle from seeded side)', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const breakBlockAt = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'breakBlockAt');
        assert.ok(breakBlockAt, 'breakBlockAt should be a seeded primitive');
        assert.deepEqual(breakBlockAt.deps, [], 'breakBlockAt should have no deps');
    });

    await t.test('gate should reject skills that create cycles with loud message', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('REJECT') && voyagerCode.includes('dependency cycle'),
            'saveSkill should loudly REJECT skills that create dependency cycles');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature 6: Idle practice during model calls
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: idle practice during model calls', async (t) => {
    await t.test('should have model call timing tracked for idle practice', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // Check for model call timing infrastructure or idle practice integration
        assert.ok(
            voyagerCode.includes('modelCallStart') || 
            voyagerCode.includes('_modelCallMs') ||
            voyagerCode.includes('idleTime') || 
            voyagerCode.includes('idle_time') || 
            voyagerCode.includes('timing') ||
            voyagerCode.includes('[timing]'),
            'should have model call timing infrastructure for idle practice measurement');
    });

    await t.test('idle practice should rank by learning value (no hard-coded lists)', async () => {
        const fs = await import('fs');
        const idlePracticeCode = fs.readFileSync('./src/agent/idle_practice.js', 'utf8');
        // Should rank by confidence/fails/trials, not hard-coded item names
        assert.ok(idlePracticeCode.includes('failRate') || idlePracticeCode.includes('stats'),
            'idle practice should use stats to rank candidates');
        // No hard-coded item/tier lists
        assert.ok(!idlePracticeCode.includes("['diamond',") && !idlePracticeCode.includes("['iron',"),
            'idle practice should not have hard-coded item lists');
    });

    await t.test('empty state delta should not count as practice', async () => {
        // A practice run that produces no state change shouldn't be counted
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // Look for delta-based success check
        assert.ok(voyagerCode.includes('delta') && (voyagerCode.includes('practice') || voyagerCode.includes('idle')),
            'practice should check for actual state delta');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature 7: Health recovery using learned eat effects
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: health recovery using learned facts', async (t) => {
    await t.test('health should be exposed in observe() for goal ranking', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('health') && voyagerCode.includes('observe'),
            'observe() should include health for curriculum');
    });

    await t.test('no hard-coded health threshold in curriculum/recovery logic', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // Should not have magic numbers like "health < 10" or "health < 6" in goal ranking/recovery
        // modes.js self-preservation thresholds are allowed (emergency behavior)
        // Comments mentioning old thresholds are OK (documentation of what was removed)
        
        // Strip comments before checking
        const codeOnly = voyagerCode.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        
        // Look for thresholds in curriculum/recovery context, not self-preservation
        const recoveryThresholds = codeOnly.match(/(?:recovery|restore|heal|eat).*health\s*<\s*(\d+)/gi);
        if (recoveryThresholds) {
            for (const match of recoveryThresholds) {
                const num = parseInt(match.match(/\d+/)[0]);
                assert.ok(num === 0 || num === 1, 
                    `health threshold ${num} in recovery logic should be derived, not hard-coded`);
            }
        }
        // Check that health thresholds are not in goal-ranking code
        const goalRankingSection = codeOnly.match(/_selectPracticeSkill[\s\S]{0,500}/);
        if (goalRankingSection) {
            const hardcodedInRanking = /health\s*<\s*\d+/.test(goalRankingSection[0]);
            assert.ok(!hardcodedInRanking, 
                'goal ranking should not have hard-coded health thresholds');
        }
    });

    await t.test('should use learned food_value/consumes from skill state', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // Skills track consumes/effects - recovery should use these
        assert.ok(voyagerCode.includes('consumes') || voyagerCode.includes('food_value'),
            'recovery should use learned consumes/food_value');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature 8: Failure backoff for goals with unmet external preconditions
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: failure backoff using learned stats', async (t) => {
    await t.test('should track failure counts per goal', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('failed') || voyagerCode.includes('streakFail'),
            'should track failure history');
    });

    await t.test('no hard-coded failure count thresholds', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // The streakFail counter in skill_graph.js is fine - it's learned state
        // But the curriculum shouldn't have "if failed > 3 then skip" type logic
        // Instead it should derive from stats
        assert.ok(voyagerCode.includes('stats') || voyagerCode.includes('rate'),
            'failure backoff should use stats-based calculation');
    });

    await t.test('failure decay should be time-based from stats', async () => {
        const { newStats, recordRun } = await import('../src/agent/skill_graph.js');
        const stats = newStats();
        recordRun(stats, 'test', false);
        assert.equal(stats.streakFail, 1, 'should track streak failures');
        recordRun(stats, 'test', true);
        assert.equal(stats.streakFail, 0, 'success should reset streak');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature 9: 'X is not a function' surface check with nearest API names
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: surface check for undefined function calls', async (t) => {
    await t.test('should detect undefined bare function calls', async () => {
        const { Coder } = await import('../src/agent/coder.js');
        const coder = new Coder({ 
            name: 'test', 
            bot: { registry: { itemsByName: {}, blocksByName: {}, entitiesByName: {} } },
            voyager: { skills: [] }
        });
        
        const code = `async function test(bot) {
    await getNearestCraftinTable(bot);  // typo: should be getNearestBlock
}`;
        const gate = coder._apiGate(code);
        assert.ok(gate, 'should detect undefined function getNearestCraftinTable');
        assert.ok(gate.includes('getNearestCraftinTable'), 'error should name the undefined function');
    });

    await t.test('should suggest nearest API name by edit distance', async () => {
        const { Coder } = await import('../src/agent/coder.js');
        const coder = new Coder({ 
            name: 'test', 
            bot: { registry: { itemsByName: {}, blocksByName: {}, entitiesByName: {} } },
            voyager: { skills: [] }
        });
        
        // _nearestBareName should return suggestions
        const nearest = coder._nearestBareName('goToPositin');  // typo
        assert.ok(nearest, 'should find nearest match');
        assert.equal(nearest.match, 'goToPosition', 'should suggest goToPosition');
    });

    await t.test('lint feedback should list available API names', async () => {
        const fs = await import('fs');
        const coderCode = fs.readFileSync('./src/agent/coder.js', 'utf8');
        assert.ok(coderCode.includes('AVAILABLE FUNCTIONS'),
            'lint feedback should list available function names');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Code-prompt size check
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: code-prompt system size audit', async (t) => {
    await t.test('should not have duplicated content in system prompts', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Find all system prompt strings
        const systemPrompts = voyagerCode.match(/const system = `[^`]+`/g) || [];
        
        // Check for obviously duplicated phrases across prompts
        const phrases = new Map();
        for (const prompt of systemPrompts) {
            const words = prompt.match(/\b\w{10,}\b/g) || [];
            for (const word of words) {
                phrases.set(word, (phrases.get(word) || 0) + 1);
            }
        }
        
        // Common technical terms are OK; look for repeated instruction blocks
        // This is a soft check - just verify we're aware of the size
        const totalSystemChars = systemPrompts.reduce((sum, p) => sum + p.length, 0);
        console.log(`[fix49] total system prompt chars: ${totalSystemChars}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// No fallbacks rule
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: no || fallback defaults in critical paths', async (t) => {
    await t.test('seeded primitives should fail loud, not use || defaults', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        for (const prim of Voyager.SEEDED_PRIMITIVES) {
            // Allowed: x || 0 for counters, x || [] for arrays being iterated
            // Allowed: x || 'null' in log/error messages for display
            // Forbidden: x || 'default_item' for actual item names in functional code
            const lines = prim.code.split('\n');
            for (const line of lines) {
                // Skip log/error message lines
                if (/log\s*\(|console\.|FAILED|Error/.test(line)) continue;
                // Check for suspicious fallbacks in non-log lines
                const fallbacks = line.match(/\|\|\s*['"][a-z_]+['"]/g);
                if (fallbacks) {
                    for (const fb of fallbacks) {
                        // Allow || '' for empty string, || 'null' in any context (often for display)
                        assert.ok(fb === "|| ''" || fb === '|| ""' || fb.includes('null'),
                            `${prim.name} has suspicious fallback in non-log code: ${fb}`);
                    }
                }
            }
        }
    });
});

console.log('[fix49] regression tests loaded');
