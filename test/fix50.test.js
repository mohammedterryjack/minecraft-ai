/**
 * fix50 regression tests
 * 
 * Tests for: prefixed calls resurrected via handwritten/seeded stored skills
 * 
 * The bug: after fix47 migration, lint went back to 166/166 prefixed fails because:
 * - Migration only rewrites `code` and `candidate.code`, skipping:
 *   - `prev.code` (rollback source for promoted skills)
 *   - `handwritten_original.code` (restoreHandwritten source)
 * - restoreHandwritten() then reapplies the prefixed handwritten_original
 * - Skills marked seeded:true and handwritten:true were skipped
 * 
 * Reproduces the 3 entries found:
 * - tossClutter (seeded:true, handwritten:true) with prefixes in code AND handwritten_original
 * - ensureChest with prefixes in prev + handwritten_original
 * - depositToChest with prefixes in prev + handwritten_original
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';

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

    it('should migrate depositToChest with prefixes in prev AND handwritten_original', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-deposit-${Date.now()}`;
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
            `prev.code should not have prefixed calls`);
        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].handwritten_original.code),
            `handwritten_original.code should not have prefixed calls`);
    });
});

describe('fix50: restoreHandwritten blocks prefixed code', () => {
    it('should block restoreHandwritten when handwritten_original contains prefixed calls', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-restore-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager._saveSkills = () => {};
        mockVoyager.skills = [{
            name: 'testSkill',
            code: `async function testSkill(bot) { return true; }`,
            handwritten_original: {
                code: `async function testSkill(bot) {
    await skills.wait(bot, 100);
}`,
                description: 'prefixed original'
            }
        }];

        const result = mockVoyager.restoreHandwritten('testSkill');

        assert.strictEqual(result, false, 'restoreHandwritten should return false for prefixed code');
        assert.ok(!mockVoyager.skills[0].code.includes('skills.wait'),
            'Current code should not be replaced with prefixed code');
    });

    it('should allow restoreHandwritten when handwritten_original has bare calls', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-restore-ok-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager._saveSkills = () => {};
        mockVoyager.skills = [{
            name: 'testSkill',
            code: `async function testSkill(bot) { return false; }`,
            handwritten_original: {
                code: `async function testSkill(bot) {
    await wait(bot, 100);
    return true;
}`,
                description: 'clean original',
                deps: []
            }
        }];

        const result = mockVoyager.restoreHandwritten('testSkill');

        assert.strictEqual(result, true, 'restoreHandwritten should return true for clean code');
        assert.ok(mockVoyager.skills[0].code.includes('await wait(bot, 100)'),
            'Current code should be restored from handwritten_original');
    });
});

describe('fix50: hasLeftovers checks all code fields', () => {
    it('should detect leftovers in prev.code', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-leftover-prev-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: true };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};

        mockVoyager.skills = [{
            name: 'testSkill',
            code: `async function testSkill(bot) { return true; }`,
            prev: {
                code: `async function testSkill(bot) { world.getNearestBlock(bot); }`
            }
        }];

        let migrateCalled = false;
        const originalMigrate = mockVoyager._migrateToBarenames.bind(mockVoyager);
        mockVoyager._migrateToBarenames = function() {
            migrateCalled = true;
            originalMigrate();
        };

        mockVoyager._migrateToBarenames();
        
        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].prev.code),
            'prev.code should be migrated');
    });

    it('should detect leftovers in handwritten_original.code', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-leftover-ho-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = { migratedToBarenames: true };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};

        mockVoyager.skills = [{
            name: 'testSkill',
            code: `async function testSkill(bot) { return true; }`,
            handwritten_original: {
                code: `async function testSkill(bot) { skills.wait(bot, 100); }`
            }
        }];

        mockVoyager._migrateToBarenames();
        
        assert.ok(!PREFIX_RE.test(mockVoyager.skills[0].handwritten_original.code),
            'handwritten_original.code should be migrated');
    });
});

describe('fix50: rollback paths block prefixed code', () => {
    it('should block window rollback when prev contains prefixed calls', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-window-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = {
            watch: [{
                name: 'testSkill',
                base: 0.9,
                after: [0, 0, 0]
            }],
            outcomes: []
        };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};
        mockVoyager.skills = [{
            name: 'testSkill',
            code: `async function testSkill(bot) { return true; }`,
            prev: {
                code: `async function testSkill(bot) { skills.goToPosition(bot, 0, 64, 0); }`
            }
        }];

        const errors = [];
        const origError = console.error;
        console.error = (...args) => errors.push(args.join(' '));

        mockVoyager._windowCheck(false);

        console.error = origError;

        assert.ok(errors.some(e => e.includes('fix50') && e.includes('BLOCKED')),
            'Should log a fix50 BLOCKED message for prefixed prev');
        assert.ok(!mockVoyager.skills[0].code.includes('skills.goToPosition'),
            'Code should not be replaced with prefixed prev');
    });

    it('should allow window rollback when prev has bare calls', async () => {
        const { Voyager } = await import('../src/agent/voyager.js');
        const tmpDir = `/tmp/test-fix50-window-ok-${Date.now()}`;
        mkdirSync(tmpDir, { recursive: true });

        const mockVoyager = Object.create(Voyager.prototype);
        mockVoyager.dir = tmpDir;
        mockVoyager.progress = {
            watch: [{
                name: 'testSkill',
                base: 0.9,
                after: [0, 0, 0]
            }],
            outcomes: []
        };
        mockVoyager._saveProgress = () => {};
        mockVoyager._saveSkills = () => {};
        mockVoyager.skills = [{
            name: 'testSkill',
            code: `async function testSkill(bot) { return true; }`,
            prev: {
                code: `async function testSkill(bot) { await goToPosition(bot, 0, 64, 0); }`,
                description: 'clean prev',
                deps: [],
                stats: { success: 5, fail: 1 }
            }
        }];

        mockVoyager._windowCheck(false);

        assert.ok(mockVoyager.skills[0].code.includes('goToPosition(bot, 0, 64, 0)'),
            'Code should be restored from clean prev');
        assert.ok(!mockVoyager.skills[0].prev, 'prev should be deleted after rollback');
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
