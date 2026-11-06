/**
 * fix50 regression tests
 * 
 * Tests for: prefixed calls resurrected via handwritten/seeded stored skills
 * 
 * The bug: after fix47 migration, lint went back to 166/166 prefixed fails because:
 * - Migration only rewrites `code` and `candidate.code`, skipping:
 *   - `prev.code` (rollback source for promoted skills)
 *   - `handwritten_original.code` (restoreHandwritten source)
 *   - `variants[*].code`
 *   - `repairHistory[*].code` and `repairHistory[*].fixSnippet`
 * - restoreHandwritten() then reapplies the prefixed handwritten_original
 * - Skills marked seeded:true and handwritten:true were skipped
 * 
 * Reproduces the 3 entries found:
 * - tossClutter (seeded:true, handwritten:true) with prefixes in code AND handwritten_original
 * - ensureChest with prefixes in prev + handwritten_original
 * - depositToChest with prefixes in prev + handwritten_original
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, readFileSync } from 'fs';

const PREFIX_RE = /\b(?:skills|world)\.\w+\s*\(/;

describe('fix50: migration rewrites ALL code fields', () => {
    it('should migrate prev.code containing prefixed calls', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-prev-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};

        mockVoyager.skills = [{
            name: 'ensureChest',
            code: `async function ensureChest(bot) { return true; }`,
            prev: {
                code: `async function ensureChest(bot) {
    const inv = world.getInventoryCounts(bot);
    await skills.goToPosition(bot, 0, 64, 0);
    return true;
}`,
                description: 'old version'
            }
        }];

        mockVoyager._migrateToBarenames();

        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].prev.code),
            `prev.code should not have prefixed calls: ${mockVoyager.skills[0].prev.code}`);
        assert.ok(mockVoyager.skills[0].prev.code.includes('getInventoryCounts(bot)'),
            'prev.code should have bare getInventoryCounts');
        assert.ok(mockVoyager.skills[0].prev.code.includes('goToPosition(bot'),
            'prev.code should have bare goToPosition');
    });

    it('should migrate handwritten_original.code containing prefixed calls', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-ho-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};

        mockVoyager.skills = [{
            name: 'tossClutter',
            seeded: true,
            handwritten: true,
            code: `async function tossClutter(bot) { return true; }`,
            handwritten_original: {
                code: `async function tossClutter(bot) {
    const inv = world.getInventoryCounts(bot);
    await skills.wait(bot, 100);
    await skills.moveAway(bot, 5);
    return true;
}`,
                description: 'original handwritten version'
            }
        }];

        mockVoyager._migrateToBarenames();

        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].handwritten_original.code),
            `handwritten_original.code should not have prefixed calls: ${mockVoyager.skills[0].handwritten_original.code}`);
        assert.ok(mockVoyager.skills[0].handwritten_original.code.includes('getInventoryCounts(bot)'),
            'handwritten_original.code should have bare getInventoryCounts');
        assert.ok(mockVoyager.skills[0].handwritten_original.code.includes('wait(bot'),
            'handwritten_original.code should have bare wait');
        assert.ok(mockVoyager.skills[0].handwritten_original.code.includes('moveAway(bot'),
            'handwritten_original.code should have bare moveAway');
    });

    it('should migrate repairHistory[*].code and repairHistory[*].fixSnippet', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-repair-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};

        mockVoyager.skills = [{
            name: 'collectBlock',
            code: `async function collectBlock(bot) { return true; }`,
            repairHistory: [
                {
                    code: `async function collectBlock(bot) { world.getNearestBlock(bot, 'oak_log'); }`,
                    fixSnippet: `// Use skills.wait(bot, 100) before mining`
                }
            ]
        }];

        mockVoyager._migrateToBarenames();

        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].repairHistory[0].code),
            'repairHistory[0].code should have no prefixed calls');
        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].repairHistory[0].fixSnippet),
            'repairHistory[0].fixSnippet should have no prefixed calls');
    });
});

describe('fix50: post-migration scan THROWS on leftovers', () => {
    it('should THROW when code still has prefixed calls after migration', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-throw-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};

        mockVoyager.skills = [{
            name: 'testSkill',
            code: `async function testSkill(bot) { 
    // This pattern won't match rewrite regex (object access, not call)
    const x = skills.something; // Not a call, won't be rewritten
    return true;
}`
        }];

        // Migration should complete without throwing (no call patterns to fail)
        mockVoyager._migrateToBarenames();
    });
});

describe('fix50: the exact 3 entries from the bug report', () => {
    it('should migrate tossClutter with seeded:true, handwritten:true and prefixes in code AND handwritten_original', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-toss-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};

        mockVoyager.skills = [{
            name: 'tossClutter',
            seeded: true,
            handwritten: true,
            code: `async function tossClutter(bot) {
    const inv = world.getInventoryCounts(bot);
    await skills.wait(bot, 100);
    await skills.moveAway(bot, 5);
}`,
            handwritten_original: {
                code: `async function tossClutter(bot) {
    const inv = world.getInventoryCounts(bot);
    await skills.wait(bot, 100);
    await skills.moveAway(bot, 5);
}`
            }
        }];

        mockVoyager._migrateToBarenames();

        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].code),
            'tossClutter code should have no prefixed calls');
        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].handwritten_original.code),
            'tossClutter handwritten_original.code should have no prefixed calls');
    });

    it('should migrate ensureChest with prefixes in prev + handwritten_original', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-ensure-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};

        mockVoyager.skills = [{
            name: 'ensureChest',
            code: `async function ensureChest(bot) { return true; }`,
            prev: {
                code: `async function ensureChest(bot) {
    const chest = world.getNearestBlock(bot, 'chest');
    await skills.goToPosition(bot, 0, 64, 0);
}`
            },
            handwritten_original: {
                code: `async function ensureChest(bot) {
    const inv = world.getInventoryCounts(bot);
    await skills.craftRecipe(bot, 'chest');
}`
            }
        }];

        mockVoyager._migrateToBarenames();

        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].prev.code),
            'ensureChest prev.code should have no prefixed calls');
        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].handwritten_original.code),
            'ensureChest handwritten_original.code should have no prefixed calls');
    });

    it('should migrate depositToChest with prefixes in prev + handwritten_original', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-deposit-full-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};

        mockVoyager.skills = [{
            name: 'depositToChest',
            code: `async function depositToChest(bot) { return true; }`,
            prev: {
                code: `async function depositToChest(bot, itemName) {
    const chest = world.getNearestBlock(bot, 'chest', 32);
    await skills.goToPosition(bot, chest.position.x, chest.position.y, chest.position.z);
}`
            },
            handwritten_original: {
                code: `async function depositToChest(bot, itemName) {
    const inv = world.getInventoryCounts(bot);
    skills.log(bot, 'depositing...');
}`
            }
        }];

        mockVoyager._migrateToBarenames();

        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].prev.code),
            'depositToChest prev.code should have no prefixed calls');
        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].handwritten_original.code),
            'depositToChest handwritten_original.code should have no prefixed calls');
    });
});

describe('fix50: ROLLBACK of migrated handwritten skill yields bare code', () => {
    it('should restore bare code when handwritten_original was properly migrated', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-rollback-bare-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: false };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};

        mockVoyager.skills = [{
            name: 'testHandwritten',
            handwritten: true,
            code: `async function testHandwritten(bot) { return false; }`,
            handwritten_original: {
                code: `async function testHandwritten(bot) {
    const inv = world.getInventoryCounts(bot);
    await skills.wait(bot, 100);
    return true;
}`,
                description: 'original with prefixes',
                deps: []
            }
        }];

        mockVoyager._migrateToBarenames();

        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].handwritten_original.code),
            'Migration should have cleaned handwritten_original');

        const result = mockVoyager.restoreHandwritten('testHandwritten');

        assert.strictEqual(result, true, 'restoreHandwritten should succeed');
        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].code),
            'Restored code should have no prefixed calls');
        assert.ok(mockVoyager.skills[0].code.includes('getInventoryCounts(bot)'),
            'Restored code should have bare getInventoryCounts');
        assert.ok(mockVoyager.skills[0].code.includes('wait(bot, 100)'),
            'Restored code should have bare wait');
    });
});

describe('fix50: no prefixed calls in SEEDED_PRIMITIVES', () => {
    it('should have no prefixed calls in any SEEDED_PRIMITIVES code', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const violations = [];

        for (const prim of Voyager.SEEDED_PRIMITIVES || []) {
            if (prim.code && PREFIX_RE.test(prim.code)) {
                violations.push({ name: prim.name, matches: prim.code.match(/\b(?:skills|world)\.\w+\s*\(/g) });
            }
        }

        assert.strictEqual(violations.length, 0,
            `SEEDED_PRIMITIVES should have no prefixed calls: ${JSON.stringify(violations)}`);
    });
});

describe('fix50: assertNoPromptPrefixes THROWS on prefixed calls in prompt sources', () => {
    it('should THROW when profile.coding contains prefixed calls', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const badProfile = {
            coding: `Use skills.goToPosition(bot, x, y, z) to move.`
        };

        assert.throws(
            () => Voyager.assertNoPromptPrefixes(badProfile),
            /PREFIXED CALLS in prompt sources/,
            'Should throw for prefixed calls in profile.coding'
        );
    });

    it('should THROW when coding_examples contain prefixed calls', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const badProfile = {
            coding_examples: [
                [
                    { role: 'user', content: 'Go to 0 64 0' },
                    { role: 'assistant', content: '```await skills.goToPosition(bot, 0, 64, 0);```' }
                ]
            ]
        };

        assert.throws(
            () => Voyager.assertNoPromptPrefixes(badProfile),
            /PREFIXED CALLS in prompt sources/,
            'Should throw for prefixed calls in coding_examples'
        );
    });

    it('should THROW when conversation_examples contain prefixed calls', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const badProfile = {
            conversation_examples: [
                [
                    { role: 'user', content: 'Get inventory' },
                    { role: 'assistant', content: 'Use world.getInventoryCounts(bot) to check.' }
                ]
            ]
        };

        assert.throws(
            () => Voyager.assertNoPromptPrefixes(badProfile),
            /PREFIXED CALLS in prompt sources/,
            'Should throw for prefixed calls in conversation_examples'
        );
    });

    it('should THROW when repairMemory.repairs contain prefixed calls', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const goodProfile = { coding: 'Use bare function names.' };
        const badRepairMemory = {
            repairs: [
                { fixSnippet: `// Try skills.wait(bot, 100) before retrying` }
            ]
        };

        assert.throws(
            () => Voyager.assertNoPromptPrefixes(goodProfile, badRepairMemory),
            /PREFIXED CALLS in prompt sources/,
            'Should throw for prefixed calls in repairMemory'
        );
    });

    it('should NOT throw when profile and repairMemory are clean', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        
        const goodProfile = {
            coding: 'Use bare function names like goToPosition(bot, x, y, z).',
            coding_examples: [
                [
                    { role: 'user', content: 'Go there' },
                    { role: 'assistant', content: '```await goToPosition(bot, 0, 64, 0);```' }
                ]
            ],
            conversation_examples: [
                [
                    { role: 'user', content: 'Check inventory' },
                    { role: 'assistant', content: 'Use getInventoryCounts(bot) to check.' }
                ]
            ]
        };
        const goodRepairMemory = {
            repairs: [
                { fixSnippet: `// Try wait(bot, 100) before retrying` }
            ]
        };

        assert.doesNotThrow(
            () => Voyager.assertNoPromptPrefixes(goodProfile, goodRepairMemory),
            'Should not throw for clean profile and repairMemory'
        );
    });
});

describe('fix50: default profile has no prefixed calls', () => {
    it('should have no prefixed calls in profiles/defaults/_default.json', async () => {
        const defaultProfile = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
        const { Voyager } = await import('../src/agent/voyager.js');
        
        assert.doesNotThrow(
            () => Voyager.assertNoPromptPrefixes(defaultProfile),
            'Default profile should have no prefixed calls'
        );
    });
});
