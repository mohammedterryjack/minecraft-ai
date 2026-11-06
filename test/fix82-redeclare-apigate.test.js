/**
 * fix82: two live failures on 8ad07ff (iMac logs/mindcraft.log, 2026-11-06).
 *
 * 1. 18:23:44Z writeCode "Verify the inventory contains the iron_pickaxe ...": "collectBareApiUsedInSource: parse failed
 *    (at offset 4584): Identifier 'checkIronPickaxe' has already been declared (65:15)". Not the lint prelude (#53/#54 fixed
 *    that) and not fix70's dedupe by skill NAME: the library skill checkForIronPickaxe (NEW 17:50:41Z) was saved with a SECOND
 *    top-level function, checkIronPickaxe (the writeCode reply's helper + main + call, saved whole under the first function's
 *    name). Staged next to a reply that declares its own checkIronPickaxe, the bundle cannot parse. The same save path kept
 *    `await tossClutterForIron(bot, 4);` in that skill (its regex only cut calls without arguments).
 * 2. 18:28:22Z-18:29Z craftItem threw "Cannot read properties of undefined (reading 'find')" at the table (-125,43,61), in
 *    obtainItem and craftIronPickaxe: the code model's craftItem REPAIR (18:27:59Z, HELD as a candidate) reads
 *    `bot.recipes.find(...)`; mineflayer's Bot has recipesFor/recipesAll and no `recipes`. writeCode's static API gate
 *    (fix32/fix60 bot-member check) catches that, but repairs were only ESLint-staged, and saveSkill did not gate it either.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Coder, collectBareApiUsedInSource } from '../src/agent/coder.js';
import { Voyager } from '../src/agent/voyager.js';
import { instrumentSrc, declaredNames, skillSourceViolations, splitGeneratedCode, oneFunctionFeedback, topLevelStatements } from '../src/agent/skill_graph.js';
import { loadManifest, applyManifest } from '../scripts/reset_bug_poisoned.js';

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/fix82-live.json', import.meta.url), 'utf8'));
const MANIFEST = new URL('../scripts/fix82_one_function_manifest.json', import.meta.url).pathname;
const NAME = '__fix82_test__';
after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));
const parse = src => import('acorn').then(a => a.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }));
// the shape of the 18:23:44Z reply (340 chars, not logged since the step threw): it declares its own checkIronPickaxe,
// the name it saw in checkForIronPickaxe's source in the prompt ("3 with source"), and calls the library skill
const REPLY_1823 = `// DESCRIPTION: Verify the inventory contains the iron_pickaxe
async function checkIronPickaxe(bot) {
    const ok = await checkForIronPickaxe(bot);
    log(bot, ok ? 'iron_pickaxe is in the inventory' : 'FAILED: no iron_pickaxe in the inventory');
    return ok;
}
await checkIronPickaxe(bot);`;
// the shape of the 17:50Z reply that produced the library entry: helper first, main second, call of main
const REPLY_1750 = LIVE.checkForIronPickaxe.code + '\nawait checkIronPickaxe(bot);';
// a live-shaped bot: the members the library and the logs use; no `recipes` (mineflayer 4.x has none)
const liveBot = () => {
    const proto = { recipesFor() { return []; }, recipesAll() { return []; }, craft() {}, equip() {}, dig() {}, lookAt() {}, blockAt() { return null; }, findBlock() { return null; }, nearestEntity() { return null; }, chat() {}, toss() {}, tossStack() {}, activateBlock() {}, closeWindow() {}, on() {}, off() {} };
    return Object.assign(Object.create(proto), { registry: { itemsByName: { iron_pickaxe: {}, stick: {}, iron_ingot: {}, crafting_table: {} }, blocksByName: { crafting_table: {} }, entitiesByName: {} }, inventory: { items: () => [] }, entity: {}, interrupt_code: false, currentWindow: null, heldItem: null, health: 20, food: 20 });
};

describe('fix82 (1): the 18:23:44Z "checkIronPickaxe has already been declared"', () => {
    it('reproduces: the library source declares checkIronPickaxe, fix70 stages it (the reply calls checkForIronPickaxe), the bundle does not parse', () => {
        const own = 'checkIronPickaxe';
        assert.ok(!declaredNames(REPLY_1823).has('checkForIronPickaxe'), 'fix70 drops only library skills whose NAME the reply declares');
        const execBundle = LIVE.checkForIronPickaxe.code + '\n\n' + instrumentSrc(['checkForIronPickaxe', own]) + '\n\n' + REPLY_1823;
        assert.throws(() => collectBareApiUsedInSource(execBundle), /collectBareApiUsedInSource: parse failed .*Identifier 'checkIronPickaxe' has already been declared/);
    });
    it('the cause is the library entry: two top-level functions under one skill name', () => {
        assert.deepStrictEqual(skillSourceViolations(LIVE.checkForIronPickaxe.code, 'checkForIronPickaxe'), ['top-level function checkIronPickaxe besides checkForIronPickaxe']);
        assert.deepStrictEqual(skillSourceViolations(LIVE.tossClutterForIron.code, 'tossClutterForIron'), ['top-level call tossClutterForIron(...) (runs whenever the skill is staged)']);
    });
    it('the 17:50Z reply shape is now lint feedback before it runs (own = the first function, as writeCode picks it)', () => {
        const own = REPLY_1750.match(/async\s+function\s+([A-Za-z_]\w*)\s*\(/)[1];
        assert.strictEqual(own, 'checkForIronPickaxe');
        const { violations } = splitGeneratedCode(REPLY_1750, own);
        assert.deepStrictEqual(violations, ['top-level function checkIronPickaxe besides checkForIronPickaxe', 'top-level call checkIronPickaxe(...) (runs whenever the skill is staged)']);
        assert.match(oneFunctionFeedback(own, violations), /ONE top-level function: `async function checkForIronPickaxe\(bot, \.\.\.\)`.*INSIDE checkForIronPickaxe/);
    });
    it('the call is cut by AST position, arguments or not (the old regex kept `await tossClutterForIron(bot, 4);`)', () => {
        const old = c => c.replace(/\n\s*await\s+\w+\(bot\);\s*$/, '').trim();
        assert.match(old(LIVE.tossClutterForIron.code), /await tossClutterForIron\(bot, 4\);$/);
        const { skillSource, violations } = splitGeneratedCode(LIVE.tossClutterForIron.code, 'tossClutterForIron');
        assert.deepStrictEqual(violations, []);
        assert.doesNotMatch(skillSource, /await tossClutterForIron\(/);
        assert.strictEqual(splitGeneratedCode(REPLY_1823, 'checkIronPickaxe').skillSource, REPLY_1823.replace(/\nawait checkIronPickaxe\(bot\);$/, ''));
        // a call of something else is not the skill's call: it stays and is reported
        assert.deepStrictEqual(splitGeneratedCode('async function a(bot) {}\nawait b(bot);', 'a').violations, ['top-level call b(...) (runs whenever the skill is staged)']);
    });
    it('every top-level binding form is reported; nested helpers are fine', () => {
        assert.deepStrictEqual(skillSourceViolations('const LIMIT = 3, { x, y: [z] } = o;\nasync function f(bot) {}', 'f'), ['top-level variable LIMIT, x, z besides f']);
        assert.deepStrictEqual(skillSourceViolations('class K {}\nasync function f(bot) {}', 'f'), ['top-level class K besides f']);
        assert.throws(() => skillSourceViolations('async function f(bot) {}\nasync function f(bot) {}', 'f'), /Identifier 'f' has already been declared/);   // a module cannot hold two
        assert.deepStrictEqual(skillSourceViolations('async function g(bot) {}', 'f'), ['top-level function g besides f', '0 top-level declarations of function f (exactly 1 required)']);
        assert.deepStrictEqual(skillSourceViolations('// c\nasync function f(bot) {\n    const h = () => 1;\n    function inner() { return h(); }\n    return inner();\n}', 'f'), []);
        assert.throws(() => skillSourceViolations('async function f(bot) {', 'f'), /topLevelStatements: parse failed/);
        assert.throws(() => skillSourceViolations('async function f(bot) {}', ''), /skill name required/);
    });
    it('with the library entry reset (manifest), the same reply and closure parse', async () => {
        const m = loadManifest(MANIFEST);
        const fixed = m.records.find(r => r.skill === 'checkForIronPickaxe').set.code;
        assert.deepStrictEqual(skillSourceViolations(fixed, 'checkForIronPickaxe'), []);
        const execBundle = fixed + '\n\n' + instrumentSrc(['checkForIronPickaxe', 'checkIronPickaxe']) + '\n\n' + REPLY_1823;
        assert.doesNotThrow(() => collectBareApiUsedInSource(execBundle));
        await parse(execBundle);
    });
    it('saveSkill rejects a multi-function source (every path into the library: writeCode, repair, joint, refactor)', async () => {
        const v = Object.create(Voyager.prototype);
        Object.assign(v, { skills: [], _lastEffects: [], agent: { coder: new Coder({ name: NAME, bot: liveBot() }) } });
        assert.strictEqual(await v.saveSkill('checkForIronPickaxe', 'd', LIVE.checkForIronPickaxe.code, 'Check for an iron pickaxe'), false);
        assert.deepStrictEqual(v.skills, []);
    });
    it('a library holding such a source fails loud at load, naming each entry', () => {
        const v = Object.create(Voyager.prototype);
        v.skills = [
            { name: 'checkForIronPickaxe', code: LIVE.checkForIronPickaxe.code },
            { name: 'tossClutterForIron', code: LIVE.tossClutterForIron.code },
            { name: 'craftItem', code: LIVE.craftItemIncumbent.code, candidate: { code: LIVE.craftItemCandidate.code } },
        ];
        assert.throws(() => v._assertOneFunctionSources(), e => /\[fix82\] FATAL: 2 library source\(s\)/.test(e.message) && /checkForIronPickaxe\.code: top-level function checkIronPickaxe/.test(e.message) && /tossClutterForIron\.code: top-level call tossClutterForIron/.test(e.message) && !/craftItem/.test(e.message));
        v.skills = [{ name: 'x', code: 'async function x(bot) {}', candidate: { code: 7 } }];
        assert.throws(() => v._assertOneFunctionSources(), /skill x: candidate is not a string/);
        const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        assert.match(src, /this\._relink\(\);\n\s*this\._assertOneFunctionSources\(\);/);
    });
    it('every seeded primitive is one top-level function (the load check holds for the repo-owned library)', () => {
        for (const p of Voyager.SEEDED_PRIMITIVES) assert.deepStrictEqual(skillSourceViolations(p.code, p.name), [], p.name);
    });
    it('the manifest resets exactly the two live entries, refusing on any other state', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix82-'));
        try {
            mkdirSync(join(dir, 'skills'));
            const index = [
                { name: 'checkForIronPickaxe', code: LIVE.checkForIronPickaxe.code, stats: { success: 1, fail: 0 } },
                { name: 'tossClutterForIron', code: LIVE.tossClutterForIron.code, mergedInto: 'tossClutter' },
            ];
            writeFileSync(join(dir, 'skills/index.json'), JSON.stringify(index));
            writeFileSync(join(dir, 'skills/progress.json'), '{}');
            const manifest = loadManifest(MANIFEST);
            applyManifest({ manifest, botsDir: dir, apply: true, log: () => {} });
            const after = JSON.parse(readFileSync(join(dir, 'skills/index.json'), 'utf8'));
            for (const e of after) assert.deepStrictEqual(skillSourceViolations(e.code, e.name), [], e.name);
            assert.ok(LIVE.checkForIronPickaxe.code.startsWith(after[0].code), 'the kept function is byte-identical');
            assert.deepStrictEqual(after[0].stats, { success: 1, fail: 0 });
            // applied again: the expect no longer holds, so it refuses
            assert.throws(() => applyManifest({ manifest, botsDir: dir, apply: false, log: () => {} }), /expect mismatch/);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('fix82 (2): craftItem "Cannot read properties of undefined (reading \'find\')" at (-125,43,61)', () => {
    it('reproduces: the held repair candidate reads bot.recipes, which a mineflayer bot does not have', () => {
        const bot = liveBot();
        assert.ok(!('recipes' in bot) && typeof bot.recipesFor === 'function' && typeof bot.recipesAll === 'function');
        const line = LIVE.craftItemCandidate.code.split('\n').find(l => l.includes('.find('));
        assert.strictEqual(line.trim(), 'const recipe = bot.recipes.find(r => r.output.name === itemName);');
        const itemName = 'iron_pickaxe';
        assert.throws(() => bot.recipes.find(r => r.output.name === itemName), { name: 'TypeError', message: "Cannot read properties of undefined (reading 'find')" });
        // the incumbent never touched bot.recipes: the failure is the candidate's
        assert.doesNotMatch(LIVE.craftItemIncumbent.code, /bot\.recipes\b(?!For|All)/);
    });
    it('the static API gate names it, with the real members, before it can be held', () => {
        const coder = new Coder({ name: NAME, bot: liveBot() });
        const r = coder.userGeneratedCodeLintBlockers(LIVE.craftItemCandidate.code, ['craftItem', 'collectBlock', 'ensureCraftingTable', 'craftRecipe']);
        assert.match(r, /^API gate: bot\.recipes does not exist on the live bot \(closest real members: bot\.\w+/);
        // the incumbent passes the same gate
        assert.strictEqual(coder.userGeneratedCodeLintBlockers(LIVE.craftItemIncumbent.code, ['craftItem', 'craftRecipe']), null);
    });
    it('saveSkill (the 18:27:59Z repair submit) rejects it: no candidate is held, so no trial throws', async () => {
        const v = Object.create(Voyager.prototype);
        const entry = { name: 'craftItem', code: LIVE.craftItemIncumbent.code, deps: ['craftRecipe'], stats: { success: 6, fail: 5, streakFail: 0, tasks: [] } };
        Object.assign(v, { skills: [entry, { name: 'craftRecipe', code: 'async function craftRecipe(bot, n, c) { return true; }' }, { name: 'collectBlock', code: 'async function collectBlock(bot, n, c) { return true; }' }, { name: 'ensureCraftingTable', code: 'async function ensureCraftingTable(bot) { return true; }' }],
            _lastEffects: [], agent: { coder: new Coder({ name: NAME, bot: liveBot() }) } });
        const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
        let saved;
        try { saved = await v.saveSkill('craftItem', 'd', LIVE.craftItemCandidate.code.replace(/^\/\/[^\n]*\n/, ''), 'repair: Craft 1 iron_pickaxe', { repair: true }); }
        finally { console.log = orig; }
        assert.strictEqual(saved, false);
        assert.strictEqual(entry.candidate, undefined);
        assert.ok(lines.some(l => /\[gate\] REJECT craftItem: API gate: bot\.recipes does not exist on the live bot/.test(l)), lines.join('\n'));
    });
    it('the repair loop feeds the gate error back to the model, and the corrected reply is what gets submitted', async () => {
        const v = Object.create(Voyager.prototype);
        const entry = { name: 'craftItem', code: LIVE.craftItemIncumbent.code, deps: ['craftRecipe'], description: 'Craft itemName', stats: { success: 6, fail: 5, streakFail: 0, tasks: [] } };
        const fixedReply = '```javascript\n' + LIVE.craftItemIncumbent.code + '\n```';
        const replies = ['```javascript\n' + LIVE.craftItemCandidate.code + '\n```', fixedReply];
        const prompts = [], submitted = [];
        Object.assign(v, { _saveProgress() {}, _saveSkills() {} });   // before _repairQueue: its setter persists progress
        Object.assign(v, {
            skills: [entry, { name: 'craftRecipe', code: 'async function craftRecipe(bot, n, c) { return true; }', deps: [] }],
            progress: {}, _repairQueue: [{ target: 'craftItem', kind: 'callee_fix', task: 'Craft 1 iron_pickaxe', path: ['obtainItem', 'craftItem'], evidence: 'returned false', trace: 'craftItem("iron_pickaxe",1) -> false FAIL', sig: 's' }],
            agent: { coder: new Coder({ name: NAME, bot: liveBot() }) },
            repairMemory: { retrieveSimilar: async () => [], formatHintsForCoder: () => '', recordRepair: async () => {} },
            _saveProgress() {}, _saveSkills() {}, _cursorLimited: () => false, _updateAllowed: () => true, unifiedAPIList: () => '',
            _ask: async (sys, user) => { prompts.push(user); return replies.shift(); },
            _stageLintExec: async () => ({ lint: null, staged: {} }),
            saveSkill: async (name, desc, body) => { submitted.push({ name, body }); return true; },
            _setTrialTask() {},
        });
        const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
        try { assert.strictEqual(await v._repair(), true); } finally { console.log = orig; }
        assert.strictEqual(prompts.length, 2);
        assert.match(prompts[1], /--- your previous reply was rejected ---\nlint: API gate: bot\.recipes does not exist on the live bot/);
        assert.deepStrictEqual(submitted.map(s => s.name), ['craftItem']);
        assert.doesNotMatch(submitted[0].body, /bot\.recipes\./);
        assert.ok(lines.some(l => /repair attempt 1 FAILED for craftItem: lint: API gate: bot\.recipes/.test(l)));
    });
    it('the repair loop refuses a reply with a second top-level function, and a repeat of it is not submitted (was: fail open)', async () => {
        const v = Object.create(Voyager.prototype);
        const entry = { name: 'checkForIronPickaxe', code: 'async function checkForIronPickaxe(bot) { return false; }', deps: [], description: 'd', stats: { success: 1, fail: 1, streakFail: 1, tasks: [] } };
        const prompts = [];
        Object.assign(v, { _saveProgress() {}, _saveSkills() {} });   // before _repairQueue: its setter persists progress
        Object.assign(v, {
            skills: [entry], progress: {}, _repairQueue: [{ target: 'checkForIronPickaxe', kind: 'callee_fix', task: 't', path: ['checkForIronPickaxe'], evidence: 'returned false', trace: '', sig: 's' }],
            agent: { coder: new Coder({ name: NAME, bot: liveBot() }) },
            repairMemory: { retrieveSimilar: async () => [], formatHintsForCoder: () => '', recordRepair: async () => {} },
            _saveProgress() {}, _saveSkills() {}, _cursorLimited: () => false, _updateAllowed: () => true, unifiedAPIList: () => '',
            _ask: async (sys, user) => { prompts.push(user); return '```javascript\n' + LIVE.checkForIronPickaxe.code + '\n```'; },
            _stageLintExec: async () => { throw new Error('must not stage a two-function reply'); },
            saveSkill: async () => { throw new Error('must not submit'); },
        });
        const orig = console.log; console.log = () => {};
        try { assert.strictEqual(await v._repair(), false); } finally { console.log = orig; }
        assert.match(prompts[1], /lint: A learned skill is ONE top-level function: `async function checkForIronPickaxe\(bot, \.\.\.\)`.*top-level function checkIronPickaxe besides checkForIronPickaxe/);
        // the model repeated the rejected reply: before, the loop ended on the duplicate and submitted attempt 1's body
        assert.strictEqual(entry.repairHistory.at(-1).outcome, 'duplicate replies');
    });
    it('writeCode and the repair loop run the same gate; saveSkill runs it for every other path', () => {
        const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        assert.match(src, /const gate = this\.agent\.coder\.userGeneratedCodeLintBlockers\(code, this\.skills\.map\(s => s\.name\)\);/);
        assert.match(src, /const apiErr = this\.agent\.coder\._apiGate\(code, \[\.\.\.names\]\);/);
        // writeCode: the shape lint runs before staging, and what is saved is the AST-cut source
        assert.match(src, /const split = lint \? null : splitGeneratedCode\(code, own\);\n\s*if \(split && split\.violations\.length\) lint = oneFunctionFeedback\(own, split\.violations\);\n\s*let staged = null;\n\s*if \(!lint\) \{/);
        assert.match(src, /await this\.saveSkill\(own, desc\.trim\(\), split\.skillSource, task\);/);
        assert.doesNotMatch(src.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n'), /code\.replace\(\/\\n\\s\*await\\s\+\\w\+\\\(bot/);
    });
});
