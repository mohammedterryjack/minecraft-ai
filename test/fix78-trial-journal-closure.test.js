/**
 * fix78 (live iMac, 15:10:28Z-16:28:21Z): 17 generated-code steps failed with "TypeError: closure is not iterable" at
 * Voyager._openTrialJournal. fix68 (19c0ecc) added a 4th `closure` parameter; the generated-code call site in _step
 * (fix65, dfd90ec) kept passing (names, own, task). The rigs that drive that path (fix55/fix56) stub _openTrialJournal,
 * so no test reached the real one with the real arguments.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VitalsModel } from '../src/agent/vitals_model.js';

let Voyager, settings;
before(async () => {
    // fix96: recipeFacts reads the registry with no catch (it swallowed the unloaded-registry error before); load it as login does
    (await import('../src/utils/mcdata.js'))._setVersionForTest('1.20.4');
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest('1.21.4');
    settings = (await import('../settings.js')).default;
});
const eq = { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' };
const LEAF = { name: 'leafSkill', task: 'leaf', description: 'leaf', code: 'async function leafSkill(bot) { return true; }', deps: [], stats: { success: 1, fail: 0, tasks: [] } };
const MID = { name: 'midSkill', task: 'mid', description: 'mid', code: 'async function midSkill(bot) { return await leafSkill(bot); }', deps: ['leafSkill'], stats: { success: 1, fail: 0, tasks: [] } };
const OTHER = { name: 'otherSkill', task: 'other', description: 'other', code: 'async function otherSkill(bot) { return true; }', deps: [], stats: { success: 1, fail: 0, tasks: [] } };
const GENERATED = '```javascript\n// DESCRIPTION: uses midSkill\nasync function freshSkill(bot) { return await midSkill(bot); }\nawait freshSkill(bot);\n```';

// drives the real _step down to the generated-code run (the 16:22:53Z path): no stub of _openTrialJournal
function codePathRig(dir) {
    const v = Object.create(Voyager.prototype);
    v.skills = [LEAF, MID, OTHER].map(s => JSON.parse(JSON.stringify(s)));
    v.dir = dir;
    v.progress = { completedAt: {}, completed: [], failed: [], goalStats: {}, fix25: true, replayThreshold: 0.85 };
    v.npGraph = { recordDelta: () => {} };
    v._saveProgress = () => {}; v._saveSkills = () => {};
    for (const m of ['_checkHomeGround', '_watchWindows', '_watchDimension', '_oneshot', '_requeueDeferred', '_prefetchPlan', '_logPromptBreakdown']) v[m] = () => {};
    for (const m of ['_queueApiLintRepairs', '_gateTrial', '_backfillContracts', '_refactor', '_prune', '_generalise', '_split', '_retention', '_idlePractice']) v[m] = async () => false;
    v._apiLinted = v._apiSignature = () => 'same'; v._apiLinted = 'same';
    v.agent = { bot: { currentWindow: null, version: '1.21.4', food: 20, health: 20, game: { maxHealth: 20, maxFood: 20 } }, prompter: { profile: { coding: 'Write one function.\n$SELF_PROMPT\n$MEMORY\n$STATS\n$INVENTORY\n$CODE_DOCS\n$EXAMPLES' }, coding_examples: [], replaceStrings: async s => s },
        coder: { userGeneratedCodeLintBlockers: () => null } };
    v.vitals = new VitalsModel({ regen: {}, runs: {}, foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } } });
    v.observe = () => ({ inventory: {}, equipment: eq, nearby_blocks: [], position: '0, 64, 0', biome: 'plains', time: 'day', health_value: 20, health_max: 20, food_value: 20, food_max: 20, inventory_slots: '0/36', empty_inventory_slots: 36, threats: 'none' });
    v._compactState = () => 'state';
    v._subgoalTask = () => null;
    v._takePlan = async () => ({ task: 'Do a fresh thing', reasoning: 'r' });
    v._rejectTask = () => null;
    v._goalAlreadySatisfied = () => ({ satisfied: false, reason: 'not yet' });
    v._resolveGoal = () => ({ kind: 'open' });
    v._structuredReplay = () => null; v._embedReplay = async () => null; v._backchain = async () => null;
    v._cursorLimited = () => false;
    v.retrieveSkills = async () => [];
    v._relevantBuiltInAPI = async () => [];
    v.unifiedAPIList = () => '';
    v.sharedHints = [];
    v._ask = async () => GENERATED;
    v._stageLintExecTraced = async () => ({ lint: null, staged: { func: { main: async () => {} } } });
    v._timedBotForSkillRun = () => ({});
    v.journals = [];
    v._run = async () => {   // the run is where the journal must already be on disk; read it, then end the step
        v.journals.push(JSON.parse(readFileSync(join(dir, 'trials_inflight.json'), 'utf8')));
        throw new Error('RIG: stop after the journalled run started');
    };
    return v;
}

describe('fix78 the generated-code run is journalled with its staged closure', () => {
    it('_step reaches the run (was: TypeError closure is not iterable) and the journal lists own deps and their closure', async () => {
        assert.strictEqual(typeof settings.skill_topk, 'number');
        const dir = mkdtempSync(join(tmpdir(), 'fix78-'));
        try {
            const v = codePathRig(dir);
            await assert.rejects(v._step(), /RIG: stop after the journalled run started/);
            assert.strictEqual(v.journals.length, 1);
            const j = v.journals[0];
            assert.strictEqual(j.root, 'freshSkill');
            assert.strictEqual(j.task, 'Do a fresh thing');
            assert.deepStrictEqual(Object.keys(j.ran).sort(), ['leafSkill', 'midSkill'], 'midSkill (called) and leafSkill (its closure); otherSkill is not staged');
            assert.ok(!existsSync(join(dir, 'trials_inflight.json')), 'the journal is closed in finally');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('fix78 _openTrialJournal fails loud without a closure', () => {
    const rigJ = dir => { const v = Object.create(Voyager.prototype); v.skills = [LEAF, MID].map(s => JSON.parse(JSON.stringify(s))); v.dir = dir; return v; };
    it('3 args (the live call shape) throws a clear error naming the root, not "is not iterable"', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix78-'));
        try {
            assert.throws(() => rigJ(dir)._openTrialJournal([], 'freshSkill', 'Do a fresh thing'), /_openTrialJournal\("freshSkill".*closure must be the Set of library skills the run can execute, got undefined/);
            assert.throws(() => rigJ(dir)._openTrialJournal([], 'freshSkill', 't', null), /got null/);
            assert.throws(() => rigJ(dir)._openTrialJournal([], 'freshSkill', 't', ['midSkill']), /got object/, 'an array is not the closure Set');
            assert.ok(!existsSync(join(dir, 'trials_inflight.json')), 'nothing written on a caller bug');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it('a Set closure writes the journal and the closer removes it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix78-'));
        try {
            const close = rigJ(dir)._openTrialJournal([], 'midSkill', 't', new Set(['midSkill', 'leafSkill']));
            assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'trials_inflight.json'), 'utf8')).ran).sort(), ['leafSkill', 'midSkill']);
            close();
            assert.ok(!existsSync(join(dir, 'trials_inflight.json')));
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

// top-level argument count of every call `name(` in src (skips strings, template literals and nested brackets)
function callArgCounts(src, name) {
    const out = [];
    const re = new RegExp(`\\.${name}\\(`, 'g');
    let m;
    while ((m = re.exec(src))) {
        let i = m.index + m[0].length, depth = 0, args = 0, any = false, q = null;
        for (; i < src.length; i++) {
            const c = src[i];
            if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
            if (c === '"' || c === "'" || c === '`') { q = c; any = true; continue; }
            if ('([{'.includes(c)) { depth++; any = true; continue; }
            if (')]}'.includes(c)) { if (depth === 0) break; depth--; continue; }
            if (c === ',' && depth === 0) { args++; continue; }
            if (!/\s/.test(c)) any = true;
        }
        out.push({ line: src.slice(0, m.index).split('\n').length, args: any ? args + 1 : 0 });
    }
    return out;
}
describe('fix78 every _openTrialJournal call site passes (names, root, task, closure)', () => {
    it('voyager.js: all call sites have 4 arguments', () => {
        const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        const calls = callArgCounts(src, '_openTrialJournal');
        assert.ok(calls.length >= 3, `found ${calls.length} call sites`);
        assert.deepStrictEqual(calls.filter(c => c.args !== 4), [], JSON.stringify(calls));
    });
    it('the scanner sees the live bug shape as 3 arguments', () => {
        const live = 'this._openTrialJournal(Object.keys(over).filter(n => stageNameSet.has(n)), own, task);';
        assert.deepStrictEqual(callArgCounts(live, '_openTrialJournal').map(c => c.args), [3]);
    });
});
