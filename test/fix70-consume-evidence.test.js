// fix70 (review of #65, point 3): how eatCookedMutton "learned" that it consumes cobblestone, dirt, andesite and raw_copper.
//
// Live (iMac mindcraft.log.3, 2026-11-06 01:07:52Z-01:08Z; fixture dirt_effect_01_08):
//   01:07:34Z census: cobblestone 448, no andesite / raw_copper. pickupNearbyItems runs as idle practice beside a code-model call,
//   is "ABORTED" when the call returns, but _runPracticeSkill returned without waiting for it: it kept walking and picking up
//   (+7 cobblestone, andesite 4, raw_copper 5, dirt 2) beside the next step.
//   01:07:52Z: task "eatCookedMutton: ..." starts; `before` = this.observe() (voyager _step) holds those items.
//   01:08:16Z: the replay of a DIFFERENT skill, checkInventoryForCookedMutton, ends with them gone: its output shows
//   "[toss] tossed 5 raw_copper", "[toss] tossed 4 andesite", "Moved away" (pathfinder scaffolding spends cobblestone/dirt).
//   01:08:3xZ: the generated eatCookedMutton runs (1945 ms: a check and one consume), the critic passes, and
//   _learnEffects(e, before, after) + npGraph.recordDelta(before, after) record the whole TASK window's losses as what
//   eatCookedMutton consumes: "-[cobblestone,dirt,andesite,raw_copper]". _learnEffects kept a running max that never shrinks,
//   so every later practice selection read "would consume scarce dirt (have 2, need 2)" and practice never re-measured it.
// Not the 5-45 vs 9-44 slot mismatch: both snapshots are getInventoryCounts over the same slots, and none of these items
// was in the off-hand or armour. Not parent attribution: the numbers come from the task window, not from a trace record.
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { recordConsumeEvidence, verifiedConsumes } from '../src/agent/consume_evidence.js';

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/fix70-live-eat.json', import.meta.url), 'utf8')).dirt_effect_01_08;
const SRC = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
let Voyager;
before(async () => { const mod = await import('../src/agent/voyager.js'); Voyager = mod.Voyager; mod._setVersionForTest('1.21.4'); });
const mkV = () => { const v = Object.create(Voyager.prototype); v._saveSkills = () => {}; v._unverifiedConsumesNoted = new Set(); return v; };
const legacy = () => ({ name: 'eatCookedMutton', ...JSON.parse(JSON.stringify(LIVE.index_record)) });

describe('fix70: the dirt effect, from the live window', () => {
    it('the task window (task-start before -> after another skill\'s replay) yields exactly the live record', () => {
        const e = { name: 'x', effects: [], consumes: {} };
        recordConsumeEvidence(e, LIVE.task_window_before, LIVE.after_other_skill_replay_01_08_16);
        assert.deepStrictEqual(e.consumes, LIVE.index_record.consumes);
    });
    it('the live record blocks practice before fix70 and not after: it has no run evidence', () => {
        const v = mkV(), s = legacy(), inv = { ...LIVE.after_other_skill_replay_01_08_16, dirt: 2 }, pending = new Set(['dirt']);
        // the pre-fix70 rule, verbatim from the log: have 2 < need 2 * 3
        assert.ok(pending.has('dirt') && inv.dirt < s.consumes.dirt * 3, 'would consume scarce dirt (have 2, need 2)');
        assert.deepStrictEqual(verifiedConsumes(s), {});
        assert.strictEqual(v._shouldSkipPractice(s, inv, pending), null);
    });
    it('the first measured run of eatCookedMutton replaces the stale record with what it really spends', () => {
        const v = mkV(), s = legacy();
        const inv0 = { ...LIVE.after_other_skill_replay_01_08_16 }, inv1 = { ...inv0, cooked_mutton: inv0.cooked_mutton - 1 };
        v._learnEffects(s, { inventory: inv0 }, { inventory: inv1 }, null);
        assert.deepStrictEqual(s.consumes, { cooked_mutton: 1 });
        assert.deepStrictEqual(s.consumeEvidence, { runs: 1, items: { cooked_mutton: { runs: 1, max: 1 } } });
    });
});

describe('fix70: consumption carries evidence and is re-verified', () => {
    it('an item spent once by something else drops out at the next run that does not spend it', () => {
        const s = { name: 's', consumes: {} };
        recordConsumeEvidence(s, { raw_iron: 3, dirt: 2 }, { raw_iron: 2 });
        assert.deepStrictEqual(s.consumes, { raw_iron: 1, dirt: 2 });
        recordConsumeEvidence(s, { raw_iron: 2, dirt: 2 }, { raw_iron: 1, dirt: 2 });
        assert.deepStrictEqual(s.consumes, { raw_iron: 1 });
        recordConsumeEvidence(s, { raw_iron: 5 }, { raw_iron: 3 });
        assert.deepStrictEqual(s.consumes, { raw_iron: 2 }, 'the largest amount seen');
    });
    it('consumption verified by every measured run still gates practice on a scarce pending input', () => {
        const v = mkV(), s = { name: 'smelt', effects: [], consumes: {} };
        recordConsumeEvidence(s, { raw_iron: 4 }, { raw_iron: 3 });
        recordConsumeEvidence(s, { raw_iron: 3 }, { raw_iron: 2 });
        assert.match(v._shouldSkipPractice(s, { raw_iron: 2 }, new Set(['raw_iron'])), /would consume scarce raw_iron \(have 2, need 1/);
    });
    it('bad inventories fail loud', () => {
        assert.throws(() => recordConsumeEvidence({ name: 'z' }, null, {}), /before\/after inventories are required/);
    });
});

describe('fix70: effects are measured over the skill\'s own run', () => {
    it('every _learnEffects / recordDelta call takes the run window, observed right before that run', () => {
        assert.strictEqual((SRC.match(/this\._learnEffects\((?:entry|e), before,/g) || []).length, 0);
        assert.strictEqual((SRC.match(/recordDelta\([^,]+, before\.inventory/g) || []).length, 0);
        assert.strictEqual((SRC.match(/this\._learnEffects\((?:entry|e), runBefore, after/g) || []).length, 2);
        assert.strictEqual((SRC.match(/recordDelta\([^,]+, runBefore\.inventory, after\.inventory/g) || []).length, 2);
        assert.strictEqual((SRC.match(/const runBefore = this\.observe\(\);\n\s+this\._runStart = Date\.now\(\);/g) || []).length, 2);
    });
    it('an aborted practice run has returned before _runPracticeSkill does (no practice beside the next action)', async () => {
        let running = false, finished = false;
        const bot = { interrupt_code: false };
        const v = Object.create(Voyager.prototype);
        Object.assign(v, {
            // fix74: the stop is agent.requestInterrupt() (it also stops the pathfinder), the abort is a signal, the run is traced
            agent: { bot, isIdle: () => true, requestInterrupt: () => { bot.interrupt_code = true; } }, _threats: () => 'none', observe: () => ({ inventory: {} }), _libSrcSubset: () => '', _closure: () => [],
            _timedBotForSkillRun: () => bot, skills: [], _saveSkills: () => {}, _idlePracticeActive: true,
            _stageLintExecTraced: async () => ({ lint: null, staged: { func: { main: async b => {
                running = true;
                while (!b.interrupt_code) await new Promise(r => setTimeout(r, 20));
                await new Promise(r => setTimeout(r, 300));   // the skill's own wind-down after it sees the interrupt
                finished = true;
            } } } }),
        });
        v._armPracticeAbort();
        const p = v._runPracticeSkill({ name: 'pickupNearbyItems', stats: {} });
        while (!running) await new Promise(r => setTimeout(r, 10));
        v._stopIdlePractice();
        assert.strictEqual(await p, null);
        assert.strictEqual(finished, true, 'the skill finished before the slot was given back');
        assert.strictEqual(bot.interrupt_code, false, 'the interrupt that ended it is not left on the bot');
    });
    it('_ask waits for the practice it started before returning the model reply', () => {
        assert.match(SRC, /this\._stopIdlePractice\(\);\n(?:\s*\/\/[^\n]*\n)?\s+try \{ await practicePromise; \}/);   // fix79: awaited in try/finally (the queue is released when practice rejects)
    });
});
