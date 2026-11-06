/**
 * fix70 (2): "Identifier ... has already been declared" after #54 (fix61, ad82f57). #54 fixed the lint PRELUDE (a seeded
 * primitive bound from skills./world. and declared again as a learned name). The two live hits are upstream of the prelude:
 *  - 13:35:42Z writeCode "craftArmorSet: Craft and wear an iron armor set": the generated code defined its own equipBestArmor;
 *    depsOf matched the declaration `async function equipBestArmor(` as a call, so the library equipBestArmor was staged in the
 *    same bundle -> collectBareApiUsedInSource: parse failed (646:15), and the step failed.
 *  - 13:42:41Z writeCode "Ensure a furnace is within 16 blocks": the reply itself declared ensureFurnaceInRange twice;
 *    _forbiddenTimerLint threw on the parse error, so the step failed instead of the model getting the syntax error back.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import * as acorn from 'acorn';
import { Coder } from '../src/agent/coder.js';
import { depsOf, declaredNames } from '../src/agent/skill_graph.js';

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/fix70-live-eat.json', import.meta.url), 'utf8')).skills;
const NAME = '__fix70r_test__';
after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));
const lib = new Set(['equipBestArmor', 'craftArmorSet', 'ensureCraftingTable', 'craftItem', 'ensureFurnace', 'ensureFurnaceInRange']);
// the shape of the 13:35Z reply: its own equipBestArmor plus the task function that calls it
const GEN = `// DESCRIPTION: Craft and wear an iron armor set
async function equipBestArmor(bot) {
    let n = 0;
    for (const p of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) if (await equip(bot, p)) n++;
    return n;
}
async function craftIronArmorSet(bot) {
    if (!(await ensureCraftingTable(bot))) return 0;
    return await equipBestArmor(bot);
}
await craftIronArmorSet(bot);`;

describe('fix70: a name the generated code declares is its own definition', () => {
    it('declaredNames sees function and const/let/var declarations', () => {
        assert.deepStrictEqual([...declaredNames(GEN)].sort(), ['craftIronArmorSet', 'equipBestArmor', 'n', 'p']);
    });
    it('depsOf no longer counts the declaration as a call into the library', () => {
        assert.deepStrictEqual(depsOf(GEN, 'craftIronArmorSet', lib).sort(), ['ensureCraftingTable']);
    });
    it('the writeCode bundle for the live closure parses: the library equipBestArmor is not staged next to the generated one', () => {
        const own = 'craftIronArmorSet', declares = declaredNames(GEN);
        // a dep whose closure reaches the library equipBestArmor (craftArmorSet -> equipBestArmor) must not bring it in either
        const stage = new Set([own, ...depsOf(GEN, own, lib), 'craftArmorSet', 'equipBestArmor']);
        const libSrc = LIVE.filter(s => stage.has(s.name) && s.name !== own && !declares.has(s.name)).map(s => s.code).join('\n\n');
        assert.doesNotThrow(() => acorn.parse(libSrc + '\n\n' + GEN, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }));
        // before: the library copy was staged too
        const before = LIVE.filter(s => stage.has(s.name) && s.name !== own).map(s => s.code).join('\n\n');
        assert.throws(() => acorn.parse(before + '\n\n' + GEN, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }), /Identifier 'equipBestArmor' has already been declared/);
    });
    it('writeCode filters the staged library by the names the code declares', () => {
        const src = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
        assert.match(src, /const codeDeclares = declaredNames\(code\);\n\s*const libSkills = this\.skills\.filter\(s => stageNameSet\.has\(s\.name\) && s\.name !== own && !codeDeclares\.has\(s\.name\)\);/);
    });
});

describe('fix70: model code that does not parse is lint feedback, not a failed step', () => {
    it('the 13:42Z case: a reply declaring ensureFurnaceInRange twice gets the parser message back', async () => {
        const coder = new Coder({ name: NAME });
        const code = `async function ensureFurnaceInRange(bot) {\n    return await ensureFurnace(bot);\n}\nasync function ensureFurnaceInRange(bot) {\n    return true;\n}\nawait ensureFurnaceInRange(bot);`;
        const r = coder.userGeneratedCodeLintBlockers(code, []);
        assert.match(r, /^Syntax error \(cannot parse\): Identifier 'ensureFurnaceInRange' has already been declared/);
    });
    it('a non-syntax error in the parser is not turned into feedback', () => {
        const coder = new Coder({ name: NAME });
        assert.throws(() => coder._parseError({ toString() { throw new TypeError('boom'); } }), /boom/);
    });
});
