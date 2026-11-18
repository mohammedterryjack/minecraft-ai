// fix144: the barename migration throw-scan must flag only EXECUTABLE prefixed references.
// Root cause (live 18 Nov 2026): a seeded template comment "see library/skills.js pickupNearbyItems"
// matched the raw-text LEFTOVER regex; rewriteCode only strips the call shape `skills.foo(`, so the
// leftover never went away and _migrateToBarenames threw on every launch — 774-crash loop.
import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync } from 'node:fs';

describe('fix144: token-aware leftover scan', () => {

    function makeVoyager(skills, progress = { migratedToBarenames: true }) {
        return import('../src/agent/voyager.js').then(({ Voyager }) => {
            const tmpDir = `/tmp/test-fix144-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            mkdirSync(tmpDir, { recursive: true });
            const v = Object.create(Voyager.prototype);
            v.dir = tmpDir;
            v.progress = progress;
            v._saveProgress = () => {};
            v._saveSkills = () => {};
            v.skills = skills;
            return v;
        });
    }

    it('does NOT throw when a prefixed pattern appears only in a comment', async () => {
        const v = await makeVoyager([{
            name: 'pickupNearbyItems',
            // the exact live trigger: comment mentions skills.js, no executable prefixed ref
            code: `async function pickupNearbyItems(bot, positions) {
    let pickedUp = 0;
    // fix143: true iff items were picked up (see library/skills.js pickupNearbyItems)
    return pickedUp > 0;
}`,
        }]);
        v._migrateToBarenames(); // must not throw
    });

    it('does NOT throw when a prefixed pattern appears only inside a string literal', async () => {
        const v = await makeVoyager([{
            name: 'sayHelper',
            code: `async function sayHelper(bot) {
    bot.chat("the call skills.goToPosition(bot, x, y, z) is a string here");
    return true;
}`,
        }]);
        v._migrateToBarenames(); // must not throw
    });

    it('does NOT throw for bot.world.<method> property access (legit mineflayer API)', async () => {
        const v = await makeVoyager([{
            name: 'scanBlocks',
            code: `async function scanBlocks(bot) {
    const blocks = bot.world.blocks;
    return blocks !== undefined;
}`,
        }]);
        v._migrateToBarenames(); // must not throw
    });

    it('still THROWS when a real prefixed call survives migration (self-call skip)', async () => {
        const v = await makeVoyager([{
            name: 'killMob',
            // self-call: rewriteCode must NOT strip skills.killMob (would recurse), so the
            // leftover is real and must fail loud
            code: `async function killMob(bot, name, health) {
    await skills.killMob(bot, name, health);
    return true;
}`,
        }]);
        assert.throws(() => v._migrateToBarenames(), /LEFTOVER PREFIXED PATTERNS/);
    });

    it('still THROWS for a real prefixed reference that migration cannot rewrite', async () => {
        const v = await makeVoyager([{
            name: 'helperFn',
            // typeof guard: rewriteCode only strips `skills.foo(` call shape; this executes
            code: `async function helperFn(bot) {
    const fn = typeof skills.goToPosition === 'function' ? skills.goToPosition : null;
    return fn !== null;
}`,
        }]);
        assert.throws(() => v._migrateToBarenames(), /LEFTOVER PREFIXED PATTERNS/);
    });

    it('fails loud with field path when a scanned field cannot be tokenized', async () => {
        const v = await makeVoyager([{
            name: 'brokenFn',
            // unterminated string literal: a real syntax error, must fail loud with the path
            code: `async function brokenFn(bot) { return "unterminated; }`,
        }]);
        assert.throws(() => v._migrateToBarenames(), /\[fix144\] cannot scan brokenFn\.code/);
    });

    it('seeded self-call is NOT a leftover (fix42 seed reheal replaces the code)', async () => {
        const v = await makeVoyager([{
            name: 'pickupNearbyItems',
            code: `async function pickupNearbyItems(bot, positions) {
    await skills.pickupNearbyItems(bot, positions);
    return true;
}`,
        }]);
        v._migrateToBarenames(); // must not throw: marked for seed reheal, seed replaces code
        // catch-all must NOT have stripped the prefix into bare recursion
        assert.ok(v.skills[0].code.includes('skills.pickupNearbyItems('),
            'seeded self-call prefix preserved for reheal, not rewritten to infinite recursion');
    });

    it('normal prefixed calls are still migrated to bare names (fix41/50 behaviour intact)', async () => {
        const v = await makeVoyager([{
            name: 'walkTo',
            code: `async function walkTo(bot) {
    await skills.goToPosition(bot, 0, 64, 0);
    const c = world.getInventoryCounts(bot);
    return c;
}`,
        }], { migratedToBarenames: false });
        v._migrateToBarenames();
        assert.ok(v.skills[0].code.includes('goToPosition(bot'), 'skills.goToPosition stripped');
        assert.ok(v.skills[0].code.includes('getInventoryCounts(bot'), 'world.getInventoryCounts stripped');
        assert.ok(!v.skills[0].code.includes('skills.'), 'no skills. prefix remains');
    });
});
