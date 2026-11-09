/**
 * fix58 (live iMac 10:51-11:02 GMT): hp 17.27 / food 17 for 11 minutes with 0 eats; health never regenerated.
 * Root cause: the curriculum (the only goal ranking since fix18) got hp/food as bare numbers with no learned relation between
 * food level and hp regen, and no skill had a learned food/hp effect (effects are inventory-only; the per-call hp/food snapshots
 * and the 1 Hz hp sampler were never learned from), so nothing ranked eating/recovery above iron progress.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { VitalsModel } from '../src/agent/vitals_model.js';

// Real vitals from icefox2000 (bots/icefox2000/critic_cases.jsonl + violated_contracts.jsonl), contiguous segments only, [hp, food].
const REAL = {
    // 2026-11-05 19:49:24Z..20:16:58Z ensureFurnace/smelt/craft: hp 15 at food 2 -> 7 (after eating) -> 2, no rise
    lowFood: [[15, 2], [15, 2], [15, 2], [15, 2], [15, 2], [15, 2], [15, 7], [15, 7], [15, 7], [15, 7], [15, 7], [15, 7], [15, 6], [15, 2], [15, 2], [15, 2]],
    // 2026-11-05 21:06:04Z..21:25:21Z craftIronPickaxe: hp 9 at food 12 for 19 min
    food12: [[9, 12], [9, 12], [9, 12], [9, 12]],
    // 2026-11-05 23:09:15Z..23:37:14Z wool/bed tasks: hp 9 at food 17 for 28 min
    food17: Array.from({ length: 14 }, () => [9, 17]),
    // 2026-11-06 01:07:43Z..01:10:06Z eatCookedMutton then verifyFoodStatus: food 12 -> 18, hp 1 -> 18 -> 19
    eatThenRegen: [[1, 12], [1, 12], [1, 18], [18, 17], [19, 20]],
    // 2026-11-06 10:51:15Z..11:02:32Z (live stuck state): hp 17.26666831970215 at food 17, then food 16; no eat
    stuck: [...Array.from({ length: 20 }, () => [17.26666831970215, 17]), [17.26666831970215, 16]],
};
const HPMAX = 20;
const feed = (m, seg) => { for (let i = 1; i < seg.length; i++) m.observeSample({ h: seg[i - 1][0], f: seg[i - 1][1] }, { h: seg[i][0], f: seg[i][1] }, HPMAX); };
const learnedFromReal = () => { const m = new VitalsModel({ regen: {}, runs: {} }); for (const k of ['lowFood', 'food12', 'food17', 'eatThenRegen']) feed(m, REAL[k]); return m; };

describe('fix58: learned food -> hp regen relation', () => {
    it('reproduces the live stuck state (hp 17.27, food 17, no eats) as learned "not recovering"', () => {
        const m = learnedFromReal();
        feed(m, REAL.stuck);
        const r = m.recovery(17.26666831970215, HPMAX, 17);
        assert.strictEqual(r.below, true);
        assert.strictEqual(r.low.up, 0, 'hp never rose at food <= 17 in the real history');
        assert.ok(r.low.n > 20, `no-rise evidence at food <= 17 from real samples (n=${r.low.n})`);
        assert.strictEqual(r.firstRise.f, 18, 'lowest food level with an observed rise is learned from the data (eat to 18 then hp 1 -> 18)');
        assert.strictEqual(r.blocked, true);
        const t = m.recoveryText(r);
        assert.match(t, /hp 17\.3\/20, food 17/);
        assert.match(t, /hp rose in 0\/\d+ below-max samples/);
        assert.match(t, /not recovering at food 17/);
    });
    it('food 16 after the stuck run is also blocked; at the learned rise level it is not', () => {
        const m = learnedFromReal(); feed(m, REAL.stuck);
        assert.strictEqual(m.recovery(17.27, HPMAX, 16).blocked, true);
        assert.strictEqual(m.recovery(17.27, HPMAX, 18).blocked, false);
        assert.strictEqual(m.recovery(17.27, HPMAX, 20).blocked, false);
    });
    it('a rise is credited to the highest food level in the interval, a non-rise only to a constant food level', () => {
        const m = new VitalsModel({ regen: {}, runs: {} });
        assert.strictEqual(m.observeSample({ h: 1, f: 18 }, { h: 18, f: 17 }, HPMAX).up, 1);
        assert.deepStrictEqual(m.s.regen[18], { n: 1, up: 1 });
        assert.strictEqual(m.s.regen[17], undefined);
        assert.strictEqual(m.observeSample({ h: 1, f: 12 }, { h: 1, f: 18 }, HPMAX), null, 'eating interval without rise is no evidence');
    });
    it('damage, death/respawn and full-health intervals carry no regen evidence', () => {
        const m = new VitalsModel({ regen: {}, runs: {} });
        assert.strictEqual(m.observeSample({ h: 17, f: 17 }, { h: 15, f: 17 }, HPMAX), null);
        assert.strictEqual(m.observeSample({ h: 0, f: 0 }, { h: 20, f: 20 }, HPMAX), null);
        assert.strictEqual(m.observeSample({ h: 9, f: 17 }, { h: 0, f: 17 }, HPMAX), null);
        assert.strictEqual(m.observeSample({ h: 20, f: 20 }, { h: 20, f: 20 }, HPMAX), null);
        assert.deepStrictEqual(m.s.regen, {});
    });
    it('no rise seen anywhere -> not blocked, says so (no assumed regen level)', () => {
        const m = new VitalsModel({ regen: {}, runs: {} }); feed(m, REAL.food17);
        const r = m.recovery(9, HPMAX, 17);
        assert.strictEqual(r.blocked, false);
        assert.match(m.recoveryText(r), /hp has not been seen rising at any food level yet/);
    });
    it('too few no-rise samples for the observed rise rate -> not (yet) blocked', () => {
        const m = new VitalsModel({ regen: { 18: { n: 8, up: 2 }, 17: { n: 3, up: 0 } }, runs: {} });
        assert.strictEqual(m.recovery(17, HPMAX, 17).blocked, false, '3 samples * 0.25 rate < 1 expected rise');
        m.s.regen[17].n = 4;
        assert.strictEqual(m.recovery(17, HPMAX, 17).blocked, true);
    });
    it('hp at max -> no recovery line', () => {
        const m = learnedFromReal();
        assert.strictEqual(m.recoveryText(m.recovery(20, HPMAX, 17)), null);
    });
    it('fails loud on missing vitals', () => {
        const m = new VitalsModel({ regen: {}, runs: {} });
        assert.throws(() => m.observeSample({ h: 17, f: undefined }, { h: 17, f: 17 }, HPMAX), /prev\.f must be a number/);
        assert.throws(() => m.recovery(17, HPMAX, undefined), /food must be a number/);
        assert.throws(() => new VitalsModel(undefined), /persisted store/);
    });
});

describe('fix58: learned skill food effects', () => {
    it('eatCookedMutton real run (food 12 -> 18) is learned as a food raiser; hunger-only skills are not', () => {
        const m = new VitalsModel({ regen: {}, runs: {} });
        m.noteRun('eatCookedMutton', { hp: 1, food: 12 }, { hp: 1, food: 18 });
        m.noteRun('craftStoneShovel', { hp: 17.27, food: 17 }, { hp: 17.27, food: 16 });
        m.noteRun('mineOneIronOre', { hp: 17.27, food: 17 }, { hp: 17.27, food: 17 });
        assert.deepStrictEqual(m.foodRaisers().map(x => [x.name, x.food, x.n]), [['eatCookedMutton', 6, 1]]);
        const t = m.recoveryText(m.recovery(1, HPMAX, 12));
        assert.match(t, /skills observed raising food: eatCookedMutton \+6\.0 food\/run \(1 runs\)/);
    });
});

describe('fix58: wiring into voyager', () => {
    let Voyager;
    before(async () => { Voyager = (await import('../src/agent/voyager.js')).Voyager; });
    const mk = (vit, hp, food) => {
        const v = Object.create(Voyager.prototype);
        v.vitals = new VitalsModel(vit);
        v.agent = { bot: { health: hp, food, game: {} } };
        return v;
    };
    it('_learnVitalsEffects learns from traced runs (skips interrupted/dead/no-snapshot records)', () => {
        const v = mk({ regen: {}, runs: {} }, 20, 20);
        v._learnVitalsEffects([
            { name: 'eatFood', s0: { hp: 10, food: 0, alive: true }, s1: { hp: 10, food: 6, alive: true } },
            { name: 'x', intr: true, s0: { hp: 10, food: 0, alive: true }, s1: { hp: 10, food: 6, alive: true } },
            { name: 'y', s0: { hp: 1, food: 0, alive: true }, s1: { hp: 0, food: 0, alive: false } },
            { name: 'skills.consume' },
        ]);
        assert.deepStrictEqual(Object.keys(v.vitals.s.runs), ['eatFood']);
    });
    it('_planStale re-plans when the learned recovery state changed since the plan was made', () => {
        const v = Object.create(Voyager.prototype);
        v.progress = { failed: [] };
        const basis = { position: '0, 0, 0', time: 'day (1)', health: '17/20', food: '18/20', threats: 'none', recent_deaths: 'none', health_recovery_blocked: false };
        // fix59: the learned recovery outlook travels with the plan (pl.rec) and is compared with the current one
        const m = learnedFromReal(); feed(m, REAL.stuck);
        const pl = { t: Date.now(), task: 'Mine 1 iron_ore', basis, rec: m.recovery(17, HPMAX, 18) };
        assert.strictEqual(v._planStale(pl, { task: 'Mine 1 diamond_ore' }, { ...basis }, m.recovery(17, HPMAX, 18)), null);
        assert.match(v._planStale(pl, { task: 'Mine 1 diamond_ore' }, { ...basis, food: '17/20', health_recovery_blocked: true }, m.recovery(17, HPMAX, 17)), /learned health recovery changed/);
    });
    it('curriculum prompt carries the learned recovery facts in the stuck state', async () => {
        const m = learnedFromReal(); feed(m, REAL.stuck);
        const v = mk(m.s, 17.26666831970215, 17);
        v.agent.name = 'icefox2000';
        v.skills = [];
        v.progress = { completedAt: {}, completed: [], failed: [], blockers: [] };
        v.repairMemory = { getWorkflowsForTask: () => [], formatWorkflowHints: () => '' };
        v._hutBuilt = () => false; v._cursorLimited = () => false; v._logPromptBreakdown = () => {}; v._saveProgress = () => {};
        let prompt = null;
        v._askLocal = async (sys, user) => { prompt = user; return '{"reasoning":"r","task":"eatFood","context":""}'; };
        const state = { position: '0, 32, 0', biome: 'plains', time: 'day (1)', health_value: 17, health_max: 20, food_value: 17, food_max: 20, inventory_slots: '1/36', empty_inventory_slots: 35, threats: 'none', inventory: {}, equipment: { hand: 'empty' } };
        const r = await v.proposeTask(state);
        assert.strictEqual(r.task, 'eatFood');
        assert.match(prompt, /health_recovery \(learned from own vitals\): hp 17\.3\/20, food 17; .*not recovering at food 17/);
    });
});

describe('fix58: nothing hard-coded', () => {
    const src = readFileSync(new URL('../src/agent/vitals_model.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    it('no food/health cutoff literals or name lists in the vitals model', () => {
        assert.ok(!/\b(1[0-9]|20)\b/.test(src), 'no vanilla regen level / max literals');
        assert.ok(!/\?\?|\|\|\s*(\d|'|"|`|\[|\{|null|true|false|undefined)/.test(src), 'no ||/?? defaults');
        assert.ok(!/catch\s*\(/.test(src), 'no catch');
        assert.ok(!/mutton|beef|bread|apple|eat[A-Z]/.test(src), 'no food/skill names');
    });
});
