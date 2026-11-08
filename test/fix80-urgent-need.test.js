/**
 * fix80: drive-reduction hunger serve (belowRegen only) pre-empts via _serveUrgent after
 * repairs / before _decomposeQueue. Thompson in HP units; kind 'need' unblamed; cold-start
 * runs the normal pursue/generate-code path under currentTask=need:hunger.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { VitalsModel } from '../src/agent/vitals_model.js';
import {
    needInterruptSource, isUnblamedInterruptKind,
    sampleBeta, pickUrgentCandidate,
} from '../src/agent/urgent_need.js';
import { stepErrorSignature } from '../src/agent/voyager.js';
import { _setVersionForTest as loadMcData } from '../src/utils/mcdata.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HPMAX = 20, FOODMAX = 20;

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest('1.21.4');
    loadMcData('1.21.4');
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

function mkV({ vitals, food = 10, health = 20, skillsList, proposeTask, decompose, subgoals, deathSpots }) {
    const v = Object.create(Voyager.prototype);
    const bot = {
        health, food,
        game: { maxHealth: HPMAX, maxFood: FOODMAX },
        interrupt_code: false,
        inventory: { emptySlotCount: () => 10 },
        entity: { position: { x: 0, y: 64, z: 0 } },
        version: '1.21.4',
        currentWindow: null,
    };
    v.agent = { bot, actions: { executing: false }, openChat() {}, fatal(msg) { v._fatalMsg = msg; throw new Error('FATAL: ' + msg); } };
    v.vitals = vitals;
    v.skills = skillsList !== undefined ? skillsList : [
        { name: 'eatCookedMutton', demoted: false, mergedInto: null, task: 'Eat cooked mutton',
          stats: { success: 4, fail: 0, tasks: [] }, contract: { post: 'food_raised' } },
    ];
    v.progress = {
        subgoals: subgoals !== undefined ? subgoals : [
            { task: 'Mine 1 iron_ore', parent: 'Craft 1 iron_pickaxe', depth: 1 },
            { task: 'Smelt 1 iron_ingot', parent: 'Craft 1 iron_pickaxe', depth: 1 },
        ],
        decomposeQueue: decompose !== undefined ? decompose : { task: 'Craft 1 iron_pickaxe', reason: 'failed 2x' },
        decomposed: {}, failed: [], completed: [], blockers: [], goalStats: {},
        deathSpots: deathSpots || {},
    };
    Object.defineProperty(v, '_decomposeQueue', {
        get() { return this.progress.decomposeQueue; },
        set(q) { this.progress.decomposeQueue = q; },
    });
    v._saveProgress = () => {};
    v._curSub = null;
    v.currentTask = null;
    v._lastStepErrSig = null;
    v._afterSuccess = () => { v._afterSuccessCalled = true; };
    v._afterSuccessCalled = false;
    v.proposeTask = proposeTask || (async () => { throw new Error('proposeTask should not be called when a raiser exists'); });
    v._replay = async (label, before, route) => {
        v._replayCalls = (v._replayCalls || []).concat([{ label, route }]);
        return { ok: true, name: route.name };
    };
    v._findReplay = () => null;
    v._pursueProposedTask = async (task, proposal, before) => {
        v._pursueCalls = (v._pursueCalls || []).concat([{ task, proposal, currentTask: v.currentTask }]);
    };
    v._resolveGoal = (task) => {
        const e = v.skills.find(s => s.name === task);
        if (e) return { kind: 'skill', skill: e };
        return { kind: 'open' };
    };
    v.observe = () => ({ inventory: {}, nearby_blocks: [], position: '0,64,0', time: 'day 0' });
    return v;
}

describe('fix80: VitalsModel.hungerServe (belowRegen only; fitsGain dropped)', () => {
    it('food 10 / hp 20: servable (below regen floor 18); regenLossHp = hpMax', () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const s = m.hungerServe(10, FOODMAX, 20, HPMAX);
        assert.strictEqual(s.belowRegen, true);
        assert.strictEqual(s.servable, true);
        assert.strictEqual(s.regenLossHp, HPMAX);
    });

    it('food 19 when best gain K=6 > deficit 1: NOT servable (fitsGain no longer triggers)', () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const s = m.hungerServe(19, FOODMAX, 20, HPMAX);
        assert.strictEqual(s.belowRegen, false);
        assert.strictEqual(s.servable, false);
        assert.strictEqual(s.regenLossHp, 0);
    });

    it('food 14 above floor 12 with K=6: NOT servable (only belowRegen; no invented HP for fitsGain)', () => {
        const m = new VitalsModel({
            regen: { 12: { n: 10, up: 5 } },
            runs: {},
            foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
        });
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const s = m.hungerServe(14, FOODMAX, 20, HPMAX);
        assert.strictEqual(s.belowRegen, false);
        assert.strictEqual(s.servable, false);
        assert.strictEqual(s.regenLossHp, 0);
    });

    it('cold start: no raiser, below floor → servable with best null', () => {
        const m = liveRegen();
        const s = m.hungerServe(10, FOODMAX, 20, HPMAX);
        assert.strictEqual(s.servable, true);
        assert.strictEqual(s.best, null);
        assert.ok(s.regenLossHp > 0);
    });
});

describe('fix80: Thompson HP units + kind need', () => {
    it('needInterruptSource is kind need; unblamed with threat', () => {
        assert.deepStrictEqual(needInterruptSource('hunger food 10/20'), { kind: 'need', by: 'hunger food 10/20' });
        assert.strictEqual(isUnblamedInterruptKind('need'), true);
        assert.strictEqual(isUnblamedInterruptKind('threat'), true);
    });

    it('task value uses death-spot HP stake (shared units with hunger)', () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const v = mkV({
            vitals: m, food: 10,
            deathSpots: { '0,0': { n: 2, tasks: ['Mine 1 iron_ore', 'Mine 1 iron_ore'], pos: '0,64,0' } },
        });
        v.progress.goalStats['Mine 1 iron_ore::'] = { success: 1, fail: 3 };
        const stake = v._taskHpStake('Mine 1 iron_ore');
        assert.ok(stake > 0, 'deaths on the task yield HP stake');
        const st = v._hungerServeState();
        const cands = v._urgentCandidates(st);
        const task = cands.find(c => c.id === 'task');
        const hunger = cands.find(c => c.id === 'hunger');
        assert.ok(task.stake > 0);
        assert.strictEqual(typeof task.value, 'number');
        assert.strictEqual(typeof hunger.value, 'number');
        // both in HP units (draw × hpStake / regenLossHp)
        assert.ok(hunger.value > 0);
    });
});

describe('fix80: _serveUrgent with pending decompose (food 10 / HP 20)', () => {
    it('pre-empts: replays best raiser; queues untouched; chain resumes', async () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const v = mkV({ vitals: m, food: 10, health: 20 });
        const decBefore = JSON.stringify(v.progress.decomposeQueue);
        const subBefore = JSON.stringify(v.progress.subgoals);
        assert.strictEqual(await v._serveUrgent(), true);
        assert.strictEqual(v._replayCalls[0].label, 'need:hunger');
        assert.strictEqual(v._replayCalls[0].route.name, 'eatCookedMutton');
        assert.strictEqual(JSON.stringify(v.progress.decomposeQueue), decBefore);
        assert.strictEqual(JSON.stringify(v.progress.subgoals), subBefore);
        v.agent.bot.food = 20;   // at/above learned floor 18 → not servable
        assert.strictEqual(await v._serveUrgent(), false);
        assert.strictEqual(v._subgoalTask().task, 'Mine 1 iron_ore');
    });

    it('no pre-emption at food 19', async () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const v = mkV({ vitals: m, food: 19, health: 20 });
        assert.strictEqual(await v._serveUrgent(), false);
        assert.strictEqual(v._replayCalls, undefined);
    });

    it('cold start unreplayable proposal runs normal pursue/code-gen path under need:hunger', async () => {
        const m = liveRegen();
        let codegen = 0;
        const v = mkV({
            vitals: m, food: 10, health: 20, skillsList: [],
            proposeTask: async () => ({ task: 'Cook and eat food from inventory', reasoning: 'cold start', context: '' }),
        });
        // Real pursue path (not the stub): prove code-gen is reached for an unreplayable open goal
        v._pursueProposedTask = Voyager.prototype._pursueProposedTask;
        v._prefetchPlan = () => {};
        v._goalAlreadySatisfied = () => ({ satisfied: false, reason: 'not yet' });
        v._resolveGoal = () => ({ kind: 'open' });
        v._structuredReplay = () => null;
        v._embedReplay = async () => null;
        v._findReplay = () => null;
        v._backchain = async () => null;
        v._cursorLimited = () => false;
        v.retrieveSkills = async () => [];
        v._relevantBuiltInAPI = async () => [];
        v.unifiedAPIList = () => '';
        v.sharedHints = [];
        v._logPromptBreakdown = () => {};
        v.agent.prompter = { profile: { coding: 'Write one function.\n$SELF_PROMPT\n$MEMORY\n$STATS\n$INVENTORY\n$CODE_DOCS\n$EXAMPLES' }, coding_examples: [], replaceStrings: async s => s };
        v.agent.coder = { userGeneratedCodeLintBlockers: () => null };
        v._compactState = () => 'state';
        let sawNeedLabel = false;
        v._ask = async () => {
            sawNeedLabel = (v.currentTask === 'need:hunger');
            codegen++;
            throw new Error('CODEGEN_REACHED');
        };
        const decBefore = JSON.stringify(v.progress.decomposeQueue);
        const subBefore = JSON.stringify(v.progress.subgoals);
        await assert.rejects(() => v._serveUrgent(), /CODEGEN_REACHED/);
        assert.strictEqual(codegen, 1, 'generate-code path (_ask) must run');
        assert.strictEqual(sawNeedLabel, true, 'currentTask is need:hunger during code-gen');
        assert.strictEqual(v.currentTask, null, 'need:hunger cleared after serve ends (no sticky re-entry lock)');
        assert.strictEqual(JSON.stringify(v.progress.decomposeQueue), decBefore);
        assert.strictEqual(JSON.stringify(v.progress.subgoals), subBefore);
    });

    it('raiser-serve failures require a reason and record as skill evidence', async () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const skill = { name: 'eatCookedMutton', demoted: false, mergedInto: null, stats: { success: 4, fail: 0, tasks: [] } };
        const v = mkV({ vitals: m, food: 10, skillsList: [skill] });
        v._replay = async (label, before, route) => {
            // Simulate _attribute recording a fail on the raiser (evidence for Thompson)
            skill.stats.fail++;
            return { ok: false, name: route.name, reason: 'postcondition food_raised not held' };
        };
        assert.strictEqual(await v._serveUrgent(), true);
        assert.strictEqual(skill.stats.fail, 1, 'failure recorded as evidence');
        // Second fail increments again
        assert.strictEqual(await v._serveUrgent(), true);
        assert.strictEqual(skill.stats.fail, 2);
        // Missing reason throws
        v._replay = async () => ({ ok: false, name: 'eatCookedMutton' });
        await assert.rejects(() => v._serveUrgent(), /failed without a reason/);
    });

    it('same error signature on consecutive need steps hits loud fatal (#67)', async () => {
        const m = liveRegen();
        m.noteRun('eatCookedMutton', { hp: 20, food: 10 }, { hp: 20, food: 16 });
        const v = mkV({ vitals: m, food: 10 });
        const err = new Error('need raiser exploded');
        err.stack = 'Error: need raiser exploded\n    at Voyager._serveUrgent (file:///x/voyager.js:1:1)';
        v._replay = async () => { throw err; };
        let fatal = null;
        v.agent.fatal = (msg) => { fatal = msg; return 'fatalled'; };
        // Two consecutive step errors with the same signature → fatal (#67)
        try { await v._serveUrgent(); } catch (e) { v._onStepError(e); }
        assert.strictEqual(fatal, null, 'first occurrence is loud but not fatal');
        assert.ok(v._lastStepErrSig);
        assert.strictEqual(v.currentTask, null, 'need:hunger cleared after serve throw');
        try { await v._serveUrgent(); } catch (e) { v._onStepError(e); }
        assert.match(String(fatal), /same step error on two consecutive steps/);
        assert.strictEqual(stepErrorSignature(err), v._lastStepErrSig);
    });
});

describe('fix80: fail-loud guards', () => {
    it('missing vitals / non-numeric food throws (only need: re-entry returns false)', async () => {
        const v = mkV({ vitals: liveRegen(), food: 10 });
        v.currentTask = 'need:hunger';
        assert.strictEqual(await v._serveUrgent(), false, 're-entry excluded');
        v.currentTask = null;
        v.vitals = undefined;
        await assert.rejects(() => v._serveUrgent(), /vitals is undefined/);
        v.vitals = liveRegen();
        v.agent.bot.food = 'full';
        await assert.rejects(() => v._serveUrgent(), /bot\.food must be a number/);
    });

    it('cold-start empty/null task throws (no livelock return true)', async () => {
        const m = liveRegen();
        const v = mkV({
            vitals: m, food: 10, skillsList: [],
            proposeTask: async () => ({ task: '', reasoning: 'empty', context: '' }),
        });
        await assert.rejects(() => v._serveUrgent(), /task is empty/);
        v.proposeTask = async () => ({ task: null, reasoning: 'n', context: '' });
        await assert.rejects(() => v._serveUrgent(), /task is null/);
    });
});

describe('fix80: _interruptReason kind need is unblamed', () => {
    it('sets _lastCutKind to need', () => {
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
    it('_serveUrgent after repair / before decompose; cold-start calls _pursueProposedTask; no mid-action hunger', () => {
        const src = readFileSync(join(ROOT, 'src/agent/voyager.js'), 'utf8');
        const stepIdx = src.indexOf('async _step()');
        const step = src.slice(stepIdx, stepIdx + 2500);
        assert.ok(step.indexOf('_repairQueue') < step.indexOf('_serveUrgent()'));
        assert.ok(step.indexOf('_serveUrgent()') < step.indexOf('_decomposeQueue'));
        assert.match(src, /_pursueProposedTask\(task, proposal, before\)/);
        assert.equal(src.includes('_ensureUrgentNeedEvents'), false);
        assert.equal(src.includes('_onVitalChangeEvent'), false);
    });

    it('added src has no || / ?? / .test( / empty catch / hard-coded eat / timers', () => {
        const un = readFileSync(join(ROOT, 'src/agent/urgent_need.js'), 'utf8');
        assert.equal(/\|\||\?\?|\.test\(|catch\s*\([^)]*\)\s*\{\s*\}/.test(un), false);
        const voy = readFileSync(join(ROOT, 'src/agent/voyager.js'), 'utf8');
        const start = voy.indexOf('// fix80: shared step-boundary urgent-need');
        const end = voy.indexOf('// fix76: structural unmet-precondition classification', start);
        const block = voy.slice(start, end);
        assert.equal(/\|\||\?\?|\.test\(|catch\s*\([^)]*\)\s*\{\s*\}/.test(block), false, block.slice(0, 200));
        assert.equal(/eatCookedMutton/.test(block), false);
        assert.equal(/setTimeout|setInterval/.test(block), false);
        const vit = readFileSync(join(ROOT, 'src/agent/vitals_model.js'), 'utf8');
        const vs = vit.indexOf('// fix80: drive-reduction serve predicate');
        const ve = vit.indexOf('// fix59: which part of the LEARNED recovery', vs);
        assert.equal(/\|\||\?\?/.test(vit.slice(vs, ve)), false);
        assert.match(vit.slice(vs, ve), /Only belowRegen triggers/);
    });
});
