/**
 * fix80: drive-reduction hunger serve (not hunger().urgent) pre-empts via one shared
 * _serveUrgent slot after repairs / before _decomposeQueue. Thompson arbitration in HP
 * units; kind 'need' is unblamed. Hunger is step-boundary only (mid-action = fix77).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { VitalsModel } from '../src/agent/vitals_model.js';
import {
    checkNeedSource, needInterruptSource, isUnblamedInterruptKind,
    sampleBeta, pickUrgentCandidate,
} from '../src/agent/urgent_need.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HPMAX = 20, FOODMAX = 20;

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest('1.21.4');
});

function liveRegen(runs = {}) {
    return new VitalsModel({
        regen: {
            15: { n: 1021, up: 0 }, 16: { n: 246, up: 0 }, 17: { n: 76, up: 0 },
            18: { n: 14, up: 4 }, 19: { n: 10, up: 3 }, 20: { n: 14, up: 9 },
        },
        runs,
        foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
    });
}

function mkV({ vitals, food = 10, health = 20, skillsList, proposeTask, decompose, subgoals }) {
    const v = Object.create(Voyager.prototype);
    const bot = {
        health, food,
        game: { maxHealth: HPMAX, maxFood: FOODMAX },
        interrupt_code: false,
        inventory: { emptySlotCount: () => 10 },
        entity: { position: { x: 0, y: 64, z: 0 } },
    };
    v.agent = { bot, actions: { executing: false }, openChat() {} };
    v.vitals = vitals;
    v.skills = skillsList !== undefined ? skillsList : [
        { name: 'eatCookedMutton', demoted: false, mergedInto: null, task: 'Eat cooked mutton',
          stats: { success: 4, fail: 0 }, contract: { post: 'food_raised' } },
    ];
    v.progress = {
        subgoals: subgoals !== undefined ? subgoals : [
            { task: 'Mine 1 iron_ore', parent: 'Craft 1 iron_pickaxe', depth: 1 },
            { task: 'Smelt 1 iron_ingot', parent: 'Craft 1 iron_pickaxe', depth: 1 },
        ],
        decomposeQueue: decompose !== undefined ? decompose : { task: 'Craft 1 iron_pickaxe', reason: 'failed 2x' },
        decomposed: {}, failed: [], completed: [], blockers: [], goalStats: {},
    };
    Object.defineProperty(v, '_decomposeQueue', {
        get() { return this.progress.decomposeQueue; },
        set(q) { this.progress.decomposeQueue = q; },
    });
    v._saveProgress = () => {};
    v._curSub = null;
    v.currentTask = null;
    v._afterSuccess = () => { v._afterSuccessCalled = true; };
    v._afterSuccessCalled = false;
    v.proposeTask = proposeTask || (async () => { throw new Error('proposeTask should not be called when a raiser exists'); });
    v._replay = async (label, before, route) => {
        v._replayCalls = (v._replayCalls || []).concat([{ label, route }]);
        return { ok: true, name: route.name };
    };
    v._findReplay = () => null;
    v._resolveGoal = (task) => {
        const e = v.skills.find(s => s.name === task);
        if (e) return { kind: 'skill', skill: e };
        return { kind: 'open' };
    };
    v._postHolds = () => true;
    v.observe = () => ({ inventory: {}, position: '0,64,0', time: 'day 0' });
    return v;
}

describe('fix80: VitalsModel.hungerServe (drive-reduction, not hunger.urgent)', () => {
    it('food 10 / hp 20: servable (below regen floor 18); regenLossHp = hpMax', () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 }); // K=6
        const s = m.hungerServe(10, FOODMAX, 20, HPMAX);
        assert.strictEqual(s.belowRegen, true);
        assert.strictEqual(s.servable, true);
        assert.strictEqual(s.best.K, 6);
        assert.strictEqual(s.regenLossHp, HPMAX);
        // hunger().urgent still true for the prompt, but that is NOT the serve trigger
        assert.strictEqual(m.hunger(10, HPMAX, 10, FOODMAX).urgent, true);
    });

    it('food 19 when best gain K=6 > deficit 1: NOT servable (no thrash)', () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 }); // K=6
        const s = m.hungerServe(19, FOODMAX, 20, HPMAX);
        assert.strictEqual(s.deficit, 1);
        assert.strictEqual(s.fitsGain, false); // 1 < 6
        assert.strictEqual(s.belowRegen, false); // 19 >= 18
        assert.strictEqual(s.servable, false);
        assert.strictEqual(s.regenLossHp, 0);
        // Contrast: hunger().urgent IS true at 19/20 once decay+raiser exist — that is why we must not use it
        m.observeFoodSample({ f: 20 }, { f: 19 });
        assert.strictEqual(m.hunger(20, HPMAX, 19, FOODMAX).urgent, true);
        assert.strictEqual(m.hungerServe(19, FOODMAX, 20, HPMAX).servable, false);
    });

    it('food 14 with K=6 above a floor of 12: servable via fitsGain; regenLossHp 0 (Thompson yields to task)', () => {
        const m = new VitalsModel({
            regen: { 12: { n: 10, up: 5 } },
            runs: {},
            foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
        });
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const s = m.hungerServe(14, FOODMAX, 20, HPMAX);
        assert.strictEqual(s.belowRegen, false);
        assert.strictEqual(s.fitsGain, true); // deficit 6 >= K 6
        assert.strictEqual(s.servable, true);
        assert.strictEqual(s.regenLossHp, 0);
    });

    it('cold start: no raiser, below floor → servable with best null (model path)', () => {
        const m = liveRegen();
        const s = m.hungerServe(10, FOODMAX, 20, HPMAX);
        assert.strictEqual(s.servable, true);
        assert.strictEqual(s.best, null);
        assert.strictEqual(s.fitsGain, false);
        assert.ok(s.regenLossHp > 0);
    });
});

describe('fix80: Thompson helpers + kind need', () => {
    it('needInterruptSource is kind need; unblamed with threat', () => {
        assert.deepStrictEqual(needInterruptSource('hunger food 10/20'), { kind: 'need', by: 'hunger food 10/20' });
        assert.strictEqual(isUnblamedInterruptKind('need'), true);
        assert.strictEqual(isUnblamedInterruptKind('threat'), true);
        assert.strictEqual(isUnblamedInterruptKind('timeout'), false);
        assert.throws(() => checkNeedSource({ kind: 'need' }), /by required/);
    });

    it('pickUrgentCandidate takes the argmax (no fixed priority)', () => {
        const w = pickUrgentCandidate([
            { id: 'task', value: 0.9 },
            { id: 'hunger', value: 12.0 },
            { id: 'threat', value: 3.0 },
        ]);
        assert.strictEqual(w.id, 'hunger');
    });

    it('sampleBeta(s+1,f+1) stays in (0,1)', () => {
        for (let i = 0; i < 20; i++) {
            const x = sampleBeta(5, 2);
            assert.ok(x > 0 && x < 1, String(x));
        }
    });
});

describe('fix80: _serveUrgent with pending decompose (food 10 / HP 20)', () => {
    it('pre-empts: replays best raiser, leaves decompose + subgoals untouched, then chain can resume', async () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const v = mkV({ vitals: m, food: 10, health: 20 });
        const decBefore = JSON.stringify(v.progress.decomposeQueue);
        const subBefore = JSON.stringify(v.progress.subgoals);

        // Force hunger to win Thompson: regenLossHp=20, raiser Beta high → value >> task
        const served = await v._serveUrgent();
        assert.strictEqual(served, true);
        assert.ok(v._replayCalls && v._replayCalls.length === 1);
        assert.strictEqual(v._replayCalls[0].label, 'need:hunger');
        assert.strictEqual(v._replayCalls[0].route.name, 'eatCookedMutton');
        assert.strictEqual(JSON.stringify(v.progress.decomposeQueue), decBefore, 'decompose deferred untouched');
        assert.strictEqual(JSON.stringify(v.progress.subgoals), subBefore, 'subgoals deferred untouched');
        assert.strictEqual(v._curSub, null);

        // Simulate food raised → next serve returns false → chain resumes
        v.agent.bot.food = 16;
        assert.strictEqual(await v._serveUrgent(), false);
        const sub = v._subgoalTask();
        assert.strictEqual(sub.task, 'Mine 1 iron_ore');
        assert.strictEqual(v.progress.subgoals.length, 1);
        // Decompose still pending for a later step
        assert.deepStrictEqual(v.progress.decomposeQueue, JSON.parse(decBefore));
    });

    it('no pre-emption at food 19 when best gain > 1', async () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 }); // K=6
        const v = mkV({ vitals: m, food: 19, health: 20 });
        const decBefore = JSON.stringify(v.progress.decomposeQueue);
        const subBefore = JSON.stringify(v.progress.subgoals);
        assert.strictEqual(await v._serveUrgent(), false);
        assert.strictEqual(v._replayCalls, undefined);
        assert.strictEqual(JSON.stringify(v.progress.decomposeQueue), decBefore);
        assert.strictEqual(JSON.stringify(v.progress.subgoals), subBefore);
    });

    it('fitsGain above floor with regenLossHp 0 does not consume the step (value<=0)', async () => {
        // Floor at 12 so food 14 is above floor; K=6 → deficit 6 fits
        const m = new VitalsModel({
            regen: { 12: { n: 10, up: 5 } },
            runs: {},
            foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
        });
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const v = mkV({ vitals: m, food: 14, health: 20 });
        const st = v._hungerServeState();
        assert.strictEqual(st.servable, true);
        assert.strictEqual(st.regenLossHp, 0);
        assert.strictEqual(await v._serveUrgent(), false);
    });

    it('cold start (no raiser): surfaces need to proposeTask; queues untouched', async () => {
        let note = null;
        const m = liveRegen();
        const v = mkV({
            vitals: m, food: 10, health: 20, skillsList: [],
            proposeTask: async (obs) => { note = obs.note; return { task: 'Gather food', reasoning: 'cold start', context: '' }; },
        });
        const decBefore = JSON.stringify(v.progress.decomposeQueue);
        const subBefore = JSON.stringify(v.progress.subgoals);
        assert.strictEqual(await v._serveUrgent(), true);
        assert.match(note, /LEARNED vital need/);
        assert.match(note, /deferred/);
        assert.strictEqual(JSON.stringify(v.progress.decomposeQueue), decBefore);
        assert.strictEqual(JSON.stringify(v.progress.subgoals), subBefore);
        assert.strictEqual(v._replayCalls, undefined, 'no hard-coded eat replay');
    });
});

describe('fix80: _interruptReason kind need is unblamed', () => {
    it('sets _lastCutKind to need (not interrupt)', () => {
        const v = Object.create(Voyager.prototype);
        v.agent = { bot: { entity: { position: { x: 0, y: 64, z: 0 } } } };
        v._diedInRun = () => null;
        v._stalledInRun = () => null;
        v._surfaceY = () => 64;
        const msg = v._interruptReason({
            interrupted: true, timedout: false, message: '',
            interruptedBy: needInterruptSource('hunger food 10/20 below floor'),
        });
        assert.match(msg, /cut off by need/);
        assert.strictEqual(v._lastCutKind, 'need');
    });
});

describe('fix80: wiring + Mo-rule static scans', () => {
    it('_serveUrgent sits after _repairQueue and before _decomposeQueue; no mid-action hunger interrupt', () => {
        const src = readFileSync(join(ROOT, 'src/agent/voyager.js'), 'utf8');
        const stepIdx = src.indexOf('async _step()');
        const step = src.slice(stepIdx, stepIdx + 2500);
        const repair = step.indexOf('_repairQueue');
        const serve = step.indexOf('_serveUrgent()');
        const deco = step.indexOf('_decomposeQueue');
        assert.ok(repair > 0 && serve > repair && deco > serve, `order repair(${repair})<serve(${serve})<deco(${deco})`);
        assert.equal(src.includes('_ensureUrgentNeedEvents'), false);
        assert.equal(src.includes('_onVitalChangeEvent'), false);
        assert.equal(src.includes("bot.on('health'"), false);
        assert.match(src, /isUnblamedInterruptKind/);
        assert.match(src, /hungerServe/);
    });

    it('added src has no || / ?? / .test( / empty catch / hard-coded eat / food=20 threshold / timers', () => {
        const un = readFileSync(join(ROOT, 'src/agent/urgent_need.js'), 'utf8');
        assert.equal(un.includes('??'), false);
        assert.equal(/\|\|/.test(un), false);
        assert.equal(/\.test\(/.test(un), false);
        assert.equal(/catch\s*\([^)]*\)\s*\{\s*\}/.test(un), false);

        const voy = readFileSync(join(ROOT, 'src/agent/voyager.js'), 'utf8');
        const start = voy.indexOf('// fix80: shared step-boundary urgent-need');
        const end = voy.indexOf('// fix76: structural unmet-precondition classification', start);
        assert.ok(start > 0 && end > start);
        const block = voy.slice(start, end);
        assert.equal(block.includes('??'), false, '?? in fix80 block');
        assert.equal(/\|\|/.test(block), false, '|| in fix80 block');
        assert.equal(/\.test\(/.test(block), false, '.test( in fix80 block');
        assert.equal(/catch\s*\([^)]*\)\s*\{\s*\}/.test(block), false);
        assert.equal(/eatCookedMutton/.test(block), false, 'no hard-coded skill name');
        assert.equal(/food\s*[=<>]=?\s*20/.test(block), false);
        assert.equal(/setTimeout|setInterval/.test(block), false);

        const vit = readFileSync(join(ROOT, 'src/agent/vitals_model.js'), 'utf8');
        const vs = vit.indexOf('// fix80: drive-reduction serve predicate');
        const ve = vit.indexOf('// fix59: which part of the LEARNED recovery', vs);
        const vb = vit.slice(vs, ve);
        assert.equal(vb.includes('??'), false);
        assert.equal(/\|\|/.test(vb), false);
    });
});
