/**
 * fix73 (live iMac, ab03600 deployed 15:03:03 GMT, pid 34783, Node v20.20.2):
 *  1. 15:06:47Z replay of scanForIronOreBlocks: "TypeError: __rawInventoryCounts is not a function" at __inv <- __have <- __harness.
 *     fix68 (#61) has the harness read inventory through `const __rawInventoryCounts = getInventoryCounts;` (a value reference).
 *     Staging endows only the built-ins collectBareApiUsedInSource finds, and since #44 it found call sites only. The live
 *     closure (scanForIronOreBlocks calls getNearestBlocks, never getInventoryCounts) was staged without getInventoryCounts,
 *     SES resolved the free name to undefined, and the first trace snapshot threw.
 *  2. 15:02:47Z "[idle-practice] ERROR: Cannot convert undefined or null to object": Object.keys(skill.consumes) on
 *     equipBestToolForIronOre, saved NEW at 14:43:51Z without a consumes record (saveSkill's NEW entry never had one).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { Coder, collectBareApiUsedInSource } from '../src/agent/coder.js';
import { Voyager } from '../src/agent/voyager.js';
import { instrumentSrc, newStats } from '../src/agent/skill_graph.js';
import { _setVersionForTest } from '../src/utils/mcdata.js';

_setVersionForTest('1.20.4');
const NAME = '__fix73_test__';
after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));
const LIVE_SCAN = readFileSync(new URL('./fixtures/fix73-live-scanForIronOreBlocks.js', import.meta.url), 'utf8');

let coderP = null;
const mkCoder = () => (coderP ||= (async () => { const c = new Coder({ name: NAME }); while (!c.code_lint_template || !c.code_template) await new Promise(r => setImmediate(r)); return c; })());
function mkBot() {
    return { output: '', interrupt_code: false, inventory: { slots: Array(46).fill(null), emptySlotCount: () => 36 }, findBlocks: () => [],
        waitForTicks: async () => {}, entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null, health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, quickBarSlot: 0 };
}

describe('fix73: every built-in the staged program references is endowed', () => {
    it('live replay: the 15:06:47Z scanForIronOreBlocks replay bundle stages and runs under the PSN harness', async () => {
        const v = Object.create(Voyager.prototype);
        v.agent = { coder: await mkCoder() };
        v.skills = [{ name: 'scanForIronOreBlocks', code: LIVE_SCAN.replace(/^\/\/.*\n/, ''), deps: [], effects: [], consumes: {}, stats: newStats() }];
        // the replay path (voyager.js _replaySkill): same closure, traced names, library part, call and harness
        const closure = new Set(['scanForIronOreBlocks', ...v._closure('scanForIronOreBlocks')]);
        const over = {};
        const traced = Voyager._tracedSkillNamesForInstrument(v, closure, over);
        const libPart = v._libSrcSubset(closure, over);
        const call = '\n\nasync function __replay(bot) {\n    try { await scanForIronOreBlocks(bot); } finally { bot.__psnOut = bot.output; }\n}\nawait __replay(bot);';
        const full = libPart + '\n\n' + instrumentSrc(traced) + call;
        assert.ok(!/getInventoryCounts\s*\(/.test(full), 'the live bundle never calls getInventoryCounts( itself');
        const { lint, staged } = await v._stageLintExecTraced(libPart + call, full, closure, 'test:replay:scanForIronOreBlocks');
        assert.strictEqual(lint, null);
        const bot = mkBot();
        await staged.func.main(bot);   // #61: TypeError: __rawInventoryCounts is not a function
        await Promise.resolve(); await Promise.resolve();
        assert.deepStrictEqual(bot.__psnTrace.map(r => r.name), ['scanForIronOreBlocks']);
        assert.ok(!/is not a function/.test(bot.output), bot.output);
    });

    it('collectBareApiUsedInSource counts value references, stores and rebinds, not only calls', () => {
        const src = 'const a = getInventoryCounts;\nconst b = [getNearestBlock];\nfoo(goToPosition);\nplaceBlock = wrap(placeBlock);\n'
            + 'const o = { craftRecipe };\nconst c = getNearestBlocks(bot);';
        const { skillNames, worldNames } = collectBareApiUsedInSource(src);
        assert.deepStrictEqual([...worldNames].sort(), ['getInventoryCounts', 'getNearestBlock', 'getNearestBlocks']);
        assert.deepStrictEqual([...skillNames].sort(), ['craftRecipe', 'goToPosition', 'placeBlock']);
    });

    it('a property name or a non-computed key is not a reference to the built-in', () => {
        const src = 'const x = bot.getInventoryCounts;\nconst o = { goToPosition: 1, craftRecipe() {} };\nclass K { placeBlock() {} }\ngetNearestBlock: for (;;) { break getNearestBlock; }';
        const { skillNames, worldNames } = collectBareApiUsedInSource(src);
        assert.deepStrictEqual([...skillNames, ...worldNames], []);
    });
});

describe('fix73: a NEW skill carries a consumes record', () => {
    function mkSaver() {
        const v = Object.create(Voyager.prototype);
        v.dir = `./bots/${NAME}/skills`; mkdirSync(v.dir, { recursive: true }); v.skills = []; v.progress = {};
        v.agent = { prompter: { code_model: { fallback: true } }, coder: { _apiGate: () => null } };   // fix82: saveSkill runs the static API gate (tested in fix82-redeclare-apigate)
        v._saveSkills = () => {}; v._embed = async () => [0]; v._learnContracts = async () => 0; v._extractShared = () => {};
        return v;
    }
    it('live replay: saveSkill NEW (as at 14:43:51Z), then the success path learns effects, then idle practice selects', async () => {
        const v = mkSaver();
        v._lastEffects = [];
        assert.strictEqual(await v.saveSkill('equipBestToolForIronOre', 'Equip the best tool', 'async function equipBestToolForIronOre(bot) {\n    return "iron_shovel";\n}', 'equipBestTool: Equip the best tool'), true);
        const e = v.skills[0];
        assert.deepStrictEqual(e.consumes, {});
        // the run consumed and gained nothing: the record stays the empty observation (it was left undefined before)
        v._learnEffects(e, { inventory: { cobblestone: 5 } }, { inventory: { cobblestone: 5 } });
        assert.deepStrictEqual(e.consumes, {});
        // _shouldSkipPractice is what threw "Cannot convert undefined or null to object"
        assert.strictEqual(v._shouldSkipPractice(e, { cobblestone: 5 }, new Set()), null);
    });
    it('saveSkill takes the observed effects from its caller once: missing throws, a stale value is never reused', async () => {
        const v = mkSaver();
        const code = n => `async function ${n}(bot) {\n    return true;\n}`;
        await assert.rejects(v.saveSkill('noEffects', 'd', code('noEffects'), 't'), /saveSkill noEffects: no observed effects set by the caller/);
        v._lastEffects = ['iron_ingot'];
        assert.strictEqual(await v.saveSkill('first', 'd', code('first'), 't'), true);
        assert.deepStrictEqual(v.skills.find(s => s.name === 'first').effects, ['iron_ingot']);
        assert.strictEqual(v._lastEffects, null);
        await assert.rejects(v.saveSkill('second', 'd', code('second'), 't'), /no observed effects set by the caller/);   // was: first's effects
    });
    it('learned effects are not capped (fix32 kept the first 12; a 13th real effect was dropped)', () => {
        const v = mkSaver();
        // fix74: effects are derived from run evidence; one measured run gaining 13 items keeps all 13
        const made = Array.from({ length: 13 }, (_, i) => `item_${i}`);
        const e = { name: 'x', effects: [], consumes: {} };
        v._learnEffects(e, { inventory: {} }, { inventory: Object.fromEntries(made.map(k => [k, 1])) });
        assert.deepStrictEqual(e.effects, made);
    });
    it('_learnEffects fails loudly on an entry without the record instead of comparing against a default', () => {
        const v = mkSaver();
        assert.throws(() => v._learnEffects({ name: 'x', effects: [] }, { inventory: {} }, { inventory: {} }), /skill x has no effects\/consumes record/);
    });
});
