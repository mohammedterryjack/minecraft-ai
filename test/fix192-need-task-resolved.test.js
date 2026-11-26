// fix192: a need task must die with the need. Live 26 Nov 08:12Z: need:hunger attempt 2 ran eat-code at food=20
// (attempt 1 had eaten while the critic judged the attempt failed) -> "[contract] VIOLATED checkHungerAndEat()
// precondition ... c.pre.food=20 (expected <20)". The attempt loop now closes need tasks via _needTaskResolved.
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { VitalsModel } from '../src/agent/vitals_model.js';

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest('1.21.4');
    const { _setVersionForTest } = await import('../src/utils/mcdata.js');
    _setVersionForTest('1.21.4');
});

function rig(food) {
    const v = Object.create(Voyager.prototype);
    const bot = {
        health: 20, food,
        game: { maxHealth: 20, maxFood: 20 },
        version: '1.21.4',
        entity: { position: { x: 0, y: 64, z: 0 } },
        inventory: { emptySlotCount: () => 10 },
    };
    v.agent = { bot };
    v.skills = [];
    v.vitals = new VitalsModel({
        regen: {
            15: { n: 1021, up: 0 }, 16: { n: 246, up: 0 }, 17: { n: 76, up: 0 },
            18: { n: 14, up: 4 }, 19: { n: 10, up: 3 }, 20: { n: 14, up: 9 },
        },
        runs: {},
        foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
    });
    v.observe = () => ({ inventory: {}, position: '0, 64, 0' });
    return v;
}

describe('fix192: _needTaskResolved', () => {
    it('non-need tasks are never resolved by this check', () => {
        assert.strictEqual(rig(20)._needTaskResolved('Smelt 3 cod into 3 cooked_cod'), false);
        assert.strictEqual(rig(20)._needTaskResolved(undefined), false);
    });
    it('need:hunger is resolved at full food (the VIOLATED case: food=20)', () => {
        assert.strictEqual(rig(20)._needTaskResolved('need:hunger'), true);
    });
    it('need:hunger is NOT resolved below the learned regen floor', () => {
        assert.strictEqual(rig(12)._needTaskResolved('need:hunger'), false);
    });
    it('an unknown need label fails loud instead of silently never resolving', () => {
        assert.throws(() => rig(20)._needTaskResolved('need:oxygen'), /unknown need label/);
    });
});
