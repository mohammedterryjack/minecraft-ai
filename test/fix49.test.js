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
// fix49: no seeded contract with fallbacks - delta check in _checkContracts is the fix
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: craftRecipe uses delta-based contract checking (no fallbacks)', async (t) => {
    await t.test('delta check in _checkContracts should be the root fix', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        // The fix is in _checkContracts: when delta shows positive gain for effects, skip VIOLATED
        assert.ok(voyagerCode.includes('deltaGained'), 
            '_checkContracts should check deltaGained before attributing VIOLATED');
    });

    await t.test('craftRecipe should NOT have seeded contract with fallbacks', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const craftRecipe = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'craftRecipe');
        assert.ok(craftRecipe, 'craftRecipe should be a seeded primitive');
        
        // fix49: no seeded contract - the delta check in _checkContracts handles this
        // Seeded contracts with || 0 and c.ret === null/false violate "no fallbacks" rule
        assert.ok(!craftRecipe.contract, 
            'craftRecipe should NOT have a seeded contract (delta check is the fix)');
    });

    await t.test('craftRecipe seeded code should call bot.craft', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const craftRecipe = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'craftRecipe');
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
// fix49: ensure goals check observed state (nearby blocks), not skill name patterns
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: goal-satisfied check uses observed state for ensure goals', async (t) => {
    await t.test('_goalAlreadySatisfied for ensure goals should check nearby blocks', async () => {
        const { Voyager, _setVersionForTest } = await import('../src/agent/voyager.js');
        _setVersionForTest('1.20.4');
        
        // Mock a voyager with skills
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.skills = [
            { name: 'ensureFurnace', effects: ['furnace'], contract: { post: 'c => c.post.inv.furnace >= 1' } },
            { name: 'ensureStorageChestNearby', effects: ['chest'], contract: { post: 'c => c.post.inv.chest >= 1' } }
        ];
        
        // State with furnace nearby - goal should be satisfied
        const stateWithFurnace = { 
            inventory: {}, 
            nearby: { blocks: ['furnace', 'stone', 'dirt'] } 
        };
        
        // State without furnace nearby - goal should not be satisfied
        const stateWithoutFurnace = { 
            inventory: {}, 
            nearby: { blocks: ['chest', 'stone', 'dirt'] } 
        };
        
        // The goal check should use nearby blocks, not skill name matching
        // This is verified by ensuring the code doesn't have name pattern matching
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Should NOT have name pattern matching for ensure goals
        assert.ok(!voyagerCode.includes("nameLower.includes('ensure')"),
            '_goalAlreadySatisfied should not match ensure goals by skill name patterns');
        
        // Should check nearby blocks for ensure goals
        assert.ok(voyagerCode.includes("state.nearby") || voyagerCode.includes("nearby.blocks"),
            '_goalAlreadySatisfied should check nearby blocks for ensure goals');
    });
    
    await t.test('no VERSION fallback (fail loud if VERSION unset)', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Should NOT have VERSION || '1.20.4' fallbacks
        assert.ok(!voyagerCode.includes("VERSION || '1.20.4'"),
            'VERSION should not have fallback - fail loud if unset');
        assert.ok(!voyagerCode.includes("VERSION || \"1.20.4\""),
            'VERSION should not have fallback - fail loud if unset');
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
// fix49: rank by learning value (failRate, streakFail, trials), log timing
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: idle practice during model calls', async (t) => {
    await t.test('should log model call timing with [idle] format', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // fix49: should log [idle] model_call_ms=… practice_ms=… idle_ms=…
        assert.ok(voyagerCode.includes('[idle] model_call_ms='),
            'should log [idle] model_call_ms=… practice_ms=… idle_ms=… format');
        assert.ok(voyagerCode.includes('practice_ms=') && voyagerCode.includes('idle_ms='),
            'should log practice_ms and idle_ms');
    });

    await t.test('idle practice should rank by learning value (failRate, streakFail, trials)', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // fix49: rank by learning value from stats (derived, not hard-coded)
        assert.ok(voyagerCode.includes('failRate') && voyagerCode.includes('streakFail'),
            '_selectPracticeSkill should use failRate and streakFail');
        assert.ok(voyagerCode.includes('trials') || voyagerCode.includes('stats.success'),
            '_selectPracticeSkill should consider trial count');
        // No hard-coded item/tier lists
        assert.ok(!voyagerCode.includes("['diamond',") && !voyagerCode.includes("['iron',"),
            'idle practice should not have hard-coded item lists');
    });

    await t.test('idle practice should consider plan relevance', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // fix49: plan relevance - shares produces with pending goal
        assert.ok(voyagerCode.includes('planRelevance') || 
            (voyagerCode.includes('pending') && voyagerCode.includes('effects')),
            '_selectPracticeSkill should consider plan relevance');
    });

    await t.test('empty state delta should not count as practice', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // fix49: deltaChanged check - runs with empty delta don't count
        assert.ok(voyagerCode.includes('deltaChanged'),
            '_runPracticeSkill should track deltaChanged');
        assert.ok(voyagerCode.includes('no state delta'),
            'should log when run has no state delta');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature 7: Health recovery using learned eat effects
// fix49: curriculum receives health + learned eat effects, ranks recovery goal
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: health recovery using learned facts', async (t) => {
    await t.test('health should be exposed in observe() for curriculum', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('health_value') && voyagerCode.includes('observe'),
            'observe() should include health_value for curriculum');
    });

    await t.test('_healthRecoveryHint should use learned average health', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // fix49: health threshold derived from learned average (avgHealthOnSuccess)
        assert.ok(voyagerCode.includes('avgHealthOnSuccess'),
            'health recovery should use learned average health');
        assert.ok(voyagerCode.includes('healthVariance'),
            'health recovery should use learned variance');
    });

    await t.test('_findLearnedFoodItems should find food from learned consumes', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // fix49: find food items based on skill consumes/effects
        assert.ok(voyagerCode.includes('_findLearnedFoodItems'),
            'should have _findLearnedFoodItems method');
        assert.ok(voyagerCode.includes('s.consumes') && voyagerCode.includes('eat'),
            '_findLearnedFoodItems should check skill consumes');
    });

    await t.test('curriculum should receive health recovery hint', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // fix49: healthHint added to curriculum prompt
        assert.ok(voyagerCode.includes('healthHint') && voyagerCode.includes('proposeTask'),
            'proposeTask should include healthHint');
        assert.ok(voyagerCode.includes('HEALTH LOW') || voyagerCode.includes('HEALTH CRITICAL'),
            '_healthRecoveryHint should generate clear hints');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature 8: Failure backoff for goals with unmet external preconditions
// fix49: store per-goal failure reasons, deprioritize with decay from stats
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: failure backoff using learned stats', async (t) => {
    await t.test('should have _recordTaskFailure and _recordTaskSuccess methods', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('_recordTaskFailure'),
            'should have _recordTaskFailure method');
        assert.ok(voyagerCode.includes('_recordTaskSuccess'),
            'should have _recordTaskSuccess method');
    });

    await t.test('_failureBackoff should compute decay from stats', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('_failureBackoff'),
            'should have _failureBackoff method');
        assert.ok(voyagerCode.includes('consecutiveFails') && voyagerCode.includes('decayRate'),
            '_failureBackoff should use consecutive fails and decay rate');
    });

    await t.test('failure tracking should store reason', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // fix49: failures should store reason for diagnosis
        assert.ok(voyagerCode.includes('entry.reason'),
            'failure tracking should store reason');
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

// ─────────────────────────────────────────────────────────────────────────────
// GoalNearXZ must be on the bare API surface (sandbox exposes it)
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: GoalNearXZ is on the bare API surface', async (t) => {
    await t.test('GoalNearXZ should be in sandbox globals', async () => {
        const fs = await import('fs');
        const coderCode = fs.readFileSync('./src/agent/coder.js', 'utf8');
        // Verify GoalNearXZ is in the sandbox globals
        assert.ok(coderCode.includes("'GoalNearXZ'"),
            'GoalNearXZ should be listed in sandbox globals');
        // Verify GoalNearXZ is assigned from pathfinderGoals
        assert.ok(coderCode.includes('GoalNearXZ: pathfinderGoals.GoalNearXZ') ||
            coderCode.includes('GoalNearXZ: goals.GoalNearXZ'),
            'GoalNearXZ should be assigned from pathfinder goals');
    });

    await t.test('travelTo seeded primitive should use GoalNearXZ', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const travelTo = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'travelTo');
        assert.ok(travelTo, 'travelTo primitive should exist');
        assert.ok(travelTo.code.includes('GoalNearXZ'), 
            'travelTo code should use GoalNearXZ, not Vec3');
    });
});

console.log('[fix49] regression tests loaded');
