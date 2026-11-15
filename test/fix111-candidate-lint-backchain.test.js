/**
 * fix111: two root causes behind the craft failures ("Craft 4 oak_planks", craftTorches, ensureChest,
 * "Smelt 5 cobblestone" failing after 4 attempts; "[fix86] LOUD: craftItem routed with no item").
 *
 * 1) The PSN joint repair linted a bundle that contained NEITHER repaired function (its name set filters
 *    both out and _libSrcSubset silently drops overrides for names not in the set), so the repaired code
 *    reached the gate unchecked. Live: the 16:57Z ensureCraftingTable+craftRecipe joint repair stored a
 *    candidate with `if (cond) { }` (ESLint no-empty; the model's comment-only body was stripped before
 *    saving) and that candidate poisoned EVERY replay and codegen bundle that staged it — "lint failed
 *    before run" forever. Now: _libSrcSubset fails loud on overrides that can never land, the joint set
 *    includes both repaired skills, and a lint failure with candidates staged rejects the candidate that
 *    fails lint on its own (fix87 pattern) so the next attempt stages the incumbent.
 * 2) _backchain replayed every plan step as `await name(bot);` — for a parameterised producer (craftItem,
 *    reached via mergedInto) _precheck throws fix86 "routed with no item" and the whole plan died at step
 *    1/1. The plan step knows the item and count; _planStepCall builds the parameterised call through
 *    _structuredReplay, the same builder the top-level router uses.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { ESLint } from 'eslint';

let Voyager, setVersion;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    setVersion = mod._setVersionForTest;
    setVersion('1.20.4');
});

function mk(skills) {
    const v = Object.create(Voyager.prototype);
    v.skills = skills.map(s => JSON.parse(JSON.stringify(s)));
    v.progress = { completedAt: {}, completed: [], failed: [], goalStats: {}, fix25: true, refactors: {} };
    v.npGraph = { consumesOf: () => ({}), getProducersOf: () => [], getRequirementsOf: () => [], recordDelta: () => {} };
    v._saveProgress = () => {};
    v._saveSkills = () => {};
    v._maturity = () => ({ V: 0.5 });
    return v;
}

const zeroArg = {
    name: 'craftThreeSticks', task: 'Craft 3 sticks', deps: [], effects: ['stick'], consumes: {},
    code: 'async function craftThreeSticks(bot) { return true; }', stats: { success: 1, fail: 0, tasks: [] },
    mergedInto: 'craftItem',
};
const parameterised = {
    name: 'craftItem', task: 'Craft N of an item', deps: [], effects: ['stick'], consumes: {},
    code: 'async function craftItem(bot, item, target) { return true; }', stats: { success: 2, fail: 0, tasks: [] },
};

describe('fix111 _libSrcSubset: an override that can never land fails loud', () => {
    it('throws when an override name is not in the staged set (the joint-repair silent drop)', () => {
        const v = mk([{ name: 'a', code: 'async function a(bot) {}' }]);
        assert.throws(
            () => v._libSrcSubset(new Set(), { a: 'async function a(bot) {}' }),
            /fix111.*overrides for a are not in the staged name set/);
    });
    it('renders the override when the name IS in the set', () => {
        const v = mk([{ name: 'a', code: 'async function a(bot) { return 1; }' }]);
        const src = v._libSrcSubset(new Set(['a']), { a: 'async function a(bot) { return 2; }' });
        assert.ok(src.includes('return 2;') && !src.includes('return 1;'));
    });
});

describe('fix111 _planStepCall: parameterised producers get their arguments', () => {
    it('a zero-argument producer keeps the bare call', () => {
        const v = mk([zeroArg]);
        assert.strictEqual(v._planStepCall({ name: 'craftThreeSticks', item: 'stick', need: 3 }), 'await craftThreeSticks(bot);');
    });
    it('craftItem as producer is called with the step item and count', () => {
        const v = mk([zeroArg, parameterised]);
        const call = v._planStepCall({ name: 'craftItem', item: 'stick', need: 4 });
        assert.strictEqual(call, 'await craftItem(bot, "stick", 4);');
    });
    it('a producer whose arguments cannot be derived is refused, not called bare', () => {
        const odd = { ...parameterised, name: 'craftWidget', task: 'Widgeteer 1 widget', code: 'async function craftWidget(bot, item, target) { return true; }' };
        const v = mk([odd]);
        assert.strictEqual(v._planStepCall({ name: 'craftWidget', item: 'widget', need: 1 }), null);
    });
    it('an unknown producer name throws', () => {
        const v = mk([zeroArg]);
        assert.throws(() => v._planStepCall({ name: 'nope', item: 'stick', need: 1 }), /fix111.*unknown skill nope/);
    });
});

describe('fix111 _backchain: the craftItem plan runs with a parameterised call', () => {
    it('routes "Craft 4 stick" through craftItem(bot, "stick", N), never craftItem(bot)', async () => {
        const v = mk([zeroArg, parameterised]);
        const calls = [];
        v._boltzmann = c => c[0];
        v.observe = () => ({ inventory: { stick: 3 } });
        v._replay = async (task, before, route) => { calls.push(route.call); return { ok: true, name: route.name, output: '' }; };
        const res = await v._backchain('Craft 4 stick', { inventory: { stick: 3 } });
        assert.ok(res && res.ok);
        assert.ok(calls.length >= 1, 'the plan must replay at least one step');
        for (const c of calls) {
            if (c.includes('craftItem')) assert.match(c, /craftItem\(bot, "stick", \d+\)/, `step call ${c} must pass the item and a count`);
        }
    });
    it('a parameterised producer with no derivable call abandons the plan (loud), it is not run bare', async () => {
        const odd = { ...parameterised, task: 'Widgeteer stick', effects: ['stick'] };
        const via = { ...zeroArg, name: 'craftStickVariant', task: 'Craft 1 stick variant', mergedInto: 'craftItem' };
        const v = mk([odd, via]);
        v._boltzmann = c => c[0];
        v.observe = () => ({ inventory: {} });
        const calls = [];
        v._replay = async (task, before, route) => { calls.push(route.call); return { ok: true, name: route.name, output: '' }; };
        const res = await v._backchain('Craft 1 stick', { inventory: {} });
        assert.deepStrictEqual(res, { ok: false });
        assert.deepStrictEqual(calls, [], 'no step may replay a parameterised producer without arguments');
    });
});

describe('fix111 _rejectLintPoisonedCandidates: a candidate that cannot lint is rejected', () => {
    const eslint = new ESLint({ overrideConfigFile: 'eslint.config.js' });
    function mkLinty(skills) {
        const v = mk(skills);
        const noted = [], rolled = [];
        v._noteProposal = (e, p) => noted.push({ name: e.name, outcome: p.outcome, task: p.task });
        v._rollbackRefactor = (id, by) => rolled.push({ id, by });
        v._stageLintExec = async (src) => {
            // mimic the real staging: the trailing call runs inside an async scope (SES wrapper); lint the function bodies
            const body = src.replace(/\n*await Promise\.resolve\(\);\s*$/, '\n');
            const r = await eslint.lintText(body, { filePath: 'bundle.js' });
            const msgs = r[0].messages.filter(m => m.fatal || m.ruleId === 'no-empty');
            return { lint: msgs.length ? msgs.map(m => `Message: ${m.message}.`).join('\n') : null, staged: null };
        };
        return { v, noted, rolled };
    }
    it('rejects the candidate that fails lint on its own and keeps the clean one', async () => {
        const { v, noted, rolled } = mkLinty([
            { name: 'poisoned', code: 'async function poisoned(bot) { return 1; }', deps: [], effects: [], stats: { success: 1, fail: 0, tasks: [] },
              candidate: { code: 'async function poisoned(bot) { if (bot) {\n} return 2; }', task: 'repair: x', refactor: 'jr1' } },
            { name: 'clean', code: 'async function clean(bot) { return 1; }', deps: [], effects: [], stats: { success: 1, fail: 0, tasks: [] },
              candidate: { code: 'async function clean(bot) { return 2; }', task: 'repair: y' } },
        ]);
        const closure = new Set(['poisoned', 'clean']);
        const over = { poisoned: v.skills[0].candidate.code, clean: v.skills[1].candidate.code };
        const rejected = await v._rejectLintPoisonedCandidates(closure, over, 'test');
        assert.deepStrictEqual(rejected, ['poisoned']);
        assert.strictEqual(v.skills[0].candidate, undefined, 'the poisoned candidate must not be kept');
        assert.ok(v.skills[1].candidate, 'a clean candidate must survive');
        assert.deepStrictEqual(noted, [{ name: 'poisoned', outcome: 'rejected: fails lint', task: 'repair: x' }]);
        assert.deepStrictEqual(rolled, [{ id: 'jr1', by: 'poisoned candidate fails lint' }]);
    });
    it('rejects nothing when no candidate fails lint on its own (the failure is a real bundle/model problem)', async () => {
        const { v, noted } = mkLinty([
            { name: 'clean', code: 'async function clean(bot) { return 1; }', deps: [], effects: [], stats: { success: 1, fail: 0, tasks: [] },
              candidate: { code: 'async function clean(bot) { return 2; }', task: 'repair: y' } },
        ]);
        const over = { clean: v.skills[0].candidate.code };
        const rejected = await v._rejectLintPoisonedCandidates(new Set(['clean']), over, 'test');
        assert.deepStrictEqual(rejected, []);
        assert.deepStrictEqual(noted, []);
        assert.ok(v.skills[0].candidate);
    });
});

describe('fix111 joint repair lints the repaired functions', () => {
    it('the joint linted set contains both repaired skills (live: it contained neither)', () => {
        const v = mk([
            { name: 'child', code: 'async function child(bot) { return true; }', deps: [], effects: [], stats: { success: 1, fail: 0, tasks: [] } },
            { name: 'caller', code: 'async function caller(bot) { await child(bot); return true; }', deps: ['child'], effects: [], stats: { success: 1, fail: 0, tasks: [] } },
        ]);
        // the invariant that made the silent drop possible: overrides must be members of the set (fix111 throws otherwise)
        assert.doesNotThrow(() => v._libSrcSubset(new Set(['child', 'caller']), { child: 'async function child(bot) { return 1; }', caller: 'async function caller(bot) { return 2; }' }));
        assert.throws(() => v._libSrcSubset(new Set(['caller']), { child: 'async function child(bot) { return 1; }', caller: 'async function caller(bot) { return 2; }' }), /fix111/);
    });
});
