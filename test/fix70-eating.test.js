/**
 * fix70: icefox2000 could not eat (14:28Z death). [vitals] fired 89 times, hp fell to 8/20 at food 15, 0 eats, with
 * cooked_mutton 50 in the inventory. Every eatCookedMutton run logged "cooked_mutton present: 50" and then the seeded
 * consume said "You do not have any cooked_mutton to eat.". violated_contracts.jsonl (13:39:19Z) holds the state:
 * eq.offHand = cooked_mutton. Two faults, both in seeded/library code:
 *   1. mineflayer-auto-eat (mindcraft 44fe31a) was still loaded; fix18 disabled it only in the spawn handler after a 1 s wait,
 *      so on a restart at food <= 16 its 'health' listener equipped food to the OFF-HAND (its defaults) and left it there.
 *   2. consume/equip looked items up with findInventoryItem (slots 9-44) while getInventoryCounts counts slots 5-45.
 * And three learner faults that turned it into a demotion with no way back (see the describe blocks below).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Vec3 } from 'vec3';
import windows from 'prismarine-windows';
import Item from 'prismarine-item';
import minecraftData from 'minecraft-data';
import { plugin as autoEat } from 'mineflayer-auto-eat';
import { Coder } from '../src/agent/coder.js';
import { instrumentSrc, thrownIn } from '../src/agent/skill_graph.js';
import { findCarried } from '../src/utils/carried.js';
import * as world from '../src/agent/library/world.js';

const V = '1.20.4', W = windows(V), I = Item(V), reg = minecraftData(V);
const LIVE = JSON.parse(readFileSync(new URL('./fixtures/fix70-live-eat.json', import.meta.url), 'utf8'));
const NAME = '__fix70_test__';
after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));
let Voyager;
before(async () => { const mod = await import('../src/agent/voyager.js'); Voyager = mod.Voyager; mod._setVersionForTest('1.21.4'); });

/** The live 13:39:19Z inventory in a real player window: held iron_pickaxe (36), helmet worn (5), mutton in the off-hand (45). */
function liveWindow() {
    const inv = W.createWindow(0, 'minecraft:inventory', 'Inventory', 46);
    const st = LIVE.violated_13_39_19.pre;
    const put = (slot, name, n) => inv.updateSlot(slot, new I(reg.itemsByName[name].id, n));
    put(36, 'iron_pickaxe', 1); put(5, 'iron_helmet', 1); put(45, 'cooked_mutton', 50);
    let s = 9;
    for (const [name, total] of Object.entries(st.inv)) {
        let left = total - (name === 'iron_pickaxe' ? 1 : name === 'iron_helmet' ? 1 : name === 'cooked_mutton' ? 50 : 0);
        const size = reg.itemsByName[name].stackSize;
        while (left > 0) { if (s === 36) s = 37; const n = Math.min(size, left); put(s++, name, n); left -= n; }
    }
    return inv;
}
/** A bot over that window whose equip/consume move and eat items the way mineflayer does (equip via the slot, eat the held item). */
function liveBot(inv) {
    const bot = { output: '', interrupt_code: false, __psnALS: new AsyncLocalStorage(), inventory: inv, currentWindow: null, quickBarSlot: 0,
        health: 8.366666793823242, food: 15, oxygenLevel: 20, game: { dimension: 'overworld', gameMode: 'survival' }, entity: { position: new Vec3(-131.43, 47, 50.5) },
        blockAt: () => null, waitForTicks: async () => {}, closeWindow: async () => {},
        get heldItem() { return inv.slots[36 + bot.quickBarSlot]; },
        equip: async (item, dest) => { assert.strictEqual(dest, 'hand'); const src = item.slot, held = inv.slots[36]; inv.updateSlot(36, inv.slots[src]); inv.updateSlot(src, held); },
        consume: async () => { const h = bot.heldItem; const f = reg.foodsByName[h.name]; bot.food = Math.min(20, bot.food + f.foodPoints); h.count--; inv.updateSlot(36, h.count ? h : null); } };
    return bot;
}
async function mkCoder() {
    const coder = new Coder({ name: NAME });
    while (!coder.code_lint_template || !coder.code_template) await new Promise(r => setImmediate(r));
    return coder;
}
const skill = n => LIVE.skills.find(s => s.name === n);

describe('fix70: the seeded consume eats what getInventoryCounts says the bot has', () => {
    it('reproduces the live contradiction: counted 50, findInventoryItem finds none (off-hand slot 45)', () => {
        const inv = liveWindow(), bot = liveBot(inv);
        assert.strictEqual(LIVE.violated_13_39_19.pre.eq.offHand, 'cooked_mutton');
        assert.strictEqual(world.getInventoryCounts(bot).cooked_mutton, 50);
        assert.strictEqual(inv.findInventoryItem('cooked_mutton'), null, 'what consume searched before fix70 (slots 9-44)');
        assert.strictEqual(findCarried(bot, 'cooked_mutton').slot, 45);
    });
    it('the live eatCookedMutton, staged and traced as replayed at 13:40Z, now eats from the off-hand stack', async () => {
        const inv = liveWindow(), bot = liveBot(inv);
        const coder = await mkCoder();
        const lib = skill('checkInventoryForCookedMutton').code + '\n\n' + skill('eatCookedMutton').code;
        const staged = await coder._stageCode(lib + '\n\n' + instrumentSrc(['eatCookedMutton', 'checkInventoryForCookedMutton', 'consume']) + '\nawait eatCookedMutton(bot);', { lintOnly: false });
        await staged.func.main(bot);
        assert.doesNotMatch(bot.output, /You do not have any cooked_mutton/);
        assert.match(bot.output, /Consumed cooked_mutton \(food 15 -> 20\)/);
        assert.strictEqual(world.getInventoryCounts(bot).cooked_mutton, 49);
        const rec = bot.__psnTrace.find(r => r.name === 'eatCookedMutton');
        assert.deepStrictEqual(rec.delta, { cooked_mutton: -1 });
        const post = eval(skill('eatCookedMutton').contract.post);
        assert.strictEqual(post({ ret: undefined, pre: rec.s0, post: rec.s1, delta: rec.delta }), true, 'its learned post-contract holds');
    });
    it('every carried slot (5-45) is found by name exactly where it is counted, crafting grid (0-4) by neither', () => {
        for (let slot = 0; slot < 46; slot++) {
            const inv = W.createWindow(0, 'minecraft:inventory', 'Inventory', 46);
            inv.updateSlot(slot, new I(reg.itemsByName.bread.id, 3));
            const bot = { inventory: inv };
            const counted = world.getInventoryCounts(bot).bread === 3, found = !!findCarried(bot, 'bread');
            assert.strictEqual(found, counted, `slot ${slot}`);
            assert.strictEqual(counted, slot >= 5, `slot ${slot}`);
        }
    });
});

describe('fix70: the auto-eat reflex is gone', () => {
    it('with its defaults the plugin equips food to the OFF-HAND at food <= 16 and leaves it there (the live restarts at food 15)', async () => {
        const inv = W.createWindow(0, 'minecraft:inventory', 'Inventory', 46);
        inv.updateSlot(36, new I(reg.itemsByName.iron_pickaxe.id, 1)); inv.updateSlot(20, new I(reg.itemsByName.cooked_mutton.id, 50));
        const bot = new EventEmitter(); const dests = [];
        Object.assign(bot, { food: 15, inventory: inv, registry: reg, entity: { id: 1 }, _client: new EventEmitter(), supportFeature: () => false,
            getEquipmentDestSlot: d => (d === 'off-hand' ? 45 : 36), deactivateItem() {}, activateItem() { setImmediate(() => bot._client.emit('entity_status', { entityId: 1, entityStatus: 9 })); },
            equip: async (item, d) => { dests.push(d); const to = bot.getEquipmentDestSlot(d), from = item.slot; const was = inv.slots[to]; inv.updateSlot(to, inv.slots[from]); inv.updateSlot(from, was); } });
        autoEat(bot);
        assert.strictEqual(await bot.autoEat.eat(), true);
        assert.deepStrictEqual(dests, ['off-hand']);
        assert.strictEqual(inv.slots[45].name, 'cooked_mutton');
    });
    it('the plugin is not loaded and agent.js no longer touches it', () => {
        const mcdata = readFileSync(new URL('../src/utils/mcdata.js', import.meta.url), 'utf8');
        const agent = readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
        assert.doesNotMatch(mcdata, /from 'mineflayer-auto-eat'|loadPlugin\(autoEat\)/);
        assert.doesNotMatch(agent, /autoEat\./);
    });
});

describe('fix70: blame-aware accounting (where the throwing frame lives)', () => {
    const run = async (code, names, call, bot) => {
        const coder = await mkCoder();
        const staged = await coder._stageCode(code + '\n' + instrumentSrc(names) + '\n' + call, { lintOnly: false });
        await assert.rejects(staged.func.main(bot));
        return bot.__psnTrace;
    };
    const mkV = () => { const v = Object.create(Voyager.prototype); v.progress = {}; v._saveProgress = () => {}; return v; };
    it('thrownIn: compartment frames are staged code, module frames are library code', () => {
        assert.deepStrictEqual(thrownIn('    at eatCookedMutton (eval at <anonymous> (eval at makeEvaluate (file:///m/node_modules/ses/src/make-evaluate.js:92:27)), <anonymous>:12:31)'), { staged: true, fn: 'eatCookedMutton', loc: '<anonymous>:12:31' });
        assert.deepStrictEqual(thrownIn('    at consume (file:///m/src/agent/library/skills.js:1338:30)'), { staged: false, fn: 'consume', loc: 'file:///m/src/agent/library/skills.js:1338:30' });
        assert.throws(() => thrownIn(undefined), /not a stack frame/);
    });
    it('a TypeError raised in a learned skill (the 13:39Z candidate\'s "reading \'food\'") is the skill\'s own failure', async () => {
        const bot = liveBot(liveWindow());
        const code = skill('checkInventoryForCookedMutton').code + '\nasync function eatCookedMutton(bot) {\n    await checkInventoryForCookedMutton(bot);\n    const vitals = bot.vitals;\n    return vitals.food;\n}';
        const trace = await run(code, ['eatCookedMutton', 'checkInventoryForCookedMutton'], 'await eatCookedMutton(bot);', bot);
        const rec = trace.find(r => r.name === 'eatCookedMutton');
        assert.match(rec.err, /reading 'food'/);
        assert.strictEqual(thrownIn(rec.errTop).staged, true);
        const v = mkV();
        assert.strictEqual(v._libraryFault(trace, 'eatCookedMutton'), null);
        assert.deepStrictEqual(v.progress, {});
    });
    it('a TypeError raised inside a seeded primitive is counted against that primitive, not the learned caller', async () => {
        const inv = liveWindow(), bot = liveBot(inv);
        bot.equip = undefined;   // a library-side fault: the seeded consume calls bot.equip(...) and it is not a function
        const trace = await run('async function eatIt(bot) {\n    return await consume(bot, "cooked_mutton");\n}', ['eatIt', 'consume'], 'await eatIt(bot);', bot);
        const v = mkV();
        const w = v._libraryFault(trace, 'eatIt');
        assert.strictEqual(w.staged, false);
        assert.match(w.loc, /src\/agent\/library\/skills\.js:\d+:\d+$/);
        assert.deepStrictEqual(Object.values(v.progress.libraryFaults), [1]);
    });
    it('a failed candidate is never the evidence for repairing the incumbent (13:40Z -> 14:12Z repair)', () => {
        const v = Object.create(Voyager.prototype);
        v.skills = JSON.parse(JSON.stringify(LIVE.skills)); v.progress = {}; v.dir = `./bots/${NAME}`;
        v.agent = { bot: { inventory: { emptySlotCount: () => 1 } }, lastDeath: null };
        for (const k of ['_saveSkills', '_saveProgress', '_checkContracts', '_learnVitalsEffects', '_learnSlotEffects']) v[k] = () => {};
        v._runStart = Date.now() - 5; v._stall = null; v._lastRunMsg = '';
        const out = "\nFAILED: eatCookedMutton threw Cannot read properties of undefined (reading 'food')\n";
        v.agent.bot.__psnOut = out;
        v.agent.bot.__psnTrace = [
            { name: 'eatCookedMutton', args: '[]', parent: -1, depth: 0, o0: 0, o1: out.length, t0: 1, t1: 2, intr: false, fail: true, err: "Cannot read properties of undefined (reading 'food')", errTop: '    at eatCookedMutton (eval at <anonymous> (eval at makeEvaluate (file:///m/ses/make-evaluate.js:92:27)), <anonymous>:9:20)', delta: {} },
            { name: 'checkInventoryForCookedMutton', args: '[]', parent: 0, depth: 1, o0: 0, o1: 0, t0: 1, t1: 2, intr: false, ret: 'true', rv: true, fail: false, delta: {} },
        ];
        const lines = []; const log = console.log; console.log = (...a) => lines.push(a.join(' '));
        try { v._attribute('eatCookedMutton', 'eatCookedMutton', false, { eatCookedMutton: skill('eatCookedMutton').candidate.code }); } finally { console.log = log; }
        assert.ok(!(v._repairQueue || []).length, 'no repair of the incumbent queued from the candidate\'s TypeError');
        assert.ok(lines.some(l => /blame of eatCookedMutton is its candidate's trial failure/.test(l)), lines.join('\n'));
    });
});

describe('fix70: a demoted skill comes back only through its candidate\'s trials', () => {
    const mk = (skills) => { const v = Object.create(Voyager.prototype); v.skills = JSON.parse(JSON.stringify(skills)); v.progress = { completed: [], failed: [], goalStats: {}, fix25: true }; v._saveProgress = () => {}; v._saveSkills = () => {}; return v; };
    it('the live demoted eatCookedMutton with its pending candidate is a valid skill goal (the gate trial was refused every 5 min)', () => {
        assert.strictEqual(mk(LIVE.skills)._resolveGoal('eatCookedMutton').kind, 'skill');
    });
    it('a demoted skill without a candidate stays an invalid goal', () => {
        const s = JSON.parse(JSON.stringify(LIVE.skills)); delete s.find(x => x.name === 'eatCookedMutton').candidate;
        assert.match(mk(s)._resolveGoal('eatCookedMutton').why, /is demoted/);
    });
});
