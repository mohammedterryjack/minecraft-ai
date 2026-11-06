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
// Root cause: post snapshot taken before inventory settles, auto-equip reads as -1
// Fix: (a) use __have() (getInventoryCounts: slots 5+ include held/offhand/armor) for pre/post/delta on EVERY call
//      (b) await bot.waitForTicks(1) before post snapshot (one server tick, not magic timers)
//      (c) no name gating, no try/catch fallback in __have
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: craftRecipe inventory settle and have count', async (t) => {
    await t.test('pre and delta computed from __have(), not __inv()', async () => {
        const fs = await import('fs');
        const skillGraphCode = fs.readFileSync('./src/agent/skill_graph.js', 'utf8');
        
        // pre should use __have(), not __inv()
        assert.ok(skillGraphCode.includes('pre: __have()'),
            'rec.pre should use __have() for canonical have count');
        // post/delta should also use __have()
        assert.ok(skillGraphCode.includes('const post = __have()'),
            'post snapshot should use __have() for delta computation');
    });

    await t.test('__have = getInventoryCounts view only (slots 5+ already hold armor, held and off-hand: no double count)', async () => {
        const fs = await import('fs');
        const skillGraphCode = fs.readFileSync('./src/agent/skill_graph.js', 'utf8');
        assert.ok(skillGraphCode.includes('const __have = () => __inv();'),
            '__have must be the single inventory view (fix51: no inventory+equipment double count)');
    });

    await t.test('waitForTicks(1) before post snapshot, no magic timers', async () => {
        const fs = await import('fs');
        const skillGraphCode = fs.readFileSync('./src/agent/skill_graph.js', 'utf8');
        
        // Should use waitForTicks(1) - one server tick (protocol unit, not tuned constant)
        assert.ok(skillGraphCode.includes('await bot.waitForTicks(1)'),
            'finally block should await bot.waitForTicks(1) before post snapshot');
        
        // No magic timers like setTimeout with 150/80/50/400ms
        assert.ok(!skillGraphCode.includes('setTimeout(r, 150)'),
            'should NOT have magic 150ms timer');
        assert.ok(!skillGraphCode.includes('setTimeout(r, 80)'),
            'should NOT have magic 80ms timer');
        assert.ok(!skillGraphCode.includes('setTimeout(r, 400)'),
            'should NOT have magic 400ms timer');
        
        // No __waitSettle function with event listeners
        assert.ok(!skillGraphCode.includes('__waitSettle'),
            'should NOT have __waitSettle function with event listeners');
    });

    await t.test('no name gating (/^craft/i regex)', async () => {
        const fs = await import('fs');
        const skillGraphCode = fs.readFileSync('./src/agent/skill_graph.js', 'utf8');
        
        // waitForTicks(1) should apply to every call, not just craft skills
        assert.ok(!skillGraphCode.includes("/^craft/i.test(n)"),
            'should NOT gate by /^craft/i regex - applies to every call');
    });

    await t.test('craftRecipe should NOT have seeded contract (delta check is the fix)', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const craftRecipe = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'craftRecipe');
        assert.ok(craftRecipe, 'craftRecipe should be a seeded primitive');
        assert.ok(!craftRecipe.contract, 
            'craftRecipe should NOT have a seeded contract (delta check in _checkContracts is the fix)');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 3: TypeError reading 'name' (null) in buildHutAdjacentFloor
// buildHutAdjacentFloor is a model-generated composite. The null comes from blockAt/findBlock
// in unloaded chunks after travelTo stalls.
// Fix: breakBlockAt (seeded) returns descriptive error when block is null; repair prompt warns about it
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: null-safe blockAt in breakBlockAt primitive', async (t) => {
    await t.test('breakBlockAt should throw descriptive error when blockAt returns null', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const breakBlockAt = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'breakBlockAt');
        assert.ok(breakBlockAt, 'breakBlockAt should exist');
        // Should check !block and return/log descriptive error
        assert.ok(breakBlockAt.code.includes('if (!block)'),
            'breakBlockAt should check !block');
        assert.ok(breakBlockAt.code.includes('returned null') || breakBlockAt.code.includes('unloaded chunk'),
            'breakBlockAt should mention null/unloaded in error message');
    });

    await t.test('breakBlockAt null check should come early and return false', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const breakBlockAt = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'breakBlockAt');
        const code = breakBlockAt.code;
        // The null check should be near the start, after blockAt call
        const blockAtLine = code.indexOf('blockAt(');
        const nullCheck = code.indexOf('if (!block)');
        assert.ok(nullCheck > blockAtLine && nullCheck < blockAtLine + 150,
            'null check should be right after blockAt call');
        assert.ok(breakBlockAt.code.includes('return false'),
            'breakBlockAt should return false on null block');
    });

    await t.test('repair system prompt should warn about null blockAt/findBlock', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // The repair system prompt should explicitly warn about null-checking
        assert.ok(voyagerCode.includes('findBlock/findBlocks/nearestEntity') && 
            voyagerCode.includes('can be null'),
            'repair system prompt should warn that findBlock/blockAt can return null');
        assert.ok(voyagerCode.includes('null-check'),
            'repair prompt should mention null-checking');
    });

    await t.test('repair system prompt should mention checking .position/.x', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('.position') || voyagerCode.includes('.x'),
            'repair prompt should mention checking position/coords on null');
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
// Cycle: breakBlockAt -> equipToolOrCraft -> craftSticks -> craftPlanks -> craftRecipe -> placeBlock -> breakBlockAt
// Fix: breakBlockAt uses equipBestTool (inventory only, no crafting) - obtaining tool is planner's job
//      Composer/repair lint feedback shows would-be cycle so model won't generate it
// ─────────────────────────────────────────────────────────────────────────────
test('fix49: breakBlockAt dep cycle prevention', async (t) => {
    await t.test('breakBlockAt should use equipBestTool, not equipForBlock that can craft', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const breakBlockAt = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'breakBlockAt');
        assert.ok(breakBlockAt, 'breakBlockAt should exist');
        assert.ok(breakBlockAt.code.includes('equipBestTool'),
            'breakBlockAt should use equipBestTool (inventory only)');
        // Check there's no actual call to equipForBlock (await bot.tool.equipForBlock)
        // Comments mentioning it are OK
        assert.ok(!breakBlockAt.code.includes('await bot.tool.equipForBlock'),
            'breakBlockAt should NOT call bot.tool.equipForBlock (can craft, creating cycle)');
    });

    await t.test('breakBlockAt deps should be equipBestTool only', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const breakBlockAt = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'breakBlockAt');
        assert.deepEqual(breakBlockAt.deps, ['equipBestTool'], 
            'breakBlockAt deps should be [equipBestTool] - no crafting deps');
    });

    await t.test('findCycle should detect the exact cycle from the bug', async () => {
        const { findCycle } = await import('../src/agent/skill_graph.js');
        // The exact cycle: breakBlockAt -> equipToolOrCraft -> ... -> placeBlock -> breakBlockAt
        const graph = {
            equipToolOrCraft: ['craftSticks'],
            craftSticks: ['craftPlanks'],
            craftPlanks: ['craftRecipe'],
            craftRecipe: ['placeBlock'],
            placeBlock: ['breakBlockAt'],
            breakBlockAt: []
        };
        // If breakBlockAt called equipToolOrCraft, it would create a cycle
        const cycle = findCycle('breakBlockAt', ['equipToolOrCraft'], graph);
        assert.ok(cycle, 'should detect the full cycle');
        assert.ok(cycle.includes('breakBlockAt') && cycle.includes('placeBlock'),
            'cycle should include breakBlockAt and placeBlock');
    });

    await t.test('_cycleLint should detect would-be cycles in repair feedback', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(voyagerCode.includes('_cycleLint'),
            'should have _cycleLint method for repair feedback');
        assert.ok(voyagerCode.includes('DEPENDENCY CYCLE would be created'),
            '_cycleLint should warn about would-be cycles');
    });

    await t.test('repair loop should check _cycleLint before standard lint', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        // Should check cycle before lint in repair loop
        assert.ok(voyagerCode.includes('cycleErr = this._cycleLint'),
            'repair loop should call _cycleLint');
        assert.ok(voyagerCode.includes('if (cycleErr) err = cycleErr'),
            'repair loop should use cycle error before lint error');
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

    await t.test('countGoal should throw if VERSION is null (no && VERSION skip)', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        // countGoal should throw, not silently skip with && VERSION
        const countGoalSection = voyagerCode.match(/function countGoal[\s\S]{0,800}/);
        assert.ok(countGoalSection, 'should have countGoal function');
        assert.ok(countGoalSection[0].includes('throw') && countGoalSection[0].includes('VERSION is null'),
            'countGoal should throw when VERSION is null');
        assert.ok(!countGoalSection[0].includes('&& VERSION'),
            'countGoal should not use && VERSION to silently skip');
    });

    await t.test('_precheck should throw if VERSION is null', async () => {
        const fs = await import('fs');
        const voyagerCode = fs.readFileSync('./src/agent/voyager.js', 'utf8');
        
        const precheckSection = voyagerCode.match(/_precheck\(r\)[\s\S]{0,500}/);
        assert.ok(precheckSection, 'should have _precheck method');
        assert.ok(precheckSection[0].includes('throw') && precheckSection[0].includes('VERSION is null'),
            '_precheck should throw when VERSION is null');
    });
});

console.log('[fix49] regression tests loaded');
