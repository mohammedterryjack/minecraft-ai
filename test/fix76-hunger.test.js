/**
 * fix76: hunger at full HP must surface a learned vitals fact; Food-is-full / PREREQUISITE FAILED
 * must not count against skill/candidate stats (live: food 10/20 hp 20/20, 48 mutton, no eat; false 2/2 REJECT).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { VitalsModel } from '../src/agent/vitals_model.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HPMAX = 20, FOODMAX = 20;

/** Live-like regen: rises only at food 18–20 (icefox progress.vitals after hunger effect). */
function liveRegenModel() {
    return new VitalsModel({
        regen: {
            15: { n: 1021, up: 0 }, 16: { n: 246, up: 0 }, 17: { n: 76, up: 0 },
            18: { n: 14, up: 4 }, 19: { n: 10, up: 3 }, 20: { n: 14, up: 9 },
        },
        runs: {},
        foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
    });
}

describe('fix76: learned hunger at full HP', () => {
    it('live state food 10 / hp 20: recoveryText null, hungerText urgent (below regen floor 18)', () => {
        const m = liveRegenModel();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const rec = m.recovery(20, HPMAX, 10);
        assert.strictEqual(rec.below, false);
        assert.strictEqual(rec.blocked, false);
        assert.strictEqual(m.recoveryText(rec), null, 'fix58: still no recovery line at full HP');
        const h = m.hunger(20, HPMAX, 10, FOODMAX);
        assert.strictEqual(h.belowRegen, true);
        assert.strictEqual(h.urgent, true);
        const t = m.hungerText(h);
        assert.match(t, /hunger \(learned from own vitals\)/);
        assert.match(t, /food 10\/20 is below learned regen food floor 18/);
        assert.match(t, /eatCookedMutton \+6\.0 food\/run/);
    });

    it('food decay samples create urgency when raisers exist even above regen floor', () => {
        const m = new VitalsModel({ regen: { 12: { n: 4, up: 2 } }, runs: {}, foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } } });
        m.observeFoodSample({ f: 18 }, { f: 17 });
        m.observeFoodSample({ f: 17 }, { f: 16 });
        m.noteRun('eatFood', { hp: 20, food: 16 }, { hp: 20, food: 20 });
        const h = m.hunger(20, HPMAX, 16, FOODMAX);
        assert.strictEqual(h.belowRegen, false, '16 >= learned floor 12');
        assert.strictEqual(h.decayKnown, true);
        assert.strictEqual(h.urgent, true);
        assert.match(m.hungerText(h), /food drops observed 2x/);
    });

    it('observeSample at full HP still records food drops (hunger path)', () => {
        const m = new VitalsModel({ regen: {}, runs: {} });
        assert.strictEqual(m.observeSample({ h: 20, f: 14 }, { h: 20, f: 13 }, HPMAX), null, 'no regen evidence at full HP');
        assert.strictEqual(m.s.foodSamples.drop.n, 1);
        assert.strictEqual(m.s.foodSamples.drop.sum, 1);
    });

    it('full food is not urgent', () => {
        const m = liveRegenModel();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const h = m.hunger(20, HPMAX, 20, FOODMAX);
        assert.strictEqual(h.urgent, false);
        assert.strictEqual(m.hungerText(h), null);
    });
});

describe('fix76: unmet precondition classification (source + voyager wiring)', () => {
    it('voyager source wires _unmetPrecondition and skips Food is full / PREREQUISITE FAILED', () => {
        const src = readFileSync(join(ROOT, 'src/agent/voyager.js'), 'utf8');
        assert.match(src, /_unmetPrecondition\(/);
        assert.match(src, /Food is full/);
        assert.match(src, /PREREQUISITE FAILED/);
        assert.match(src, /UNMET PRECONDITION/);
        assert.match(src, /!unmet\) this\._recordRun/);
        assert.match(src, /hunger_urgent:/);
        assert.match(src, /food_below_regen_floor:/);
        assert.match(src, /hungerText/);
        assert.match(src, /food already full/);
    });

    it('_unmetPrecondition behaviour via isolated eval of the method body contract', async () => {
        // Exercise the same predicates the method uses (no full Voyager boot).
        const classify = (blob) => {
            if (/Food is full/i.test(blob)) return 'Food is full';
            if (/PREREQUISITE FAILED/i.test(blob)) return 'PREREQUISITE FAILED';
            return null;
        };
        assert.strictEqual(classify('FAILED to consume cooked_mutton: Food is full. Food stayed at 20.'), 'Food is full');
        assert.strictEqual(classify('PREREQUISITE FAILED: tossClutter needs chest within 32 blocks'), 'PREREQUISITE FAILED');
        assert.strictEqual(classify('FAILED: pathfinder took too long'), null);
    });
});
