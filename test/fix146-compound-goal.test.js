/**
 * fix146 (live icefox2000, 18 Nov 2026): the PSN decomposer emitted the compound subgoal
 * "Gather 5 flint and 5 steel blocks (craft from iron ingots) to create a flint and steel for
 * lighting the portal." (mindcraft.log 112452). countGoal's item run stopped at the first noun,
 * silently turning it into "5 flint": satisfaction, game-data decomposition ("no source of
 * flint is present or proven") and the task contract all ran on half the goal, so the subgoal
 * could never verify and repeated until exhausted — 11 failures (line 119916) while the bot
 * already carried flint_and_steel x5. Compound counted goals are now rejected at intake
 * (validateTask) and never half-parsed (countGoal returns null).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { _setVersionForTest } from '../src/utils/mcdata.js';
import { Voyager, validateTask } from '../src/agent/voyager.js';

_setVersionForTest('1.20.4');   // validateTask -> knownNames -> getAllItems needs the item lists (test/fix120 pattern)

const COMPOUND = 'Gather 5 flint and 5 steel blocks (craft from iron ingots) to create a flint and steel for lighting the portal.';

describe('fix146 compound count goals are rejected, never half-parsed', () => {
    it('validateTask rejects the live compound goal with an actionable reason', () => {
        const why = validateTask(COMPOUND);
        assert.match(why, /compound goal/);
        assert.match(why, /one task per counted item/);
    });

    it('compound works with number words too', () => {
        assert.match(validateTask('gather five flint and five steel blocks'), /compound goal/);
    });

    it('a plain two-item compound is rejected', () => {
        assert.match(validateTask('Collect 3 apples and 2 bread'), /compound goal/);
    });

    it('"and" followed by a verb or bare noun is NOT compound', () => {
        assert.strictEqual(validateTask('Mine 5 iron_ore and craft tools'), null);
        assert.strictEqual(validateTask('Collect sticks and saplings'), null);
        assert.strictEqual(validateTask('Gather 64 cobblestone and place them'), null);
    });

    it('atomic goals parse unchanged', () => {
        assert.strictEqual(validateTask('Craft 1 stone_pickaxe'), null);
        assert.strictEqual(validateTask('Smelt 5 raw_iron into 5 iron_ingot'), null);
        assert.strictEqual(validateTask('Mine 5 iron_ore'), null);
    });

    it('_resolveGoal no longer turns the compound goal into an item goal (kind open, not item)', () => {
        const v = Object.create(Voyager.prototype);
        v.skills = [];
        const g = v._resolveGoal(COMPOUND);
        assert.strictEqual(g.kind, 'open');
    });

    it('_resolveGoal still resolves an atomic gather goal as an item goal', () => {
        const v = Object.create(Voyager.prototype);
        v.skills = [];
        const g = v._resolveGoal('Gather 5 flint');
        assert.strictEqual(g.kind, 'item');
        assert.strictEqual(g.item, 'flint');
    });
});
