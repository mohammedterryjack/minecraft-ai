/**
 * fix76: hunger at full HP (learned); unmet preconditions classified structurally —
 * typed kind:'precondition' marker, or learned food-raiser at observed food cap.
 * Message text alone (e.g. mineflayer "Food is full") must NOT void a fail.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { VitalsModel } from '../src/agent/vitals_model.js';
import { markPreconditionUnmet, peekPreconditionUnmet, clearPreconditionUnmet } from '../src/agent/precondition.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HPMAX = 20, FOODMAX = 20;

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
        assert.strictEqual(m.recoveryText(rec), null);
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
        assert.strictEqual(h.belowRegen, false);
        assert.strictEqual(h.decayKnown, true);
        assert.strictEqual(h.urgent, true);
        assert.match(m.hungerText(h), /food drops observed 2x/);
    });

    it('observeSample at full HP still records food drops (hunger path)', () => {
        const m = new VitalsModel({ regen: {}, runs: {}, foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } } });
        assert.strictEqual(m.observeSample({ h: 20, f: 14 }, { h: 20, f: 13 }, HPMAX), null);
        assert.strictEqual(m.s.foodSamples.drop.n, 1);
        assert.strictEqual(m.s.foodSamples.drop.sum, 1);
    });

    it('full food is not urgent', () => {
        const m = liveRegenModel();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        assert.strictEqual(m.hungerText(m.hunger(20, HPMAX, 20, FOODMAX)), null);
    });
});

describe('fix76: structural unmet-precondition classification', () => {
    it('typed kind:precondition marker is detected; clear removes it', () => {
        const bot = {};
        markPreconditionUnmet(bot, { why: 'chest missing' });
        const m = peekPreconditionUnmet(bot);
        assert.strictEqual(m.kind, 'precondition');
        clearPreconditionUnmet(bot);
        assert.strictEqual(peekPreconditionUnmet(bot), null);
    });

    it('learned food-raiser at observed food cap is saturated (no item names, no hard-coded 20 in the check)', () => {
        const m = new VitalsModel({ regen: {}, runs: {}, foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } } });
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        assert.ok(m.foodRaisers().some(x => x.name === 'eatCookedMutton' && x.food > 0));
        const cap = FOODMAX;
        const e = m.s.runs.eatCookedMutton;
        assert.strictEqual(e.food / e.n > 0 && 20 >= cap, true);
        assert.strictEqual(e.food / e.n > 0 && 10 >= cap, false);
    });

    it('mineflayer "Food is full" error text alone, without structural signal, is NOT voided', () => {
        const src = readFileSync(join(ROOT, 'src/agent/voyager.js'), 'utf8');
        const pre = readFileSync(join(ROOT, 'src/agent/precondition.js'), 'utf8');
        assert.equal(src.includes('/Food is full'), false, 'no Food-is-full regex literal');
        assert.equal(src.includes('/PREREQUISITE FAILED'), false, 'no PREREQUISITE FAILED regex literal');
        assert.equal(src.includes('.test(blob)'), false, 'no blob text scan');
        assert.match(src, /_foodRaiseSaturated/);
        assert.match(src, /_classifyUnmetPrecondition/);
        // fix74: seeded primitives write the marker only through markPreconditionUnmet (precondition.js owns the kind)
        assert.match(src, /markPreconditionUnmet\(bot\)/);
        assert.equal(src.includes('bot.__unmetPrecondition ='), false, 'no bare marker write');
        assert.match(pre, /kind: 'precondition'/);
        const bot = { output: 'FAILED to consume cooked_mutton: Food is full. Food stayed at 20.' };
        assert.strictEqual(peekPreconditionUnmet(bot), null, 'text in output is not a typed marker');
        const m = new VitalsModel({ regen: {}, runs: {}, foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } } });
        const e = m.s.runs.eatCookedMutton;
        assert.strictEqual(e, undefined);
        const saturated = Boolean(e && e.n >= 1 && e.food / e.n > 0 && 20 >= FOODMAX);
        const wouldVoid = peekPreconditionUnmet(bot) !== null || saturated;
        assert.strictEqual(wouldVoid, false);
    });

    it('voyager wiring: hunger facts + structural skip; no text-match unmet helper', () => {
        const src = readFileSync(join(ROOT, 'src/agent/voyager.js'), 'utf8');
        assert.match(src, /hunger_urgent:/);
        assert.match(src, /food_below_regen_floor:/);
        assert.match(src, /hungerText/);
        assert.match(src, /markPreconditionUnmet/);
        assert.match(src, /_classifyUnmetPrecondition/);
        assert.equal(src.includes('_unmetPrecondition('), false);
    });
});
