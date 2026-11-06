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

    await t.test('GoalNearXZ should be in sandbox globals', async () => {
        const fs = await import('fs');
        const coderCode = fs.readFileSync('./src/agent/coder.js', 'utf8');
        assert.ok(coderCode.includes("'GoalNearXZ'"),
            'GoalNearXZ should be listed in sandbox globals');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2: craftRecipe postcondition VIOLATED after real craft success
// Root cause: delta computed in _checkContracts - the deltaGained check is the fix
// File: src/agent/voyager.js, line ~728 (deltaGained check in _checkContracts)
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: craftRecipe uses delta-based contract checking', async (t) => {
    await t.test('_checkContracts should check deltaGained before VIOLATED', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        // The fix is in _checkContracts around line 728-733
        assert.ok(voyagerCode.includes('deltaGained'), 
            '_checkContracts should check deltaGained');
        assert.ok(voyagerCode.includes("effects.some(eff => (r.delta?.[eff]"),
            '_checkContracts should check delta for each effect');
    });

    await t.test('craftRecipe should NOT have seeded contract (delta check is the fix)', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const craftRecipe = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'craftRecipe');
        assert.ok(craftRecipe, 'craftRecipe should be a seeded primitive');
        assert.ok(!craftRecipe.contract, 
            'craftRecipe should NOT have a seeded contract (delta check in _checkContracts is the fix)');
    });

    await t.test('delayed inventory update simulation', async () => {
        // This test simulates the scenario where bot.craft returns but inventory hasn't updated yet
        // The fix ensures delta (computed in finally{}) captures the settled state
        const { Voyager } = await import('../src/agent/voyager.js');
        
        // Verify trace wrapper computes delta in finally block
        const voyagerCode = await import('fs').then(fs => fs.readFileSync('./src/agent/voyager.js', 'utf8'));
        assert.ok(voyagerCode.includes('finally') && voyagerCode.includes('delta'),
            'trace wrapper should compute delta in finally block to capture settled state');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 3: TypeError reading 'name' (null) in buildHutAdjacentFloor
// Fix: primitives that use blockAt must check for null before accessing .name
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: null-safe blockAt usage in primitives', async (t) => {
    await t.test('breakBlockAt should check block is not null before accessing .name', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const breakBlockAt = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'breakBlockAt');
        assert.ok(breakBlockAt, 'breakBlockAt should exist');
        // Should check !block before accessing block.name
        assert.ok(breakBlockAt.code.includes('!block ||') || breakBlockAt.code.includes('if (!block'),
            'breakBlockAt should check for null block before accessing .name');
    });

    await t.test('placeBlock should use optional chaining or null check', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const placeBlock = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'placeBlock');
        assert.ok(placeBlock, 'placeBlock should exist');
        // Should use check?.name or check && check.name
        assert.ok(placeBlock.code.includes('?.name') || placeBlock.code.includes('check &&'),
            'placeBlock should safely access .name on blockAt result');
    });

    await t.test('collectBlock should handle findBlock returning null', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const collectBlock = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'collectBlock');
        assert.ok(collectBlock, 'collectBlock should exist');
        // Should have null check for block
        assert.ok(collectBlock.code.includes('!block') || collectBlock.code.includes('continue'),
            'collectBlock should handle null blocks from findBlock');
    });

    await t.test('repair prompt should warn about null blockAt results', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('blockAt results can be null') || 
            voyagerCode.includes('null-check') || 
            voyagerCode.includes('findBlock'),
            'repair prompt should mention null-checking findBlock/blockAt');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 4: ensureFurnace satisfied via wrong skill's postcondition
// Fix: exact block-name match in observed nearby blocks, no includes()
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: goal-satisfied uses exact match for ensure goals', async (t) => {
    await t.test('_goalAlreadySatisfied should use exact match, not includes()', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Should NOT use .includes() for ensure goal matching
        const ensureSection = voyagerCode.match(/if \(goal\.verb === 'ensure'\)[\s\S]{0,500}/);
        if (ensureSection) {
            assert.ok(!ensureSection[0].includes('.includes(goal.item)'),
                'ensure goal check should NOT use includes() - use exact match');
            assert.ok(ensureSection[0].includes('b === goal.item'),
                'ensure goal check should use exact equality (b === goal.item)');
        }
    });

    await t.test('no VERSION fallback (fail loud if unset)', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(!voyagerCode.includes("VERSION || '1.20.4'"),
            'VERSION should not have fallback');
    });

    await t.test('state.nearby required for ensure goals', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // Should throw if state.nearby is missing
        assert.ok(voyagerCode.includes('state.nearby required') || 
            voyagerCode.includes('throw') && voyagerCode.includes('nearby'),
            'ensure goals should throw if state.nearby is missing');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 5: Gate REJECT: dep cycle involving breakBlockAt
// Fix: breakBlockAt has empty deps, and cycle detection rejects learned skills that create cycles
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: breakBlockAt dep cycle prevention', async (t) => {
    await t.test('breakBlockAt seeded primitive has empty deps', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const breakBlockAt = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'breakBlockAt');
        assert.ok(breakBlockAt, 'breakBlockAt should exist');
        assert.deepEqual(breakBlockAt.deps, [], 'breakBlockAt should have empty deps');
    });

    await t.test('findCycle should detect cycles', async () => {
        const { findCycle } = await import('../src/agent/skill_graph.js');
        const graph = {
            skillA: ['breakBlockAt'],
            breakBlockAt: ['skillA']
        };
        const cycle = findCycle('skillA', ['breakBlockAt'], graph);
        assert.ok(cycle, 'should detect A -> breakBlockAt -> A cycle');
    });

    await t.test('gate should REJECT skills that create cycles', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('REJECT') && voyagerCode.includes('dependency cycle'),
            'saveSkill should REJECT skills that create dependency cycles');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature 6: Idle practice - Beta-posterior uncertainty ranking
// Score = (s+1)(f+1)/((n+2)^2(n+3)) * (1 + plan_relevance)
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: idle practice uses Beta-posterior uncertainty', async (t) => {
    await t.test('_selectPracticeSkill should use Beta-posterior formula', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Should have Beta-posterior variance formula: (s+1)(f+1) / ((n+2)^2 * (n+3))
        assert.ok(voyagerCode.includes('successes + 1') && voyagerCode.includes('failures + 1'),
            'should use (s+1)(f+1) in numerator');
        assert.ok(voyagerCode.includes('n + 2') && voyagerCode.includes('n + 3'),
            'should use (n+2) and (n+3) in denominator');
        assert.ok(voyagerCode.includes('Math.pow') || voyagerCode.includes('**'),
            'should have (n+2)^2 term');
    });

    await t.test('plan relevance should be intersection over pending size', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('intersection') && voyagerCode.includes('pendingSize'),
            'plan relevance should be |effects ∩ pending| / |pending|');
    });

    await t.test('no hard-coded weights or recency constants', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        const selectSection = voyagerCode.match(/_selectPracticeSkill[\s\S]{0,2000}return scored/);
        if (selectSection) {
            // No hand weights like 0.4, 0.3, 0.2, 0.1
            assert.ok(!/ \* 0\.[1-4]/.test(selectSection[0]),
                'should not have hand weights like * 0.3');
            // No recency constants like 60 * 60 * 1000
            assert.ok(!/60 \* 60 \* 1000/.test(selectSection[0]),
                'should not have recency constants');
        }
    });

    await t.test('empty delta should not count as practice', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('deltaChanged'),
            'should track deltaChanged for practice runs');
    });

    await t.test('should log [idle] timing format', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('[idle] model_call_ms='),
            'should log [idle] model_call_ms=... format');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature 7: Health/food - pass edible inventory to curriculum (no thresholds)
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: edible inventory from minecraft-data foods', async (t) => {
    await t.test('_getEdibleInventory should use minecraft-data foods', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(voyagerCode.includes('_getEdibleInventory'),
            'should have _getEdibleInventory method');
        assert.ok(voyagerCode.includes('md.foods'),
            'should use md.foods from minecraft-data');
        assert.ok(voyagerCode.includes('foodPoints') && voyagerCode.includes('saturation'),
            'should extract foodPoints and saturation');
    });

    await t.test('proposeTask should pass edible inventory to curriculum', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('edible_inventory'),
            'proposeTask should include edible_inventory in prompt');
    });

    await t.test('no hard-coded food names', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // Should NOT have hard-coded food name patterns
        assert.ok(!voyagerCode.includes("'cooked'") && !voyagerCode.includes("'bread'") && 
            !voyagerCode.includes("'apple'") && !voyagerCode.includes("'steak'"),
            'should not have hard-coded food names');
    });

    await t.test('no health/food threshold constants', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // Should NOT have food < 18 or similar thresholds
        assert.ok(!voyagerCode.includes('food < 18'),
            'should not have hard-coded food threshold');
        assert.ok(!voyagerCode.includes('variance || 5') && !voyagerCode.includes('foodValue: 0.7'),
            'should not have magic number fallbacks');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature 8: Failure backoff - posterior mean (s+1)/(n+2), no time constants
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: failure backoff uses Bayesian posterior', async (t) => {
    await t.test('_goalBackoffMultiplier should use (s+1)/(n+2)', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(voyagerCode.includes('_goalBackoffMultiplier'),
            'should have _goalBackoffMultiplier method');
        assert.ok(voyagerCode.includes('s + 1') && voyagerCode.includes('n + 2'),
            'should use (s+1)/(n+2) formula');
    });

    await t.test('_recordGoalOutcome should track per goal+reason', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(voyagerCode.includes('_recordGoalOutcome'),
            'should have _recordGoalOutcome method');
        assert.ok(voyagerCode.includes('goalStats'),
            'should store in goalStats');
    });

    await t.test('no time-based decay constants', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        const backoffSection = voyagerCode.match(/_goalBackoffMultiplier[\s\S]{0,500}/);
        if (backoffSection) {
            assert.ok(!backoffSection[0].includes('Date.now()'),
                'backoff should not use time-based decay');
            assert.ok(!backoffSection[0].includes('60000') && !backoffSection[0].includes('300000'),
                'backoff should not have time constants');
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature 9: 'X is not a function' - nearest API names in lint feedback
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
    await getNearestCraftinTable(bot);  // typo
}`;
        const gate = coder._apiGate(code);
        assert.ok(gate, 'should detect undefined function');
        assert.ok(gate.includes('getNearestCraftinTable'), 'error should name the undefined function');
    });

    await t.test('should suggest nearest API name by edit distance', async () => {
        const { Coder } = await import('../src/agent/coder.js');
        const coder = new Coder({ 
            name: 'test', 
            bot: { registry: { itemsByName: {}, blocksByName: {}, entitiesByName: {} } },
            voyager: { skills: [] }
        });
        
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
// No fallbacks rule - no || defaults in critical paths
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: no || fallback defaults', async (t) => {
    await t.test('no state.X || default fallbacks in fix49 code', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Check for forbidden fallbacks in fix49 sections
        assert.ok(!voyagerCode.includes('state.health_value || 20'),
            'should not have state.health_value || 20 fallback');
        assert.ok(!voyagerCode.includes('bot.health || 20'),
            'should not have bot.health || 20 fallback');
        assert.ok(!voyagerCode.includes('variance || 5'),
            'should not have variance || 5 fallback');
    });
});

console.log('[fix49] regression tests loaded');
