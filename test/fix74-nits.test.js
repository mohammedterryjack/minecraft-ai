// fix74: nits carried from fix58/fix70/fix76 review, each required-or-throw with no default.
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VitalsModel } from '../src/agent/vitals_model.js';
import { loadManifest, applyManifest, checkRecord } from '../scripts/reset_bug_poisoned.js';
import * as skillsLib from '../src/agent/library/skills.js';
import { Coder, getBareAPI, PRECONDITION_UNMET_BINDING } from '../src/agent/coder.js';
import { missingCalls, reservedNamesUsed } from '../src/agent/skill_graph.js';
import { Voyager } from '../src/agent/voyager.js';
import { peekPreconditionUnmet } from '../src/agent/precondition.js';

const src = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
// code only: the fix comments quote the old code they replace
const code = f => src(f).split('\n').filter(l => !l.trimStart().startsWith('//')).map(l => l.replace(/\s\/\/ .*$/, '')).join('\n');
const MANIFEST = new URL('../scripts/bug_poisoned_manifest.json', import.meta.url).pathname;
const FIX = new URL('./fixtures/fix76-poisoned', import.meta.url).pathname;

describe('fix74: hungerText / recoveryText list every learned food-raiser', () => {
    const store = () => ({ regen: { 18: { n: 4, up: 4 } }, runs: { a: { n: 1, food: 6, hp: 0 }, b: { n: 1, food: 5, hp: 0 }, c: { n: 2, food: 4, hp: 0 }, d: { n: 1, food: 1, hp: 0 } }, foodSamples: { drop: { n: 3, sum: 3 }, rise: { n: 0, sum: 0 } } });
    it('the fourth raiser is not cut off', () => {
        const m = new VitalsModel(store());
        const t = m.hungerText(m.hunger(20, 20, 10, 20));
        for (const n of ['a', 'b', 'c', 'd']) assert.match(t, new RegExp(`\\b${n} \\+`));
    });
    it('raisersText needs the list', () => {
        assert.strictEqual(VitalsModel.raisersText([]), 'none observed yet');
        assert.throws(() => VitalsModel.raisersText(undefined), /needs the foodRaisers\(\) list/);
        assert.doesNotMatch(code('src/agent/vitals_model.js'), /slice\(0, 3\)/);
    });
});

describe('fix74: the precondition marker has one writer, and generated code cannot reach it', () => {
    const NAME = '__fix74_nits__';
    after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));
    const stubBot = () => ({ registry: { itemsByName: {}, blocksByName: {}, entitiesByName: {} } });
    it('seeded primitives call the internal binding; no bare marker writes remain', () => {
        const v = src('src/agent/voyager.js');
        assert.strictEqual(v.includes('bot.__unmetPrecondition ='), false);
        assert.strictEqual((v.match(new RegExp(`${PRECONDITION_UNMET_BINDING}\\(bot\\);`, 'g')) || []).length, 3);
    });
    it('it is not on the model-visible API: not a skills.js export, not in getBareAPI (prompts, lint sandbox)', () => {
        assert.strictEqual(Object.hasOwn(skillsLib, 'markPreconditionUnmet'), false);
        const api = getBareAPI();
        assert.strictEqual(api.names.has('markPreconditionUnmet'), false);
        assert.strictEqual(api.names.has(PRECONDITION_UNMET_BINDING), false);
        assert.strictEqual(api.sigs.some(x => x.includes('PreconditionUnmet')), false);
    });
    it('generated code that calls it, by either name, is rejected by the writeCode gate', () => {
        const coder = new Coder({ name: NAME, bot: stubBot() });
        for (const fn of ['markPreconditionUnmet', PRECONDITION_UNMET_BINDING]) {
            const r = coder.userGeneratedCodeLintBlockers(`async function eatSomething(bot) {\n    ${fn}(bot);\n    return false;\n}\nawait eatSomething(bot);`, []);
            assert.ok(r, `${fn} passed the gate`);
            assert.match(r, new RegExp(fn));
        }
    });
    it('a saved or repaired skill that names it is rejected by saveSkill', async () => {
        // missingCalls sees camelCase calls only: markPreconditionUnmet is unknown there; the __ binding is caught by the reserved check
        const names = new Set(['eatSomething', ...getBareAPI().names]);
        assert.deepStrictEqual(missingCalls('async function eatSomething(bot) { markPreconditionUnmet(bot); return false; }', 'eatSomething', names), ['markPreconditionUnmet']);
        assert.deepStrictEqual(reservedNamesUsed(`async function eatSomething(bot) { ${PRECONDITION_UNMET_BINDING}(bot); return false; }`, [PRECONDITION_UNMET_BINDING]), [PRECONDITION_UNMET_BINDING]);
        assert.deepStrictEqual(reservedNamesUsed(`// ${PRECONDITION_UNMET_BINDING}(bot)\nasync function f(bot) {}`, [PRECONDITION_UNMET_BINDING]), [], 'comments do not count');
        const v = Object.create(Voyager.prototype);
        Object.assign(v, { skills: [], _lastEffects: [], agent: {} });
        const saved = await v.saveSkill('eatSomething', 'd', `async function eatSomething(bot) {\n    ${PRECONDITION_UNMET_BINDING}(bot);\n    return false;\n}`, 'Eat 1 cooked_mutton', { repair: true });
        assert.strictEqual(saved, false);
        assert.deepStrictEqual(v.skills, []);
    });
    it('staged seeded code reaches it through the sandbox binding and sets the typed marker', async () => {
        const coder = new Coder({ name: NAME, bot: stubBot() });
        while (!coder.code_lint_template || !coder.code_template) await new Promise(r => setImmediate(r));
        const st = await coder._stageCode(`${PRECONDITION_UNMET_BINDING}(bot);`, {});
        const bot = { interrupt_code: false, output: '' };
        await st.func.main(bot);
        assert.deepStrictEqual(peekPreconditionUnmet(bot), { kind: 'precondition' });
    });
});

describe('fix74: reset_bug_poisoned records state every field', () => {
    const idx = { id: 'x', file: 'index', skill: 's', cause: {}, expect: { demoted: true }, set: { demoted: false }, delete: [] };
    const prog = { id: 'y', file: 'progress', path: ['a'], cause: {}, expect: { n: 1 }, delete_path: true };
    it('the reviewed manifest passes', () => { assert.ok(loadManifest(MANIFEST).records.length); });
    for (const k of ['expect', 'set', 'delete']) {
        it(`an index record without ${k} throws (was rec.${k} || ${k === 'delete' ? '[]' : '{}'})`, () => {
            const r = { ...idx }; delete r[k];
            assert.throws(() => checkRecord(r), new RegExp(`index record needs a ${k === 'expect' ? 'non-empty expect' : k}`));
        });
    }
    it('an empty expect, or a record that changes nothing, throws', () => {
        assert.throws(() => checkRecord({ ...idx, expect: {} }), /non-empty expect/);
        assert.throws(() => checkRecord({ ...idx, set: {}, delete: [] }), /changes nothing/);
    });
    it('a progress record needs expect and delete_path: true', () => {
        assert.doesNotThrow(() => checkRecord(prog));
        const noExp = { ...prog }; delete noExp.expect;
        assert.throws(() => checkRecord(noExp), /progress record needs expect/);
        assert.throws(() => checkRecord({ ...prog, delete_path: undefined }), /needs delete_path: true/);
    });
    it('applyManifest checks a manifest passed in directly, before touching any file', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix74-nit-'));
        cpSync(FIX, dir, { recursive: true });
        const m = loadManifest(MANIFEST);
        const bad = { ...m, records: m.records.map((r, i) => { if (i) return r; const c = { ...r }; delete c.expect; return c; }) };
        const before = readFileSync(join(dir, 'skills/index.json'), 'utf8');
        assert.throws(() => applyManifest({ manifest: bad, botsDir: dir, apply: true, log: () => {} }), /needs a non-empty expect/);
        assert.strictEqual(readFileSync(join(dir, 'skills/index.json'), 'utf8'), before);
        rmSync(dir, { recursive: true, force: true });
    });
    it('the script has no || / ?? defaults left', () => {
        assert.doesNotMatch(code('scripts/reset_bug_poisoned.js'), /\|\| \{\}|\|\| \[\]|\?\?/);
    });
});

describe('fix74: other carried nits', () => {
    it('_run reads the action message without a default', () => {
        assert.strictEqual(code('src/agent/voyager.js').includes("r?.message || ''"), false);
    });
    it('no `effects || []` reads remain', () => {
        assert.doesNotMatch(src('src/agent/voyager.js'), /effects \|\| /);
    });
    it('unstuck has no fixed 10 s stop (moveAway is bounded by the learned no-progress check)', () => {
        const all = code('src/agent/modes.js'), m = all.slice(all.indexOf("name: 'unstuck'"), all.indexOf("name: 'night_shelter'"));
        assert.ok(m.includes('moveAway'));
        assert.doesNotMatch(m, /10000/);
        assert.doesNotMatch(m, /stopTimer/);
    });
});
