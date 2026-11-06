/**
 * fix68: 14:02:52Z "[watchdog] MAIN THREAD BLOCKED ... skill=getInventoryCounts stack=getInventoryCounts" (pid 21733).
 * The 14:02:14Z promotion of mineIronOreBlock carried built-in deps from saveSkill (fix26 widened the name set; _relink
 * strips them on restart: "[psn] relink mineIronOreBlock: deps [getVitalsMax, travelTo, goToSurface, goToPosition,
 * getInventoryCounts, ...] -> [...]"). The next replay's closure (13 -> 16 names) therefore traced getInventoryCounts, and
 * the PSN harness read inventory through that same rebound name: its pre-snapshot re-entered the wrapper synchronously at
 * the root (par = -1, no await before the snapshot; the 1500 cap counts pushes, which come after the snapshot). Every
 * tower overflowed the stack, the rejection was dropped, the parent started another from its state snapshot.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Vec3 } from 'vec3';
import { Coder } from '../src/agent/coder.js';
import { Voyager } from '../src/agent/voyager.js';
import { instrumentSrc } from '../src/agent/skill_graph.js';

const NAME = '__fix68_test__';
after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));
const CHILD = fileURLToPath(new URL('./fixtures/fix68-harness-child.mjs', import.meta.url));
const LIVE = fileURLToPath(new URL('./fixtures/fix68-live-harness-103.js', import.meta.url));

function runChild(arg, ms) {
    return new Promise(resolve => {
        const c = spawn(process.execPath, [CHILD, arg], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        c.stdout.on('data', d => { out += d; });
        const t = setTimeout(() => c.kill('SIGKILL'), ms);
        c.on('exit', (code, signal) => { clearTimeout(t); resolve({ out, signal }); });
    });
}
function mkBot() {
    return { output: '', interrupt_code: false, __psnALS: new AsyncLocalStorage(), inventory: { slots: Array(46).fill(null), emptySlotCount: () => 36 },
        waitForTicks: async () => {}, entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null, health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, quickBarSlot: 0 };
}

describe('fix68: the trace harness cannot re-enter itself', () => {
    it('reproduces the live hang: the 14:02:30Z staged harness with getInventoryCounts traced never yields', { timeout: 20000 }, async () => {
        const { out, signal } = await runChild(LIVE, 4000);
        assert.strictEqual(signal, 'SIGKILL', 'still running after 4 s');
        assert.ok(!out.includes('TURN'), 'not one event-loop turn while the traced root ran');
    });
    it('the current harness, same setup: finishes, the root gets its real value, the harness is not traced', { timeout: 20000 }, async () => {
        const { out, signal } = await runChild('current', 10000);
        assert.strictEqual(signal, null, 'not killed');
        assert.match(out, /DONE 1 trace=mineOneIronOre,getInventoryCounts\n/);
    });
    it('a traced sync function stays sync (built-in or learned), and a sync throw is a loud false', async () => {
        const coder = new Coder({ name: NAME });
        while (!coder.code_lint_template || !coder.code_template) await new Promise(r => setImmediate(r));
        const code = 'function isSafeTarget(bot) { return false; }\nfunction boom(bot) { throw new Error("bad"); }\n'
            + 'async function mineOne(bot) {\n    const c = getInventoryCounts(bot);\n    bot.got = [typeof c.then, isSafeTarget(bot), boom(bot)];\n    return 1;\n}\n'
            + instrumentSrc(['mineOne', 'isSafeTarget', 'boom', 'getInventoryCounts']) + '\nawait mineOne(bot);';
        const staged = await coder._stageCode(code, { lintOnly: false });
        const bot = mkBot();
        await staged.func.main(bot);
        assert.deepStrictEqual(bot.got, ['undefined', false, false]);
        assert.match(bot.output, /FAILED: boom threw bad/);
        assert.deepStrictEqual(bot.__psnTrace.map(r => [r.name, r.depth]), [['mineOne', 0], ['getInventoryCounts', 1], ['isSafeTarget', 1], ['boom', 1]]);
        assert.ok(bot.__psnTrace.every(r => r.delta && r.t1 >= r.t0), 'every record is finished');
    });
    it('while the harness snapshots state the published stack says so: "<stack> <- (psn trace)"', async () => {
        const coder = new Coder({ name: NAME });
        while (!coder.code_lint_template || !coder.code_template) await new Promise(r => setImmediate(r));
        const code = 'async function inner(bot) { bot.inSkill = bot.__psnStackStr; return 1; }\nasync function outer(bot) {\n    await inner(bot);\n    return 1;\n}\n'
            + instrumentSrc(['outer', 'inner']) + '\nawait outer(bot);';
        const staged = await coder._stageCode(code, { lintOnly: false });
        const bot = mkBot(); const seen = [];
        const slots = bot.inventory.slots;
        Object.defineProperty(bot.inventory, 'slots', { get() { seen.push(bot.__psnStackStr); return slots; } });
        await staged.func.main(bot);
        assert.strictEqual(bot.inSkill, 'outer <- inner');
        assert.ok(seen.length > 0 && seen.every(s => / <- \(psn trace\)$/.test(s)), seen.join(' | '));
        assert.ok(seen.includes('outer <- inner <- (psn trace)'));
    });
});

describe('fix68: deps are library skills only; async built-ins are traced by name', () => {
    it('saveSkill keeps built-ins out of deps (as _relink does)', async () => {
        const v = Object.create(Voyager.prototype);
        v.skills = [{ name: 'travelTo', code: 'async function travelTo(bot) { return true; }', deps: [] }];
        v._embed = async () => null; v._saveSkills = () => {}; v._extractShared = () => {}; v._learnContracts = async () => 0; v._cursorLimited = () => true; v.dir = `./bots/${NAME}`; mkdirSync(v.dir, { recursive: true });
        const ok = await v.saveSkill('mineOne', 'd', 'async function mineOne(bot) {\n    const c = getInventoryCounts(bot);\n    await goToPosition(bot, 1, 2, 3, 1);\n    return await travelTo(bot);\n}', 'task');
        assert.notStrictEqual(ok, false);
        assert.deepStrictEqual(v.skills.find(s => s.name === 'mineOne').deps, ['travelTo']);
    });
    it('the traced names add async built-ins the closure calls, never sync queries', () => {
        const v = Object.create(Voyager.prototype);
        v.skills = [{ name: 'mineOne', code: 'async function mineOne(bot) {\n    const c = getInventoryCounts(bot);\n    await goToPosition(bot, 1, 2, 3, 1);\n    return getNearestBlock(bot, "iron_ore", 16);\n}' }];
        assert.deepStrictEqual(Voyager._tracedSkillNamesForInstrument(v, new Set(['mineOne']), {}), ['mineOne', 'goToPosition']);
    });
});

describe('fix68: a hang counts against the library skill that ran, candidate or incumbent', () => {
    const DIR = `./bots/${NAME}/skills`;
    function rig() {
        mkdirSync(DIR, { recursive: true });
        const v = Object.create(Voyager.prototype);
        v.dir = DIR; v._saveSkills = () => {}; v._proposalOutcome = () => {};
        v.skills = [
            { name: 'mineOneIronOre', code: 'async function mineOneIronOre(bot) { return await mineIronOreBlock(bot); }', deps: ['mineIronOreBlock'], stats: { success: 3, fail: 0, streakFail: 0, tasks: [] } },
            { name: 'mineIronOreBlock', code: 'async function mineIronOreBlock(bot) { return true; }', deps: ['collectBlock'], saved: '2026-11-06T14:02:14.682Z', stats: { success: 2, fail: 0, streakFail: 0, tasks: [] } },
            { name: 'collectBlock', code: 'async function collectBlock(bot) { return 1; }', deps: [], stats: { success: 1, fail: 1, streakFail: 0, tasks: [] },
                candidate: { code: 'async function collectBlock(bot) { return 2; }', stats: { success: 0, fail: 0, streakFail: 0, tasks: [] } } },
        ];
        return v;
    }
    const evidence = (stack) => { const p = `./bots/${NAME}/watchdog_kill.json`; writeFileSync(p, JSON.stringify({ pid: process.pid, silentMs: 22693, limitMs: 22546, phases: ['action:voyager:replay:Mine 1 iron_ore'], skill: stack.split(' <- ').pop(), stack })); return p; };
    it('a just-promoted incumbent on the stack records a failed run (fix65 counted only candidates)', () => {
        const v = rig();
        v._openTrialJournal(['collectBlock'], 'mineOneIronOre', 'Mine 1 iron_ore', v._closure('mineOneIronOre'));
        v._settleDeadTrials(evidence('mineOneIronOre <- mineIronOreBlock'));
        const e = v.skills.find(s => s.name === 'mineIronOreBlock');
        assert.strictEqual(e.stats.fail, 1);
        assert.strictEqual(v.skills.find(s => s.name === 'collectBlock').candidate.stats.fail, 0);
        assert.ok(!existsSync(v._trialJournalFile));
    });
    it('a run with no candidate in flight is journalled too, and the root counts when it is the deepest frame', () => {
        const v = rig(); delete v.skills[2].candidate;
        v._openTrialJournal([], 'mineOneIronOre', 'Mine 1 iron_ore', v._closure('mineOneIronOre'));
        assert.ok(existsSync(v._trialJournalFile));
        v._settleDeadTrials(evidence('mineOneIronOre <- getInventoryCounts'));
        assert.strictEqual(v.skills.find(s => s.name === 'mineOneIronOre').stats.fail, 1, 'a built-in frame is charged to the skill that called it');
    });
    it('harness bookkeeping is nobody\'s skill: loud, nothing counted', () => {
        const v = rig();
        v._openTrialJournal(['collectBlock'], 'mineOneIronOre', 'Mine 1 iron_ore', v._closure('mineOneIronOre'));
        v._settleDeadTrials(evidence('mineOneIronOre <- mineIronOreBlock <- collectBlock <- (psn trace)'));
        assert.deepStrictEqual(v.skills.map(s => s.stats.fail), [0, 0, 1]);
        assert.strictEqual(v.skills[2].candidate.stats.fail, 0);
    });
    it('the version that ran is the one counted: changed code since the run is not charged', () => {
        const v = rig();
        v._openTrialJournal([], 'mineOneIronOre', 'Mine 1 iron_ore', v._closure('mineOneIronOre'));
        v.skills[1].code = 'async function mineIronOreBlock(bot) { return false; }';
        v._settleDeadTrials(evidence('mineOneIronOre <- mineIronOreBlock'));
        assert.strictEqual(v.skills[1].stats.fail, 0);
    });
});
