/**
 * fix83 (live 11-06 18:56-19:10 GMT, 6cc26e8): the wood chain stalled before the underground problem.
 *  1. a need's count is a shortfall; the subgoal's pre-run check read it as absolute ("Collect 1 oak_planks": already have 1/1)
 *  2. "No <block> nearby" ended the chain with no structured need; it is now a reach need (same marker as chest proximity)
 *  3. learned contracts enumerated names (collectLogs refused oak_log x36); contracts read c.game, lists are refused
 *  4. craftSticks(NaN): `2 - getInventoryCounts(bot).stick` with no sticks; lint + contract feedback name it
 *  5. "Identifier 'craftSticks' has already been declared": the reply pasted the library craftSticks beside its own; the
 *     module parse failed before fix82's one-function rule could run
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as acorn from 'acorn';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsesAsScript, splitGeneratedCode, pastedLibrarySkills, oneFunctionFeedback, instrumentSrc } from '../src/agent/skill_graph.js';
import { missingCountArithmetic } from '../src/agent/coder.js';
import { loadManifest, applyManifest } from '../scripts/reset_bug_poisoned.js';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(registry);

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
});

// live replay inventory 19:01-19:06 GMT (f83 extract; mindcraft.log 1119 context line): one oak_planks, no logs, no sticks
const LIVE_INV = { iron_helmet: 7, cobblestone: 410, cooked_mutton: 46, coal: 1, iron_ingot: 56, oak_planks: 1, shears: 1, torch: 79,
    wooden_axe: 1, iron_sword: 1, stone_sword: 1, stone_axe: 1, cobbled_deepslate: 66, gravel: 5, granite: 34, andesite: 22,
    raw_iron: 114, diorite: 64, dirt: 3, raw_copper: 31, stone_shovel: 1, furnace: 1 };
const has = (inv, k) => (Object.hasOwn(inv, k) ? inv[k] : 0);

// the test world: Collect works only on a block that is within reach, and otherwise reports what the seeded collectBlock now
// reports (a reach need); "reach X" is code the model writes (exploring), which here makes X observed and reachable
function applyTask(task, inv, nearby, reachable) {
    const r = task.match(/^reach ([a-z_]+)$/);
    if (r) { reachable.add(r[1]); nearby.push(r[1]); return { ok: true }; }
    const [verb, n, item] = task.split(' ');
    const count = Number(n);
    if (verb === 'Collect') {
        if (!reachable.has(item)) return { ok: false, reported: { kind: 'precondition', need: { item, count, reason: 'reach' } } };
        inv[item] = has(inv, item) + count;
        return { ok: true };
    }
    if (verb === 'Craft') {
        const name = item === 'sticks' ? 'stick' : item;
        for (const rc of Recipe.find(registry.itemsByName[name].id)) {
            const times = Math.ceil(count / rc.result.count);
            const ings = rc.delta.filter(d => d.count < 0);
            if (!ings.every(d => has(inv, registry.items[d.id].name) >= -d.count * times)) continue;
            for (const d of ings) inv[registry.items[d.id].name] -= -d.count * times;
            inv[name] = has(inv, name) + times * rc.result.count;
            return { ok: true };
        }
        return { ok: false, reported: { kind: 'precondition', need: { item: name, count, reason: 'ingredients' } } };
    }
    throw new Error(`test world: unknown task ${task}`);
}
function mkV({ inv, nearby, reachable }) {
    const v = Object.create(Voyager.prototype);
    v.agent = { bot: { version: VER, registry, recipesAll: (id) => Recipe.find(id), inventory: { emptySlotCount: () => 0 } }, openChat() {} };
    v.skills = [];
    v.npGraph = null;
    v.progress = { subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], recipeEdges: {}, goalStats: {} };
    v._saveProgress = () => {};
    v._windowCheck = () => {};
    v._afterSuccess = () => {};
    v._prefetchPlan = () => {};
    v._curSub = null;
    v.ran = [];
    v.observe = () => ({ inventory: { ...inv }, nearby_blocks: [...nearby], empty_inventory_slots: 0, is_day: true });
    v._findReplay = task => ({ name: `route_${task.replace(/ /g, '_')}`, call: '' });
    v._structuredReplay = v._findReplay;
    v._embedReplay = async () => null;
    v._backchain = async () => null;
    v._replay = async (task) => {
        v.ran.push(task);
        const res = applyTask(task, inv, nearby, reachable);
        if (res.ok) return { ok: true, name: 'r' };
        return { ok: false, name: 'r', reason: 'test world: cannot', needs: v._failureNeeds(task, res.reported, null, v.observe()) };
    };
    v._cursorLimited = () => true;
    return v;
}
async function drive(v, task) {
    await v._pursueProposedTask(task, { task }, v.observe());
    let guard = 0;
    while (v.progress.subgoals.length) {
        if (++guard > 50) throw new Error('test: queue did not drain');
        v._curSub = null;
        const sub = v._subgoalTask();
        await v._pursueProposedTask(sub.task, sub, v.observe());
    }
}
const quiet = async f => { const o = console.log; console.log = () => {}; try { return await f(); } finally { console.log = o; } };

describe('fix83 (1): a need subgoal is satisfied by what its parent needs HELD, not by the delta its task names', () => {
    it('live "Craft 3 sticks" with 1 oak_planks: "Collect 1 oak_planks" runs (was "already have 1/1"), then the parent passes', async () => {
        const inv = { ...LIVE_INV };
        const v = mkV({ inv, nearby: ['oak_planks'], reachable: new Set(['oak_planks']) });
        await quiet(() => drive(v, 'Craft 3 sticks'));
        assert.deepStrictEqual(v.ran, ['Craft 3 sticks', 'Collect 1 oak_planks', 'Craft 3 sticks']);
        assert.deepStrictEqual(v.progress.decomposed['Craft 3 sticks'].subs, ['Collect 1 oak_planks']);
        assert.ok(has(inv, 'stick') >= 3);
        assert.ok(v.progress.completed.includes('Craft 3 sticks'));
        assert.deepStrictEqual(v.progress.failed, []);
        assert.strictEqual(v.progress.recipeEdges.oak_planks.status, 'proven', 'the game-data edge ran (live: runs 0)');
    });
    it('the queued entry carries the absolute target; the pre-run check uses it; the blocker needs the same', async () => {
        const inv = { ...LIVE_INV };
        const v = mkV({ inv, nearby: ['oak_planks'], reachable: new Set(['oak_planks']) });
        await quiet(() => v._pursueProposedTask('Craft 3 sticks', { task: 'Craft 3 sticks' }, v.observe()));
        const [sub] = v.progress.subgoals;
        assert.strictEqual(sub.task, 'Collect 1 oak_planks');
        assert.deepStrictEqual(sub.atLeast, { item: 'oak_planks', count: 2 });
        assert.deepStrictEqual(v.progress.blockers.map(({ at, ...b }) => b), [{ item: 'oak_planks', count: 2, reason: 'ingredients', task: 'Craft 3 sticks' }]);
        v._curSub = sub;
        const r = v._goalAlreadySatisfied(sub.task, v.observe());
        assert.strictEqual(r.satisfied, false, r.reason);
        assert.match(r.reason, /hold 1 oak_planks; "Craft 3 sticks" needs 2/);
        v._curSub = null;
        assert.strictEqual(v._goalAlreadySatisfied(sub.task, v.observe()).satisfied, true, 'a free task "Collect 1 oak_planks" is still the absolute count');
    });
    it('a target for another item than the goal names fails loudly', () => {
        const v = mkV({ inv: { ...LIVE_INV }, nearby: [], reachable: new Set() });
        v._curSub = { task: 'Collect 1 oak_planks', parent: 'p', atLeast: { item: 'stick', count: 2 } };
        assert.throws(() => v._goalAlreadySatisfied('Collect 1 oak_planks', v.observe()), /targets stick but its goal is oak_planks/);
    });
});

describe('fix83 (2): "No <block> nearby" is a structured reach need, chained like the chest-proximity need', () => {
    it('live "Collect 2 oak_planks" with none within reach -> reach oak_planks -> collect -> the goal passes', async () => {
        const inv = { ...LIVE_INV };
        const v = mkV({ inv, nearby: [], reachable: new Set() });
        await quiet(() => drive(v, 'Collect 2 oak_planks'));
        assert.deepStrictEqual(v.ran, ['Collect 2 oak_planks', 'reach oak_planks', 'Collect 2 oak_planks']);
        assert.strictEqual(v.progress.decomposed['Collect 2 oak_planks'].reason, 'needs: 2 oak_planks (reach, reported)');
        assert.ok(v.progress.completed.includes('reach oak_planks'));
        assert.ok(v.progress.completed.includes('Collect 2 oak_planks'));
    });
    it('a reach goal is its own kind: verified by observation, keyed apart from placing, and gives no game-data need', () => {
        const v = mkV({ inv: {}, nearby: ['oak_log'], reachable: new Set() });
        const g = v._resolveGoal('reach oak_log');
        assert.strictEqual(g.kind, 'reach');
        assert.strictEqual(v._goalKey(g), 'reach oak_log');
        assert.strictEqual(v._needKey({ item: 'oak_log', count: 1, reason: 'reach' }), 'reach oak_log');
        assert.notStrictEqual(v._goalKey(g), v._goalKey(v._resolveGoal('ensure oak_log')));
        assert.strictEqual(v._goalAlreadySatisfied('reach oak_log', v.observe()).satisfied, true);
        assert.strictEqual(v._goalAlreadySatisfied('reach birch_log', v.observe()).satisfied, false);
        assert.strictEqual(v._failureNeeds('reach birch_log', null, null, v.observe()), null, 'the model writes the search');
        assert.strictEqual(v._resolveGoal('reach not_a_block').kind, 'open');
    });
    it('the seeded collectBlock marks the reach need with the block types it searched (no list, no distance of its own)', () => {
        const src = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'collectBlock').code;
        assert.match(src, /const sources = types\.filter\(t => Object\.hasOwn\(bot\.registry\.blocksByName, t\)\);/);
        assert.match(src, /__mcPreconditionUnmet__\(bot, \{ need: sources\.length === 1 \? \{ item: sources\[0\], count: num - collected, reason: 'reach' \} : \{ anyOf: sources, count: num - collected, reason: 'reach' \} \}\);/);
        assert.doesNotThrow(() => acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }));
    });
});

describe('fix83 (3): contracts derive valid values from game data; an enumerated list of names is refused', () => {
    const LIVE = JSON.parse(readFileSync(new URL('../scripts/fix83_contract_allowlist_manifest.json', import.meta.url), 'utf8'));
    const live = name => LIVE.records.find(r => r.skill === name).expect.contract;
    it('the live collectLogs pre refuses oak_log (and mangrove_log, cherry_log): every log type the list left out', () => {
        const v = mkV({ inv: {}, nearby: [], reachable: new Set() });
        const pre = v._compileContract(live('collectLogs').pre);
        const c = a => v._contractCtx({ args: a, ret: 0, pre: {}, post: {}, delta: {} });
        assert.strictEqual(pre(c([2, 'birch_log'])), true);
        for (const t of ['oak_log', 'mangrove_log', 'cherry_log']) assert.strictEqual(pre(c([2, t])), false, t);
        assert.match(v._validContract(live('collectLogs')), /pre enumerates names \['birch_log', 'acacia_log', 'spruce_log', 'jungle_log', 'dark_oak_log', 'crimson_stem', 'warped_stem'\]; derive membership from c\.game/);
    });
    it('a contract over c.game holds for every block the game has, and only for those', () => {
        const v = mkV({ inv: {}, nearby: [], reachable: new Set() });
        const ct = { pre: "c => c.args.length === 2 && Number.isInteger(c.args[0]) && c.game.block(c.args[1])", post: 'c => c.ret === false || c.ret <= c.args[0]' };
        assert.strictEqual(v._validContract(ct), null);
        const pre = v._compileContract(ct.pre);
        for (const t of ['oak_log', 'mangrove_log', 'cherry_log', 'birch_log', 'warped_stem']) assert.strictEqual(pre(v._contractCtx({ args: [2, t], pre: {}, post: {}, delta: {} })), true, t);
        assert.strictEqual(pre(v._contractCtx({ args: [2, 'flowers'], pre: {}, post: {}, delta: {} })), false, '"flowers" is not a block');
        const g = v._contractGame();
        assert.deepStrictEqual(g.drops('oak_log'), ['oak_log']);
        assert.strictEqual(g.item('stick'), true);
        assert.strictEqual(g.block('stick'), false);
    });
    it('every list-holding live contract is refused; the spec tells the model why', () => {
        const v = mkV({ inv: {}, nearby: [], reachable: new Set() });
        for (const r of LIVE.records) assert.match(v._validContract(r.expect.contract), /enumerates names/, r.skill);
        assert.match(Voyager.CONTRACT_SPEC, /NEVER enumerate item, block or kind names in a list/);
        assert.match(Voyager.CONTRACT_SPEC, /c\.game\.item\(name\) \/ c\.game\.block\(name\)/);
    });
    it('the reset manifest is valid, and dry-run / apply reset exactly those contracts (refusing a stale record)', () => {
        const m = loadManifest(new URL('../scripts/fix83_contract_allowlist_manifest.json', import.meta.url).pathname);
        assert.strictEqual(m.records.length, 11);
        assert.ok(m.records.every(r => r.delete.includes('contract') && r.delete.includes('contractTried') && !Object.keys(r.set).length));
        const dir = mkdtempSync(join(tmpdir(), 'fix83-')); mkdirSync(join(dir, 'skills'));
        try {
            const index = m.records.map(r => ({ name: r.skill, code: `async function ${r.skill}(bot) {}`, contract: r.expect.contract, contractTried: 1 }));
            index.push({ name: 'obtainItem', code: 'async function obtainItem(bot) {}', contract: { pre: 'c => true', post: 'c => true' } });
            writeFileSync(join(dir, 'skills/index.json'), JSON.stringify(index));
            writeFileSync(join(dir, 'skills/progress.json'), '{}');
            const logs = [];
            const dry = applyManifest({ manifest: m, botsDir: dir, apply: false, log: s => logs.push(s) });
            assert.strictEqual(dry.dryRun, true);
            assert.strictEqual(dry.changes.filter(c => c.op === 'delete').length, 22);
            assert.strictEqual(JSON.parse(readFileSync(join(dir, 'skills/index.json'), 'utf8'))[0].contract.pre, m.records[0].expect.contract.pre, 'dry-run writes nothing');
            applyManifest({ manifest: m, botsDir: dir, apply: true, log: () => {} });
            const after = JSON.parse(readFileSync(join(dir, 'skills/index.json'), 'utf8'));
            assert.ok(after.filter(s => s.name !== 'obtainItem').every(s => !Object.hasOwn(s, 'contract') && !Object.hasOwn(s, 'contractTried')));
            assert.ok(Object.hasOwn(after.find(s => s.name === 'obtainItem'), 'contract'));
            assert.throws(() => applyManifest({ manifest: m, botsDir: dir, apply: false, log: () => {} }), /expect mismatch/);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('fix83 (4): craftSticks(NaN) at 19:03:57 GMT is lint and contract feedback, not a rewrite', () => {
    // the generated ensureSticks of 19:03:50 GMT (action-code 7.js, without the staging guards)
    const ENSURE_STICKS = `async function ensureSticks(bot) {
    if (bot.interrupt_code) return;
    const currentSticks = getInventoryCounts(bot).stick;
    if (currentSticks >= 2) return true;

    const neededSticks = 2 - currentSticks;
    const crafted = await craftSticks(bot, neededSticks);
    if (bot.interrupt_code) return;
    if (!crafted) return false;

    const finalSticks = getInventoryCounts(bot).stick;
    return finalSticks >= 2;
}

// Call the function to ensure at least 2 sticks
await ensureSticks(bot);`;
    it('the lint names the arithmetic on a count getInventoryCounts does not list', () => {
        const out = missingCountArithmetic(ENSURE_STICKS);
        assert.strictEqual(out.length, 1);
        assert.match(out[0], /^`2 - currentSticks`: currentSticks \(= getInventoryCounts\(bot\)\.stick\) is undefined when the bot holds none/);
        assert.deepStrictEqual(missingCountArithmetic('const s = getInventoryCounts(bot).stick || 0; const t = s + 3; if (getInventoryCounts(bot).stick >= 2) {}'), [], 'a checked read and a comparison are fine');
        assert.strictEqual(missingCountArithmetic('const c = getInventoryCounts(bot); const p = c.oak_log * 4;').length, 1, 'through a variable holding the counts');
    });
    it('the coder gate blocks it before it runs', () => {
        const coder = { _parseError: () => null, _forbiddenTimerLint: () => [], _apiGate: () => null };
        return import('../src/agent/coder.js').then(m => {
            const proto = m.Coder.prototype;
            const lint = proto.userGeneratedCodeLintBlockers.call(coder, ENSURE_STICKS, []);
            assert.match(lint, /2 - currentSticks/);
        });
    });
    it('the violated contract says what it was given: NaN, not the trace\'s JSON null', () => {
        const facts = Voyager.contractCallFacts('craftSticks', [NaN], 'pre', "c => (c.args.length === 0 || (c.args.length === 1 && Number.isFinite(Number(c.args[0])) && Number(c.args[0]) >= 0)) && c.pre.alive");
        assert.match(facts, /^craftSticks\(NaN\) does not satisfy its precondition c => /);
        assert.match(facts, /argument 1 is NaN \(a number computed from a missing value/);
        assert.strictEqual(Voyager.contractCallFacts('collectLogs', [2, 'oak_log'], 'pre', 'c => x'), 'collectLogs(2, "oak_log") does not satisfy its precondition c => x');
        const inst = instrumentSrc(['craftSticks']);
        assert.match(inst, /args: __argText\(a\.slice\(1\)\)/);
        // fix96: __argText renders through __valText (a game object as name@x,y,z); the three lines define it
        const argText = new Function(`${inst.match(/const __gameObj = [^\n]+/)[0]}\n${inst.match(/const __valText = [\s\S]+?\n};/)[0]}\n${inst.match(/const __argText = [^\n]+/)[0]}; return __argText;`)();
        assert.strictEqual(argText([NaN, undefined, 'oak_log', null, 2]), '[NaN,undefined,"oak_log",null,2]');
    });
});

describe('fix83 (5): "Identifier \'craftSticks\' has already been declared" (19:07:36 GMT) is the one-function feedback', () => {
    // library craftSticks (live index) pasted, then the reply's own craftSticks for the task "craftSticks: Craft sticks ..."
    const LIB = `// DESCRIPTION: Craft sticks (making planks from logs if needed) until the inventory has target sticks; returns true on success.
async function craftSticks(bot, target = 4) {
    const have = () => getInventoryCounts(bot).stick || 0;
    for (let i = 0; i < 8 && have() < target; i++) {
        if (bot.interrupt_code) return false;
        await craftPlanks(bot, 2);
        if (!(await craftRecipe(bot, 'stick', 1))) return false;
    }
    return have() >= target;
}`;
    const REPLY = `${LIB}

// DESCRIPTION: Craft sticks from oak_planks until inventory has at least 3 sticks.
async function craftSticks(bot) {
    if (bot.interrupt_code) return false;
    return await craftThreeSticks(bot);
}
await craftSticks(bot);`;
    it('as a module the reply does not parse (the live error), so fix82\'s rule never saw it', () => {
        assert.throws(() => acorn.parse(REPLY, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }), /Identifier 'craftSticks' has already been declared/);
    });
    it('read as a script its shape is named, with the pasted library skill', () => {
        assert.strictEqual(parsesAsScript(REPLY), true);
        const own = REPLY.match(/async\s+function\s+([A-Za-z_]\w*)\s*\(/)[1];
        const { violations } = splitGeneratedCode(REPLY, own);
        assert.deepStrictEqual(violations, ['2 top-level declarations of function craftSticks (exactly 1 required)']);
        const pasted = pastedLibrarySkills(REPLY, own, new Set(['craftSticks', 'craftThreeSticks', 'craftPlanks']));
        assert.deepStrictEqual(pasted, ['craftSticks']);
        assert.match(oneFunctionFeedback(own, violations, pasted), /craftSticks is a learned skill already defined for your code: call it by name, do not paste its source\./);
        assert.deepStrictEqual(pastedLibrarySkills(`${LIB}\n\nasync function makeSticks(bot) { return craftSticks(bot, 3); }`, 'makeSticks', new Set(['craftSticks'])), ['craftSticks'], 'a pasted skill beside a new one');
        assert.deepStrictEqual(pastedLibrarySkills(LIB, 'craftSticks', new Set(['craftSticks'])), [], 'one new version of a library skill is not a paste');
        const bad = parsesAsScript('async function f(bot) {');
        assert.strictEqual(typeof bad, 'string');
        assert.match(bad, /Unexpected token/);
    });
    it('writeCode and the repair loop read the shape before the lint\'s module parse; the prompt says not to paste', () => {
        const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        assert.match(src, /const scriptParse = parsesAsScript\(code\);\n\s*const split = scriptParse === true \? splitGeneratedCode\(code, own\) : null;\n\s*let lint = scriptParse !== true \? `does not parse as a script: \$\{scriptParse\}` : \(split\.violations\.length \? oneFunctionFeedback\(own, split\.violations, pastedLibrarySkills\(code, own, libraryNames\)\) : null\);\n\s*if \(lint === null\) lint = this\.agent\.coder\.userGeneratedCodeLintBlockers/);
        assert.match(src, /const split = scriptParse === true \? splitGeneratedCode\(code, e\.name\) : null;/);
        assert.match(src, /--- learned skills you can call \(already defined for your code: call them by name, never paste their source\) ---/);
    });
});
