// fix191: urgent-need picked food raisers from lifetime stats alone — eatTwoSalmon served twice with salmon 0
// ("raiser eatTwoSalmon +0.4 food/run", then "[contract] VIOLATED eatTwoSalmon() precondition", mindcraft.log
// 26 Nov 06:59 and 07:12): each serve burned a run and a violation before backchain could fire. Selection now
// applies the fix119 practice rule: a raiser whose learned pre DECISIVELY does not hold in the current world is
// not playable this step; null (not evaluable) still plays.
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

function rig(inventory) {
    const v = Object.create(Voyager.prototype);
    const bot = {
        health: 8, food: 12,
        game: { maxHealth: 20, maxFood: 20 },
        version: '1.21.4',
        entity: { position: { x: 0, y: 64, z: 0 } },
        inventory: { emptySlotCount: () => 10 },
    };
    v.agent = { bot };
    v.skills = [{
        name: 'eatTwoSalmon', demoted: false, mergedInto: null, task: 'Eat two salmon',
        contract: { pre: "c => (c.pre.inv['salmon'] || 0) >= 2", post: 'c => c.ret === true' },
    }];
    v.vitals = new VitalsModel({
        regen: {
            15: { n: 1021, up: 0 }, 16: { n: 246, up: 0 }, 17: { n: 76, up: 0 },
            18: { n: 14, up: 4 }, 19: { n: 10, up: 3 }, 20: { n: 14, up: 9 },
        },
        runs: { eatTwoSalmon: { n: 2, food: 0.4 } },
        foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
    });
    v.observe = () => ({ inventory, position: '0, 64, 0' });
    return v;
}

describe('fix191: urgent-need will not serve a raiser whose pre is false now', () => {
    it('eatTwoSalmon is not a playable raiser with 0 salmon (live: served twice, VIOLATED twice)', () => {
        const v = rig({ cobblestone: 27 });
        assert.deepEqual(v._playableFoodRaisers(), []);
        assert.strictEqual(v._hungerServeState().best, null);
    });
    it('with salmon in hand the raiser is playable again (skip is for now, not a mark)', () => {
        const v = rig({ salmon: 5 });
        const p = v._playableFoodRaisers();
        assert.equal(p.length, 1);
        assert.equal(p[0].entry.name, 'eatTwoSalmon');
        assert.ok(v._hungerServeState().best !== null);
    });
    it('a raiser with no pre-contract stays playable (null is not a skip)', () => {
        const v = rig({ cobblestone: 27 });
        delete v.skills[0].contract.pre;
        const p = v._playableFoodRaisers();
        assert.equal(p.length, 1);
    });
    it('a raiser whose pre reads c.args stays playable (not evaluable without args)', () => {
        const v = rig({ cobblestone: 27 });
        v.skills[0].contract.pre = "c => (c.pre.inv[c.args[0]] || 0) >= 2";
        const p = v._playableFoodRaisers();
        assert.equal(p.length, 1);
    });
});
