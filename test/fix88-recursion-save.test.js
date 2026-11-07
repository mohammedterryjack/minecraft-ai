/**
 * fix88 (icefox, iMac, 2026-11-06): equipOrCraftIronPickaxe was saved NEW at 23:47 under 2195e1f.
 * Its body calls itself (`await equipOrCraftIronPickaxe(bot)`). The next boot (a04a68d) threw
 * SELF-RECURSION in Voyager._relink and crash-looped. The check lived only on the load path.
 *
 * The save gate must reject that candidate before any skill file or index write, record the
 * violation where the learner reads it, and _relink must still throw on a stored copy.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Voyager } from '../src/agent/voyager.js';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// The logged body, inside the function the boot check matched (the call's arguments are the function's own parameters).
const EVIDENCE_CODE = `async function equipOrCraftIronPickaxe(bot) {
    const have = await checkForIronPickaxe(bot);
    if (have) return true;
    await equipToolForBlock(bot);
    await craftItem(bot, 'iron_pickaxe', 1);
    const nearestLog = await getNearestBlock(bot, 'oak_log', 10);
    if (nearestLog) {
        await goToPosition(bot, nearestLog.x, nearestLog.y, nearestLog.z);
        await collectBlock(bot, 'oak_log', 1);
        await equipOrCraftIronPickaxe(bot); // Retry after collecting the log
    }
    return false;
}`;

function skill(name, code, deps = []) {
    return { name, code, deps, effects: [], consumes: {}, stats: { success: 0, fail: 0, streakFail: 0, tasks: [] } };
}
function helper(name) {
    return skill(name, `async function ${name}(bot) {\n    return true;\n}`);
}
// The library skills named in the live gate line: deps=[checkForIronPickaxe, equipToolForBlock, craftItem, collectBlock]
const LIB = ['checkForIronPickaxe', 'equipToolForBlock', 'craftItem', 'collectBlock'].map(helper);

function saver() {
    const dir = mkdtempSync(join(tmpdir(), 'fix88-'));
    dirs.push(dir);
    const persisted = [];
    const v = Object.create(Voyager.prototype);
    v.dir = dir;
    v.skills = LIB.map(s => ({ ...s }));
    v.installRejections = [];
    v._installRejection = null;
    v._lastEffects = [];
    v.agent = { coder: { _apiGate: () => null } };
    v._embed = async () => { throw new Error('embed ran: rejection did not stop before persist'); };
    v._saveSkills = () => { persisted.push('skills'); };
    v._saveProgress = () => { persisted.push('progress'); };
    v._learnContracts = async () => { persisted.push('contracts'); };
    v._extractShared = () => { persisted.push('shared'); };
    v._cursorLimited = () => { persisted.push('cursor'); return true; };
    return { v, dir, persisted };
}

describe('fix88: the live equipOrCraftIronPickaxe save is rejected before anything is written', () => {
    it('saveSkill (the NEW path) rejects the evidence code, writes nothing, and records the violation', async () => {
        const { v, dir, persisted } = saver();
        const errors = [];
        const orig = console.error;
        console.error = (...a) => { errors.push(a.join(' ')); };
        let saved;
        try { saved = await v.saveSkill('equipOrCraftIronPickaxe', 'Equip or craft an iron pickaxe', EVIDENCE_CODE, 'Craft 1 iron_pickaxe'); }
        finally { console.error = orig; }
        assert.strictEqual(saved, false);
        assert.deepStrictEqual(v.skills.map(s => s.name), LIB.map(s => s.name));
        assert.deepStrictEqual(readdirSync(dir), []);
        assert.deepStrictEqual(persisted, []);
        assert.strictEqual(v.installRejections.length, 1);
        const rec = v.installRejections[0];
        assert.strictEqual(rec.name, 'equipOrCraftIronPickaxe');
        assert.strictEqual(rec.outcome, 'rejected');
        assert.match(rec.evidence, /SELF-RECURSION/);
        assert.match(rec.evidence, /equipOrCraftIronPickaxe/);
        assert.ok(errors.some(l => /SELF-RECURSION/.test(l) && /equipOrCraftIronPickaxe/.test(l)), errors.join('\n'));
    });

    it('a repaired version of an existing skill is rejected the same way: no candidate, no file, repairHistory carries the violation', async () => {
        const { v, dir, persisted } = saver();
        const incumbent = skill('equipOrCraftIronPickaxe', 'async function equipOrCraftIronPickaxe(bot) {\n    return await checkForIronPickaxe(bot);\n}', ['checkForIronPickaxe']);
        const before = incumbent.code;
        v.skills.push(incumbent);
        const saved = await v.saveSkill('equipOrCraftIronPickaxe', 'Equip or craft an iron pickaxe', EVIDENCE_CODE, 'repair: Craft 1 iron_pickaxe', { repair: true });
        assert.strictEqual(saved, false);
        assert.strictEqual(incumbent.code, before);
        assert.strictEqual(incumbent.candidate, undefined);
        assert.deepStrictEqual(readdirSync(dir), []);
        assert.deepStrictEqual(persisted, []);
        assert.strictEqual(v.installRejections.length, 0);
        assert.ok(Array.isArray(incumbent.repairHistory) && incumbent.repairHistory.length === 1);
        assert.strictEqual(incumbent.repairHistory[0].outcome, 'rejected');
        assert.match(incumbent.repairHistory[0].evidence, /SELF-RECURSION/);
        assert.match(incumbent.repairHistory[0].evidence, /equipOrCraftIronPickaxe/);
    });
});

describe('fix88: a candidate that closes a cycle with an existing skill is rejected', () => {
    it('A calls B and B already calls A, even when B.deps does not list A yet', async () => {
        const { v, dir, persisted } = saver();
        // stored deps are empty: the call is only in the code, which is what the next boot would relink
        const b = skill('stackLogs', 'async function stackLogs(bot) {\n    await bringLogs(bot);\n    return true;\n}', []);
        v.skills = [b];
        const code = 'async function bringLogs(bot) {\n    await stackLogs(bot);\n    return true;\n}';
        const saved = await v.saveSkill('bringLogs', 'Bring logs', code, 'Collect 1 oak_log');
        assert.strictEqual(saved, false);
        assert.deepStrictEqual(v.skills.map(s => s.name), ['stackLogs']);
        assert.strictEqual(b.code.includes('bringLogs'), true);
        assert.deepStrictEqual(readdirSync(dir), []);
        assert.deepStrictEqual(persisted, []);
        assert.strictEqual(v.installRejections.length, 1);
        assert.match(v.installRejections[0].evidence, /DEPENDENCY CYCLE/);
        assert.match(v.installRejections[0].evidence, /bringLogs/);
        assert.match(v.installRejections[0].evidence, /stackLogs/);
        assert.strictEqual(v.installRejections[0].outcome, 'rejected');
    });
});

describe('fix88: promotion uses the same check', () => {
    it('promoting a self-calling candidate does not replace the live code or write the skill file', () => {
        const { v, dir, persisted } = saver();
        const entry = skill('makePlanks', 'async function makePlanks(bot) {\n    return true;\n}');
        entry.description = 'Make planks';
        v.skills = [entry];
        const cand = { code: 'async function makePlanks(bot) {\n    await makePlanks(bot);\n    return true;\n}', description: 'bad', deps: [], effects: [], embedding: [0], stats: { success: 2, fail: 0, streakFail: 0, tasks: [] } };
        entry.candidate = cand;
        assert.strictEqual(v._promote(entry, cand), false);
        assert.strictEqual(entry.code, 'async function makePlanks(bot) {\n    return true;\n}');
        assert.strictEqual(entry.candidate, undefined);
        assert.deepStrictEqual(readdirSync(dir), []);
        assert.deepStrictEqual(persisted, []);
        assert.match(entry.repairHistory[0].evidence, /SELF-RECURSION/);
        assert.match(entry.repairHistory[0].evidence, /makePlanks/);
    });
});

describe('fix88: _relink still throws on a stored self-recursive skill', () => {
    it('the evidence skill, already on disk in the library, fails the boot check', () => {
        const { v } = saver();
        v.skills = [skill('equipOrCraftIronPickaxe', EVIDENCE_CODE, ['checkForIronPickaxe', 'equipToolForBlock', 'craftItem', 'collectBlock']), ...LIB.map(s => ({ ...s }))];
        assert.throws(() => v._relink(), (e) => {
            assert.match(e.message, /SELF-RECURSION/);
            assert.match(e.message, /equipOrCraftIronPickaxe/);
            return true;
        });
    });

    it('a stored mutual cycle still fails the boot check', () => {
        const { v } = saver();
        v.skills = [
            skill('bringLogs', 'async function bringLogs(bot) {\n    await stackLogs(bot);\n    return true;\n}', ['stackLogs']),
            skill('stackLogs', 'async function stackLogs(bot) {\n    await bringLogs(bot);\n    return true;\n}', ['bringLogs']),
        ];
        assert.throws(() => v._relink(), /DEPENDENCY CYCLES/);
    });
});

describe('fix88: a self-call with different arguments is still saved', () => {
    it('bounded recursion is not a self-forward', async () => {
        const { v, persisted } = saver();
        v._embed = async () => [0];
        const code = 'async function obtainMore(bot, item, count = 1) {\n    if (count <= 0) return true;\n    await obtainMore(bot, item, count - 1);\n    return true;\n}';
        const saved = await v.saveSkill('obtainMore', 'Obtain more', code, 'Get 1 oak_log');
        assert.strictEqual(saved, true);
        assert.ok(v.skills.some(s => s.name === 'obtainMore'));
        assert.deepStrictEqual(v.installRejections, []);
        assert.ok(persisted.includes('skills'));
    });
});
