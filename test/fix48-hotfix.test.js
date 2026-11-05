/**
 * fix48 hotfix tests
 * 
 * 1. Self-recursion false positive: obtainItem-style bounded recursion (different args) should NOT be flagged
 * 2. Self-recursion false positive: top-level invocation after function should NOT be flagged
 * 3. Self-recursion true positive: unconditional self-forward (same args) SHOULD be flagged
 * 4. readdirSync import: should be present in fs import
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';

describe('fix48: self-recursion detection fixes', () => {
    it('should NOT flag bounded recursion with different args (obtainItem pattern)', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const { mkdirSync } = await import('fs');
        const tmpDir = `/tmp/test-selfrecur-bounded-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });
        
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = {};
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};
        mockVoyager._graph = () => ({});
        
        // This is the obtainItem pattern: recursively calls itself with DIFFERENT args (bounded)
        mockVoyager.skills = [{
            name: 'obtainItem',
            code: `async function obtainItem(bot, item, count = 1) {
    const inv = getInventoryCounts(bot);
    if (inv[item] >= count) return true;
    
    // Check if we need to smelt raw material
    const smelt = { iron_ingot: 'raw_iron', gold_ingot: 'raw_gold' };
    if (smelt[item]) {
        const need = count - (inv[item] || 0);
        // This recursive call has DIFFERENT args - bounded recursion, NOT infinite
        await obtainItem(bot, smelt[item], need);
        await smeltItem(bot, smelt[item], need);
        return true;
    }
    return false;
}`,
            seeded: false
        }];
        
        // _relink should NOT throw for bounded recursion
        let threw = false;
        try {
            mockVoyager._relink();
        } catch (e) {
            threw = true;
        }
        
        assert.strictEqual(threw, false, 
            'Should NOT throw for obtainItem-style bounded recursion with different args');
    });

    it('should NOT flag top-level invocation after function definition', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const { mkdirSync } = await import('fs');
        const tmpDir = `/tmp/test-selfrecur-toplevel-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });
        
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = {};
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};
        mockVoyager._graph = () => ({});
        
        // This is the tossClutterForIron pattern: top-level invocation AFTER the function
        mockVoyager.skills = [{
            name: 'tossClutterForIron',
            code: `async function tossClutterForIron(bot) {
    const safeToToss = ['dirt', 'cobblestone', 'gravel'];
    for (const item of safeToToss) {
        await tossItem(bot, item, 32);
    }
    return true;
}

// Top-level invocation after function - this is NOT self-recursion
await tossClutterForIron(bot);`,
            seeded: false
        }];
        
        // _relink should NOT throw for top-level invocation
        let threw = false;
        try {
            mockVoyager._relink();
        } catch (e) {
            threw = true;
        }
        
        assert.strictEqual(threw, false, 
            'Should NOT throw for top-level invocation after function definition');
    });

    it('should flag unconditional self-forward with same args', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const { mkdirSync } = await import('fs');
        const tmpDir = `/tmp/test-selfrecur-infinite-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });
        
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = {};
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};
        mockVoyager._graph = () => ({});
        
        // This is an INFINITE self-recursion: calls itself with SAME args
        mockVoyager.skills = [{
            name: 'f',
            code: `async function f(bot, x) { return await f(bot, x); }`,
            seeded: false
        }];
        
        // _relink SHOULD throw for infinite self-recursion
        let threw = false;
        let errorMsg = '';
        try {
            mockVoyager._relink();
        } catch (e) {
            threw = true;
            errorMsg = e.message;
        }
        
        assert.strictEqual(threw, true, 
            'SHOULD throw for unconditional self-forward with same args');
        assert.ok(errorMsg.includes('SELF-RECURSION'), 
            `Error message should mention SELF-RECURSION, got: ${errorMsg}`);
    });

    it('should flag self-recursion even with async/await variations', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const { mkdirSync } = await import('fs');
        const tmpDir = `/tmp/test-selfrecur-async-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });
        
        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = {};
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};
        mockVoyager._graph = () => ({});
        
        // Async function with same-args self-call
        mockVoyager.skills = [{
            name: 'infiniteLoop',
            code: `async function infiniteLoop(bot, x, y) {
    console.log('looping');
    return infiniteLoop(bot, x, y);
}`,
            seeded: false
        }];
        
        let threw = false;
        try {
            mockVoyager._relink();
        } catch (e) {
            threw = true;
        }
        
        assert.strictEqual(threw, true, 
            'SHOULD throw for async function with same-args self-call');
    });
});

describe('fix48: readdirSync import', () => {
    it('should have readdirSync imported from fs', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Find the fs import line
        const fsImportMatch = voyagerSrc.match(/import\s*\{[^}]+\}\s*from\s*['"]fs['"]/);
        assert.ok(fsImportMatch, 'Should have fs import');
        
        const fsImportLine = fsImportMatch[0];
        assert.ok(fsImportLine.includes('readdirSync'), 
            `readdirSync should be in fs import, got: ${fsImportLine}`);
    });
    
    it('should use readdirSync in standalone file migration', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Check that readdirSync is actually used (not just imported)
        const usageMatch = voyagerSrc.match(/readdirSync\s*\(\s*this\.dir\s*\)/);
        assert.ok(usageMatch, 'readdirSync should be used for standalone file migration');
    });
});

describe('fix48: standalone file migration throws on error', () => {
    it('should throw (not log) when standalone file migration fails', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Find the catch block for standalone file migration
        const catchMatch = voyagerSrc.match(/catch\s*\(e\)\s*\{\s*throw\s+new\s+Error\s*\(\s*`\[fix47\]\s*standalone\s*file\s*migration\s*FAILED/);
        assert.ok(catchMatch, 
            'Standalone file migration catch block should throw, not log');
        
        // Make sure it's NOT just logging
        assert.ok(!voyagerSrc.includes("console.log(`[fix47] standalone file migration skipped"),
            'Should NOT have "skipped" log for standalone file migration');
    });
});
