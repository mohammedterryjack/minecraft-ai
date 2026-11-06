/**
 * fix59: pre-existing rule violations next to the fix58 vitals work, each fixed at its root.
 * 1. _planStale "-6" hp/food drop: vitals now invalidate an overlapped plan only when the LEARNED recovery outlook changed.
 * 2. _knownSkillsFacts free-space name regex + name list: "frees space" is the skill's observed empty-slot gain (SlotEffects).
 * 3. fix28 sampler try/catch-and-continue: removed; fields exist by event order (update() runs after 'spawn'), else fail loud.
 * 4. literal "/20" hp/food max in the curriculum prompt, contract spec, contract validation state and !stats: VITALS_MAX.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { VitalsModel } from '../src/agent/vitals_model.js';
import { SlotEffects } from '../src/agent/slot_effects.js';
import { instrumentSrc } from '../src/agent/skill_graph.js';
import * as skills from '../src/agent/library/skills.js';
import { fatalExit, runUpdateLoop } from '../src/agent/fatal.js';

const HPMAX = skills.VITALS_MAX.health;
// real icefox2000 vitals (same segments as fix58): eat 12 -> 18 then hp 1 -> 18 -> 19; hp 17.27 stuck at food 17
const EAT_REGEN = [[1, 12], [1, 12], [1, 18], [18, 17], [19, 20]];
const STUCK = [...Array.from({ length: 20 }, () => [17.26666831970215, 17]), [17.26666831970215, 16]];
const feed = (m, seg) => { for (let i = 1; i < seg.length; i++) m.observeSample({ h: seg[i - 1][0], f: seg[i - 1][1] }, { h: seg[i][0], f: seg[i][1] }, HPMAX); };
const learned = () => { const m = new VitalsModel({ regen: {}, runs: {} }); feed(m, EAT_REGEN); feed(m, STUCK); return m; };
const strip = s => s.replace(/\/\/.*$/gm, '');
const VSRC = readFileSync(new URL('../src/agent/voyager.js', import.meta.url), 'utf8');
const method = (name) => { const i = VSRC.indexOf(`    ${name}(`); assert.ok(i > 0, name); const j = VSRC.indexOf('\n    }\n', i); return strip(VSRC.slice(i, j)); };

let Voyager;
before(async () => { Voyager = (await import('../src/agent/voyager.js')).Voyager; });

describe('fix59 (1): _planStale uses the learned recovery outlook, not a fixed drop', () => {
    const basis = { position: '0, 0, 0', time: 'day (1)', health: '17/20', food: '18/20', threats: 'none', recent_deaths: 'none' };
    const mkV = () => { const v = Object.create(Voyager.prototype); v.progress = { failed: [] }; return v; };
    it('no "- 6" (or any numeric hp/food drop) left in _planStale', () => {
        const src = method('_planStale');
        assert.ok(!/-\s*6\b/.test(src));
        assert.ok(!/parseInt\(now\.(health|food)\)/.test(src), 'no raw hp/food arithmetic');
    });
    it('a 6+ hp drop that stays inside the learned regen outlook does not re-plan (old rule did)', () => {
        const m = learned();
        const pl = { t: Date.now(), task: 'Mine 1 iron_ore', basis, rec: m.recovery(17, HPMAX, 18) };
        assert.strictEqual(mkV()._planStale(pl, { task: 'Mine 1 coal_ore' }, { ...basis, health: '10/20' }, m.recovery(10, HPMAX, 18)), null);
    });
    it('food crossing the learned regen level (18 -> 17, from real data) re-plans', () => {
        const m = learned();
        const pl = { t: Date.now(), task: 'Mine 1 iron_ore', basis, rec: m.recovery(20, HPMAX, 18) };
        assert.match(mkV()._planStale(pl, { task: 'Mine 1 coal_ore' }, { ...basis, food: '17/20' }, m.recovery(20, HPMAX, 17)), /food crossed the learned regen level 18 \(18 -> 17\)/);
    });
    it('learned recovery becoming blocked re-plans', () => {
        const m = learned();
        const pl = { t: Date.now(), task: 'Mine 1 iron_ore', basis, rec: m.recovery(HPMAX, HPMAX, 17) };
        assert.match(mkV()._planStale(pl, { task: 'Mine 1 coal_ore' }, basis, m.recovery(17.27, HPMAX, 17)), /learned health recovery changed \(not blocked -> blocked\)/);
    });
    it('before any rise is learned, food moves are no evidence (regenFood null both sides)', () => {
        const m = new VitalsModel({ regen: {}, runs: {} });
        assert.strictEqual(m.recovery(20, HPMAX, 20).regenFood, null);
        assert.strictEqual(VitalsModel.outlookChange(m.recovery(20, HPMAX, 20), m.recovery(5, HPMAX, 3)), null);
    });
    it('a plan without its recovery snapshot fails loud', () => {
        const pl = { t: Date.now(), task: 'Mine 1 iron_ore', basis };
        assert.throws(() => mkV()._planStale(pl, { task: 'x' }, basis, learned().recovery(20, HPMAX, 20)), /outlookChange needs two recovery/);
    });
    it('_prefetchPlan stores the learned outlook with the plan; _takePlan passes the current one', () => {
        assert.match(VSRC, /this\._plan = \{ p, task, basis: before, t: t0, rec: this\._recovery\(\) \}/);
        assert.match(VSRC, /this\._planStale\(pl, r, before, this\._recovery\(\)\)/);
    });
});

describe('fix59 (2): _knownSkillsFacts from learned slot effects, no names', () => {
    const mkV = (list, runs) => { const v = Object.create(Voyager.prototype); v.skills = list; v.slotEffects = new SlotEffects({ runs }); return v; };
    it('source has no regex literal, name set or keyword list', () => {
        const src = method('_knownSkillsFacts');
        assert.ok(!/\/[^/\n]*\|[^/\n]*\/[gimsuy]*\.test/.test(src), 'no regex alternation');
        assert.ok(!/new Set\(\[/.test(src), 'no name set');
        assert.ok(!/deposit|toss|clutter|chest|discard/i.test(src), 'no skill/keyword names');
    });
    it('describes skills that freed slots in observed runs; names alone (old false positives) get nothing', () => {
        const list = [
            { name: 'exploreForIronOreDeposit', description: 'explore for iron ore deposit' },   // old regex false positive
            { name: 'stashThings', description: 'puts things away' },                           // old regex miss
            { name: 'mineIronOreDeposit', description: 'mine iron' },
            { name: 'craftItem', description: 'craft an item', primitive: true },
        ];
        const f = mkV(list, { stashThings: { n: 4, freed: 10 }, mineIronOreDeposit: { n: 2, freed: -3 } })._knownSkillsFacts();
        assert.deepStrictEqual(f, [
            'exploreForIronOreDeposit',
            'stashThings: puts things away (observed: frees 2.5 inventory slots/run over 4 runs)',
            'mineIronOreDeposit',
            'craftItem: craft an item',
        ]);
    });
    it('a skill without a description fails loud', () => {
        assert.throws(() => mkV([{ name: 'x', primitive: true }], {})._knownSkillsFacts(), /has no description/);
    });
    it('SlotEffects learns mean freed slots and rejects a snapshot without free', () => {
        const e = new SlotEffects({ runs: {} });
        e.noteRun('s', { free: 3 }, { free: 7 }); e.noteRun('s', { free: 7 }, { free: 5 });
        assert.deepStrictEqual(e.effect('s'), { n: 2, freed: 1 });
        assert.strictEqual(e.effect('never'), null);
        assert.throws(() => e.noteRun('s', { free: 1 }, {}), /s1\.free must be a number/);
        assert.throws(() => new SlotEffects({}), /persisted store/);
    });
    it('_learnSlotEffects learns from traced runs, skipping interrupted/dead/no-snapshot records', () => {
        const v = mkV([], {});
        v._learnSlotEffects([
            { name: 'a', s0: { free: 2, alive: true }, s1: { free: 6, alive: true } },
            { name: 'b', intr: true, s0: { free: 2, alive: true }, s1: { free: 6, alive: true } },
            { name: 'c', s0: { free: 2, alive: true }, s1: { free: 6, alive: false } },
            { name: 'skills.x' },
        ]);
        assert.deepStrictEqual(Object.keys(v.slotEffects.s.runs), ['a']);
    });
    it('traced snapshots record free = empty inventory slots', async () => {
        const bot = {
            __psnALS: new AsyncLocalStorage(), output: '', health: 20, food: 20, oxygenLevel: 300, game: { dimension: 'overworld' }, quickBarSlot: 0,
            inventory: { slots: [], emptySlotCount: () => bot.__free }, __free: 30, entity: { position: { x: 0, y: 32, z: 0, floored() { return { offset: () => ({}) }; } } },
            blockAt: () => ({ skyLight: 0 }), waitForTicks: async () => {},
        };
        const AsyncFunction = (async () => {}).constructor;
        const prog = new AsyncFunction('bot', 'getInventoryCounts', `let stash = async (bot) => { bot.__free = 34; return true; };\n${instrumentSrc(['stash'])}\nawait stash(bot); return bot.__psnTrace;`);
        const tr = await prog(bot, () => ({}));
        assert.strictEqual(tr[0].s0.free, 30);
        assert.strictEqual(tr[0].s1.free, 34);
    });
});

describe('fix59 (3): vitals sampler fails loud, no catch-and-continue', () => {
    const mkV = (bot) => { const v = Object.create(Voyager.prototype); v.agent = { bot }; v.vitals = new VitalsModel({ regen: {}, runs: {} }); return v; };
    const okBot = () => ({ health: 17, food: 18, oxygenLevel: 300, game: {}, entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 }, onGround: true }, nearestEntity: () => null });
    it('update() calls _sample() without try/catch, and _sample has no catch or ||-default', () => {
        const up = method('update');
        assert.ok(/this\._sample\(\);/.test(up));
        assert.ok(!/try\s*\{\s*this\._sample/.test(up));
        const sm = method('_sample');
        assert.ok(!/catch/.test(sm));
        assert.ok(!/\|\|\s*0\)/.test(sm), 'no (this._lastSample || 0) default');
        assert.ok(!/bot\?\.entity/.test(sm), 'no silent skip when the entity is missing');
    });
    it('missing bot.food (no update_health yet) throws instead of being logged and skipped', () => {
        const b = okBot(); delete b.food;
        assert.throws(() => mkV(b)._sample(), /bot\.food must be a number/);
    });
    it('a valid bot samples and feeds the learned regen model', () => {
        const b = okBot(), v = mkV(b);
        v._sample();
        v._lastSample -= 1000; b.health = 18; v._sample();
        assert.strictEqual(v._samples.length, 2);
        assert.deepStrictEqual(v.vitals.s.regen[18], { n: 1, up: 1 });
    });
});

describe('fix59 (4): hp/food max from VITALS_MAX everywhere', () => {
    it('no literal /20 or 0-20 vitals max left in voyager.js or !stats', () => {
        const code = strip(VSRC);
        assert.ok(!/\}\/20\b|\(20\/20|0-20\)|hp: 20, food: 20/.test(code));
        const q = strip(readFileSync(new URL('../src/agent/commands/queries.js', import.meta.url), 'utf8'));
        assert.ok(!/\/ 20`/.test(q));
    });
    it('contract spec states the range from VITALS_MAX', () => {
        assert.ok(Voyager.CONTRACT_SPEC.includes(`hp (0-${skills.VITALS_MAX.health}), food (0-${skills.VITALS_MAX.food})`));
        assert.ok(Voyager.CONTRACT_SPEC.includes('free (empty inventory slots)'));
    });
    it('curriculum prompt uses the bot\'s vitals max (a non-vanilla max shows through)', async () => {
        const saved = { ...skills.VITALS_MAX };
        skills.VITALS_MAX.health = 40; skills.VITALS_MAX.food = 30;
        try {
            const v = Object.create(Voyager.prototype);
            v.vitals = new VitalsModel({ regen: {}, runs: {} });
            v.agent = { name: 'icefox2000', bot: { health: 17, food: 12, game: {} } };
            v.skills = []; v.slotEffects = new SlotEffects({ runs: {} });
            v.progress = { completed: [], failed: [], blockers: [] };
            v.repairMemory = { getWorkflowsForTask: () => [], formatWorkflowHints: () => '' };
            v._hutBuilt = () => false; v._cursorLimited = () => false; v._logPromptBreakdown = () => {}; v._saveProgress = () => {};
            let prompt = null;
            v._askLocal = async (sys, user) => { prompt = user; return '{"reasoning":"r","task":"eatFood","context":""}'; };
            await v.proposeTask({ position: '0, 32, 0', biome: 'plains', time: 'day (1)', health_value: 17, health_max: 40, food_value: 12, food_max: 30, inventory_slots: '1/36', empty_inventory_slots: 35, threats: 'none', inventory: {}, equipment: { hand: 'empty' } });
            assert.match(prompt, /current_health: 17\/40\ncurrent_food: 12\/30 \(30\/30 = full\)/);
        } finally { Object.assign(skills.VITALS_MAX, saved); }
    });
});

describe('fix59 (3b): a dead update loop exits the process non-zero (no silent stall)', () => {
    // process.exit is stubbed to record the code and stop the caller, as a real exit would
    const withExit = async (fn) => {
        const realExit = process.exit, realErr = console.error, lines = []; let code = null;
        process.exit = (c) => { code = c; throw new Error('__exit__'); };
        console.error = (...a) => lines.push(a.join(' '));
        try { await fn(); } catch (e) { if (e.message !== '__exit__') throw e; } finally { process.exit = realExit; console.error = realErr; }
        return { code, lines };
    };
    it('runUpdateLoop rejects with the error update() threw (it does not swallow or keep looping)', async () => {
        let n = 0;
        await assert.rejects(runUpdateLoop(async () => { if (++n === 3) throw new Error('boom in update'); }, 0), /boom in update/);
        assert.strictEqual(n, 3);
    });
    it('fatalExit logs the stack loudly and exits 1', async () => {
        const { code, lines } = await withExit(async () => fatalExit('icefox2000', 'update loop', new Error('bot.food must be a number')));
        assert.strictEqual(code, 1);
        assert.ok(lines.some(l => /\[fatal\] update loop; agent cannot act, exiting 1: Error: bot\.food must be a number\n\s+at /.test(l)));
    });
    it('a _sample error inside the update loop ends in exit 1 (the flagged risk)', async () => {
        const v = Object.create(Voyager.prototype);
        v.agent = { bot: { health: 17, oxygenLevel: 300, game: {}, entity: { position: { x: 0, y: 64, z: 0 } } } };   // no bot.food
        v.vitals = new VitalsModel({ regen: {}, runs: {} });
        const { code, lines } = await withExit(() => runUpdateLoop(async () => v.update(), 0).catch(e => fatalExit('icefox2000', 'update loop', e)));
        assert.strictEqual(code, 1);
        assert.ok(lines.some(l => /\[fatal\] update loop;.*bot\.food must be a number/.test(l)));
    });
    it('agent.js wires the loop to the fatal exit; no inline swallowing loop', () => {
        const a = strip(readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8'));
        assert.match(a, /runUpdateLoop\(\(delta\) => this\.update\(delta\), INTERVAL\)\.catch\(e => this\.fatal\('update loop', e\)\)/);
        assert.match(a, /fatal\(where, err\) \{ fatalExit\(this\.name, where, err\); \}/);
        assert.ok(!/while \(true\)/.test(a));
        const f = strip(readFileSync(new URL('../src/agent/fatal.js', import.meta.url), 'utf8'));
        assert.ok(!/catch/.test(f) && /process\.exit\(1\)/.test(f));
    });
    it('uncaught error outside a task step is fatal; inside a step it fails and stops that step only', () => {
        const calls = [];
        const mk = (running) => { const v = Object.create(Voyager.prototype); v.running = running; v.currentTask = 'Mine 1 iron_ore'; v.progress = { failed: [] }; v._saveProgress = () => calls.push('save');
            v.agent = { fatal: (w, e) => calls.push(`fatal:${w}:${e.message}`), bot: {}, actions: { stop: (src) => { calls.push(`stop:${src.kind}`); return Promise.resolve(); } } };
            v.agent.requestInterrupt = (src) => { calls.push(`interrupt:${src.kind}`); v.agent.bot.interrupt_code = true; }; return v; };   // fix75: sources recorded
        mk(false)._onProcessError('UNHANDLED REJECTION', new Error('stray'));
        assert.deepStrictEqual(calls, ['fatal:UNHANDLED REJECTION outside a task step:stray']);
        calls.length = 0;
        const v = mk(true), realErr = console.error; console.error = () => {};
        try { v._onProcessError('UNCAUGHT EXCEPTION', new Error('skill code')); } finally { console.error = realErr; }
        assert.deepStrictEqual(calls, ['save', 'interrupt:process-error', 'stop:process-error']);
        assert.deepStrictEqual(v.progress.failed, ['Mine 1 iron_ore']);
        assert.strictEqual(v.agent.bot.interrupt_code, true);
    });
    it('the process guard has no empty catch and no optional-call on stop()', () => {
        const g = method('_onProcessError');
        assert.ok(!/catch/.test(g) && !/stop\?\./.test(g));
        const i = VSRC.indexOf('if (!globalThis.__voyagerGuard)'), guard = VSRC.slice(i, VSRC.indexOf('\n        }\n', i));
        assert.ok(/this\._onProcessError\(kind, err\)/.test(guard) && !/catch/.test(guard));
    });
});
