// fix79: idle practice fails loud. fa01ee3 had two catch-and-continue layers:
//   1) _runPracticeSkill caught a staging throw, logged "STAGING FAILED", returned "not run" and practice went on;
//   2) the session promise caught everything, logged "[idle-practice] ERROR: <message>; stopping practice" (no stack) and resolved.
// Live (iMac, 36ffd89, 14:43:52Z-15:02:47Z): 27x "[idle-practice] ERROR: Cannot convert undefined or null to object" - a skill
// saved NEW without `consumes` (fixed by fix73 fceac94) broke _shouldSkipPractice's Object.keys(skill.consumes) in every session,
// and nothing but that line said so until a restart re-normalised the index.
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let Voyager;
before(async () => { const mod = await import('../src/agent/voyager.js'); Voyager = mod.Voyager; mod._setVersionForTest('1.21.4'); });
const SRC = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
const code = s => s.split('\n').filter(l => !l.trimStart().startsWith('//')).map(l => l.replace(/\s\/\/ .*$/, '')).join('\n');

const skill = () => ({ name: 'walkWest', effects: [], consumes: {}, contract: { post: 'true' }, stats: { success: 1, fail: 0, streakFail: 0, tasks: [] } });
function mkV(stage, extra = {}) {
    const bot = { interrupt_code: false, output: '', pathfinder: { stop() {} } };
    const v = Object.create(Voyager.prototype);
    Object.assign(v, {
        skills: [skill()], progress: {}, _saveSkills: () => {}, _idlePracticeActive: true, _unjudgeableNoted: new Set(), _unverifiedConsumesNoted: new Set(),
        agent: { bot, isIdle: () => true, requestInterrupt: () => {} },
        _threats: () => 'none', observe: () => ({ inventory: {} }), _libSrcSubset: () => '', _closure: () => [], _timedBotForSkillRun: () => bot,
        _stageLintExecTraced: stage, ...extra,
    });
    v._armPracticeAbort();
    return v;
}

describe('fix79: a staging error in practice propagates', () => {
    it('a throw from staging rejects the practice run (was STAGING FAILED + notRun)', async () => {
        const v = mkV(async () => { throw new TypeError('closure is not iterable'); });
        await assert.rejects(v._runPracticeSkill(v.skills[0]), /closure is not iterable/);
        assert.deepStrictEqual([v.skills[0].stats.success, v.skills[0].stats.fail], [1, 0], 'no verdict recorded');
    });
    it('staging that returns no code throws', async () => {
        const v = mkV(async () => ({ lint: null, staged: null }));
        await assert.rejects(v._runPracticeSkill(v.skills[0]), /staging returned no code/);
    });
    it('a lint result is still data about the skill: not run this session, no exception', async () => {
        const v = mkV(async () => ({ lint: 'no-undef: foo', staged: null }));
        assert.deepStrictEqual(await v._runPracticeSkill(v.skills[0]), { notRun: 'lint failed: no-undef: foo' });
    });
});

describe('fix79: the practice session does not swallow errors', () => {
    it('a bug in practice rejects the session promise (was "[idle-practice] ERROR ...; stopping practice") and the session ends', async () => {
        const v = mkV(async () => ({ lint: null, staged: null }), { _selectPracticeSkill: () => { throw new TypeError('Cannot convert undefined or null to object'); } });
        v._idlePracticeActive = false;
        await assert.rejects(v._startIdlePractice(1), /Cannot convert undefined or null to object/);
        assert.strictEqual(v._idlePracticeActive, false);
    });
    it('_ask rejects with the practice error and still releases the next code-model call', async () => {
        let n = 0;
        const v = mkV(async () => ({ lint: null, staged: null }), {
            _overlapCpuMaintenance: () => {},
            _startIdlePractice: () => (n++ === 0 ? Promise.reject(new TypeError('practice bug')) : Promise.resolve()),
            _stopIdlePractice: () => {},
        });
        v.agent.prompter = { code_model: { sendRequest: async () => 'reply' } };
        const meta = { kind: 'test', components: { system: 1, user: 1 } };
        await assert.rejects(v._ask('s', 'u', meta), /practice bug/);
        assert.strictEqual(await v._ask('s', 'u', { kind: 'test', components: { system: 1, user: 1 } }), 'reply', 'the queue was released');
    });
    it('no catch is left in the practice session or run', () => {
        const start = SRC.indexOf('    async _startIdlePractice(callNum) {');
        const session = code(SRC.slice(start, SRC.indexOf('    _armPracticeAbort() {', start)));
        const rs = SRC.indexOf('    async _runPracticeSkill(skill) {');
        const run = code(SRC.slice(rs, SRC.indexOf('    // ---------- automatic curriculum ----------', rs)));
        assert.doesNotMatch(session, /\.catch\(|catch \(/);
        // the only catch in the run is inside the generated harness string, which re-throws
        assert.deepStrictEqual(run.match(/catch \(e\) \{[^}]*\}/g), ["catch (e) { log(bot, 'PRACTICE FAILED: ' + e.message); throw e; }"]);
    });
});

describe('fix79: _ask queue serialises only (no empty catch)', () => {
    it('awaits prev with no catch; matches _askLocal (f850a88) resolve-only mutex', () => {
        const start = SRC.indexOf('    async _ask(system, user, meta) {');
        const ask = code(SRC.slice(start, SRC.indexOf('    _hashReply(text) {', start)));
        assert.match(ask, /\n\s*await prev;\n/);
        assert.doesNotMatch(ask, /await prev; \} catch/);
        assert.doesNotMatch(ask, /previous call's error doesn't block us/);
        // previous rejection already reaches its caller; the next _ask still runs (release in finally)
        const local = code(SRC.slice(SRC.indexOf('    async _askLocal(system, user, meta) {'), SRC.indexOf('    _cursorLimited()')));
        assert.match(local, /await prev;/);
        assert.doesNotMatch(local, /await prev;.*catch/);
    });
    it('a rejected previous _ask does not poison the next (queue is resolve-only)', async () => {
        let n = 0;
        const v = mkV(async () => ({ lint: null, staged: null }), {
            _overlapCpuMaintenance: () => {},
            _startIdlePractice: () => Promise.resolve(),
            _stopIdlePractice: () => {},
        });
        v.agent.prompter = { code_model: { sendRequest: async () => { if (n++ === 0) throw new Error('first call failed'); return 'ok'; } } };
        const meta = { kind: 'test', components: { system: 1, user: 1 } };
        await assert.rejects(v._ask('s', 'u', meta), /first call failed/);
        assert.strictEqual(await v._ask('s', 'u', { kind: 'test', components: { system: 1, user: 1 } }), 'ok');
    });
});
