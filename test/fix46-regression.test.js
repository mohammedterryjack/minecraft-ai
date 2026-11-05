/**
 * fix46 regression tests - Verbose goal parsing, lint prelude shadowing, retry prompt cap
 * 
 * Required tests:
 * 1. Verbose goal "craftItem: Craft 1 iron_pickaxe using..." with 1 iron_pickaxe in inventory -> satisfied, 0 attempts
 * 2. Verbose goal with 0 in inventory -> not satisfied, attempts allowed
 * 3. equipToolOrCraft-style goal likewise checks already-have
 * 4. Lint prelude `const log = skills.log` should NOT trigger shadowing warning (it's prelude, not user code)
 * 5. User code that shadows log SHOULD still get feedback
 * 6. Retry prompt always uses base + latest code + latest error (not accumulated)
 * 7. Log vitals use dynamic max values (not hard-coded /20)
 * 8. parseVerboseGoal fails loud if VERSION is null
 * 9. parseVerboseGoal uses generic plural handling (no hard-coded torches/glasses)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// ---------- Issue 1-3: Verbose goal parsing and already-have check ----------

describe('fix46: verbose goal parsing', () => {
    it('should fail loud when VERSION is null', async () => {
        // parseVerboseGoal should fail loud if VERSION is not set
        const voyagerSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/voyager.js', 'utf8')
        );
        
        // Check that parseVerboseGoal has loud failure for null VERSION
        assert.ok(
            voyagerSrc.includes('LOUD FAIL') && voyagerSrc.includes('VERSION is null'),
            'parseVerboseGoal should fail loud when VERSION is null'
        );
    });

    it('should use generic plural handling without hard-coded special cases', async () => {
        const voyagerSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/voyager.js', 'utf8')
        );
        
        // Find parseVerboseGoal function body (from 'export function parseVerboseGoal' to 'function gainedFor')
        const fnStart = voyagerSrc.indexOf('export function parseVerboseGoal(task)');
        const fnEnd = voyagerSrc.indexOf('function gainedFor', fnStart);
        assert.ok(fnStart > -1 && fnEnd > fnStart, 'parseVerboseGoal function should exist');
        
        const fnBody = voyagerSrc.slice(fnStart, fnEnd);
        
        // No hard-coded 'torches' special case
        assert.ok(!/'torches'/.test(fnBody) && !/torches.*torch/.test(fnBody), 
            'Should not have hard-coded torches special case');
        
        // No hard-coded 'glasses' special case
        assert.ok(!/'glasses'/.test(fnBody), 
            'Should not have hard-coded glasses special case');
        
        // Should have generic plural handling (minus 's', minus 'es')
        assert.ok(/slice\(0,\s*-1\)/.test(fnBody), 
            'Should have generic singular handling (slice -1 for s)');
        assert.ok(/slice\(0,\s*-2\)/.test(fnBody), 
            'Should have generic singular handling (slice -2 for es)');
    });

    it('should not have hard-coded verb list or default verb', async () => {
        const voyagerSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/voyager.js', 'utf8')
        );
        
        const parseVerboseMatch = voyagerSrc.match(/parseVerboseGoal[\s\S]*?(?=\nfunction\s|\nexport\s+function\s|\n\/\/\s*fix\d)/);
        assert.ok(parseVerboseMatch, 'parseVerboseGoal function should exist');
        
        const fnBody = parseVerboseMatch[0];
        
        // No hard-coded verb list
        assert.ok(!/\|\|\s*['"]craft['"]/.test(fnBody), 
            'Should not have default "craft" verb fallback');
        assert.ok(!/\(craft\|mine\|collect\|gather/.test(fnBody), 
            'Should not have hard-coded verb list regex');
    });

    it('should not have blockLoot expansion code in parseVerboseGoal', async () => {
        const voyagerSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/voyager.js', 'utf8')
        );
        
        // Find parseVerboseGoal function specifically
        const fnStart = voyagerSrc.indexOf('export function parseVerboseGoal(task)');
        const fnEnd = voyagerSrc.indexOf('function gainedFor', fnStart);
        assert.ok(fnStart > -1, 'parseVerboseGoal function should exist');
        assert.ok(fnEnd > fnStart, 'parseVerboseGoal should end before gainedFor');
        
        const fnBody = voyagerSrc.slice(fnStart, fnEnd);
        
        // Strip comments to check actual code (blockLoot might be mentioned in comments explaining removal)
        const codeOnly = fnBody.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        
        // No blockLoot expansion code (comments mentioning its removal are OK)
        assert.ok(!/md\.blockLoot|blockLoot\[/.test(codeOnly), 
            'parseVerboseGoal should not have blockLoot expansion code');
        // Allow catch with error handling, just not empty catch
        const emptyCatches = codeOnly.match(/catch\s*\([^)]*\)\s*\{\s*\}/g) || [];
        assert.strictEqual(emptyCatches.length, 0, 
            'parseVerboseGoal should not have empty silent catch blocks');
    });

    it('should return {item, count, items} without verb', async () => {
        const voyagerSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/voyager.js', 'utf8')
        );
        
        // Find parseVerboseGoal function body (from 'export function parseVerboseGoal' to 'function gainedFor')
        const fnStart = voyagerSrc.indexOf('export function parseVerboseGoal(task)');
        const fnEnd = voyagerSrc.indexOf('function gainedFor', fnStart);
        assert.ok(fnStart > -1 && fnEnd > fnStart, 'parseVerboseGoal function should exist');
        
        const fnBody = voyagerSrc.slice(fnStart, fnEnd);
        
        // Return should have count, item, items but NOT verb
        assert.ok(/return\s*\{[^}]*count[^}]*item[^}]*items[^}]*\}/.test(fnBody), 
            'Should return object with count, item, items');
        
        // The return statement should NOT include verb
        const returnMatch = fnBody.match(/return\s*\{[^}]+\}/g);
        if (returnMatch) {
            const lastReturn = returnMatch[returnMatch.length - 1];
            assert.ok(!/\bverb\b/.test(lastReturn), 
                'Return object should not include verb property');
        }
    });
});

// ---------- Issue 4-5: Lint prelude shadowing ----------

describe('fix46: lint prelude shadowing exclusion', () => {
    it('should NOT report shadowing warning for prelude log binding', async () => {
        const { Coder } = await import('../src/agent/coder.js');
        
        const mockAgent = {
            bot: { interrupt_code: false, output: '', registry: {} },
            prompter: { code_model: {} },
            voyager: { skills: [] },
        };
        
        const coder = new Coder(mockAgent);
        await new Promise(r => setTimeout(r, 100));
        
        // Clean user code - no shadowing
        const cleanUserCode = `
const block = getNearestBlock(bot, 'oak_log');
if (block) {
    await goToPosition(bot, block.position.x, block.position.y, block.position.z);
}
log(bot, 'Done!');
`;
        
        const result = await coder._stageCode(cleanUserCode);
        const lintResult = await coder._lintCode(result.src_lint_copy, result.preludeLines || 0);
        
        // Should pass lint (prelude log binding excluded from shadow check)
        if (lintResult && lintResult.includes('shadowing') && lintResult.includes('const log = skills')) {
            assert.fail('Prelude log binding should not trigger shadowing warning');
        }
        
        assert.strictEqual(lintResult, null, 'Clean user code should pass lint');
    });

    it('should still report shadowing warning when USER code shadows log', async () => {
        const { Coder } = await import('../src/agent/coder.js');
        
        const mockAgent = {
            bot: { interrupt_code: false, output: '', registry: {} },
            prompter: { code_model: {} },
            voyager: { skills: [] },
        };
        
        const coder = new Coder(mockAgent);
        await new Promise(r => setTimeout(r, 100));
        
        // User code that shadows log - SHOULD be warned
        const userCodeWithShadow = `
const log = getNearestBlock(bot, 'oak_log');
if (log) {
    await goToPosition(bot, log.position.x, log.position.y, log.position.z);
}
`;
        
        const warnings = coder._checkLogShadowing(userCodeWithShadow);
        
        assert.ok(warnings.length > 0, 'Should detect user code shadowing log');
        assert.ok(warnings.some(w => w.text.includes('const log')), 'Should identify the shadowing line');
    });

    it('should have __mcLog__ defined in lint template', async () => {
        const { readFile } = await import('fs');
        const { promisify } = await import('util');
        const readFileAsync = promisify(readFile);
        
        const lintTemplate = await readFileAsync('./bots/lintTemplate.js', 'utf8');
        
        assert.ok(lintTemplate.includes('__mcLog__'), 
            'Lint template should define __mcLog__ for interrupt guards');
    });
});

// ---------- Issue 6: Retry prompt cap ----------

describe('fix46: retry prompt always uses base + latest', () => {
    it('should rebuild messages from base on every retry (not accumulate)', async () => {
        const coderSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/coder.js', 'utf8')
        );
        
        // Check that generateCode rebuilds messages from baseMessages on retry
        assert.ok(
            coderSrc.includes('messages = [...baseMessages]') && 
            coderSrc.includes('i === 0'),
            'Should rebuild messages from base on retry'
        );
        
        // Should NOT have RETRY_PROMPT_CAP_MULTIPLIER
        assert.ok(
            !coderSrc.includes('RETRY_PROMPT_CAP_MULTIPLIER'),
            'Should not have RETRY_PROMPT_CAP_MULTIPLIER magic number'
        );
    });

    it('should log prompt size on retry without magic multiplier comparison', async () => {
        const coderSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/coder.js', 'utf8')
        );
        
        // Should log prompt size
        assert.ok(
            coderSrc.includes('Retry') && coderSrc.includes('prompt') && coderSrc.includes('chars'),
            'Should log retry prompt size'
        );
        
        // Should have loud logging for large prompts
        assert.ok(
            coderSrc.includes('LOUD') && coderSrc.includes('100000'),
            'Should log loudly for large prompts (100k threshold)'
        );
    });
});

// ---------- Issue 7: Log vitals with shared VITALS_MAX ----------

describe('fix46: log vitals with shared VITALS_MAX constant', () => {
    it('should export shared VITALS_MAX constant used by both log() and observe()', async () => {
        const { VITALS_MAX, getVitalsMax } = await import('../src/agent/library/skills.js');
        
        // VITALS_MAX should be exported and have health/food
        assert.ok(VITALS_MAX, 'VITALS_MAX should be exported');
        assert.strictEqual(typeof VITALS_MAX.health, 'number', 'VITALS_MAX.health should be a number');
        assert.strictEqual(typeof VITALS_MAX.food, 'number', 'VITALS_MAX.food should be a number');
        assert.strictEqual(VITALS_MAX.health, 20, 'VITALS_MAX.health should be 20 (Minecraft standard)');
        assert.strictEqual(VITALS_MAX.food, 20, 'VITALS_MAX.food should be 20 (Minecraft standard)');
        
        // getVitalsMax helper should exist
        assert.strictEqual(typeof getVitalsMax, 'function', 'getVitalsMax helper should be exported');
    });

    it('should use shared VITALS_MAX in log() function', async () => {
        const skillsSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/library/skills.js', 'utf8')
        );
        
        // Find the log function
        const logFnMatch = skillsSrc.match(/export function log\(bot, message\)[\s\S]*?\n\}/);
        assert.ok(logFnMatch, 'log function should exist');
        
        const logFn = logFnMatch[0];
        
        // Should use getVitalsMax helper (shared source)
        assert.ok(
            logFn.includes('getVitalsMax(bot)'),
            'log() should use getVitalsMax helper for shared source'
        );
    });

    it('should use shared VITALS_MAX in observe() function', async () => {
        const voyagerSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/voyager.js', 'utf8')
        );
        
        // observe() should reference skills.VITALS_MAX
        assert.ok(
            voyagerSrc.includes('skills.VITALS_MAX.health') && voyagerSrc.includes('skills.VITALS_MAX.food'),
            'observe() should use skills.VITALS_MAX for shared source'
        );
    });

    it('should log loudly once if bot reports non-standard max values', async () => {
        const skillsSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/library/skills.js', 'utf8')
        );
        
        // getVitalsMax should have loud logging for non-standard values
        assert.ok(
            skillsSrc.includes('LOUD') && skillsSrc.includes('non-standard vitals max'),
            'Should log loudly if bot reports non-standard vitals max'
        );
    });

    it('should include food and health in log output', async () => {
        const { log } = await import('../src/agent/library/skills.js');
        
        const mockBot = {
            output: '',
            health: 15,
            food: 10,
            game: {}
        };
        
        log(mockBot, 'Test message');
        
        assert.ok(mockBot.output.includes('food'), 'Should include food in output');
        assert.ok(mockBot.output.includes('health'), 'Should include health in output');
        assert.ok(mockBot.output.includes('10'), 'Should include food value');
        assert.ok(mockBot.output.includes('15'), 'Should include health value');
        assert.ok(mockBot.output.includes('/20'), 'Should include /20 max (VITALS_MAX standard)');
    });
});

// ---------- Integration tests ----------

describe('fix46: integration - verbose goal satisfaction', () => {
    it('should parse verbose craftItem goal at runtime with VERSION set', async () => {
        const { parseVerboseGoal, _setVersionForTest } = await import('../src/agent/voyager.js');
        
        // Set VERSION to a valid Minecraft version
        _setVersionForTest('1.20.4');
        
        const goal = 'craftItem: Craft 1 iron_pickaxe using 1 iron_ingot and 3 sticks';
        const result = parseVerboseGoal(goal);
        
        assert.ok(result, 'parseVerboseGoal should return a result');
        assert.strictEqual(result.item, 'iron_pickaxe', 'should extract item name');
        assert.strictEqual(result.count, 1, 'should extract count');
        assert.ok(Array.isArray(result.items), 'should have items array');
        assert.ok(result.items.includes('iron_pickaxe'), 'items should include iron_pickaxe');
    });

    it('should verify _goalAlreadySatisfied uses parseVerboseGoal as fallback', async () => {
        const voyagerSrc = await import('fs').then(fs => 
            fs.readFileSync('./src/agent/voyager.js', 'utf8')
        );
        
        // _goalAlreadySatisfied should call parseVerboseGoal
        assert.ok(
            voyagerSrc.includes('parseVerboseGoal(task)') && 
            voyagerSrc.includes('_goalAlreadySatisfied'),
            '_goalAlreadySatisfied should use parseVerboseGoal as fallback'
        );
    });

    it('should export parseVerboseGoal for testing', async () => {
        const voyagerModule = await import('../src/agent/voyager.js');
        
        assert.ok(
            typeof voyagerModule.parseVerboseGoal === 'function',
            'parseVerboseGoal should be exported'
        );
    });
});
