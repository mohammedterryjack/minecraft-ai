/**
 * fix92: a full inventory is a whole-slot capacity plan. Verified consumption that does not empty a slot
 * (dirt 24, keep 4) is not selected. A kind with a completed analysis and no use can be tossed. The goal's
 * drop, its tools and its direct recipe inputs stay reserved. A nested collectLogs > mineBlocks > collectBlock
 * slot failure is capacity work for that parent, then the parent is retried. Item loss that frees no slot
 * is not success.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capacityPlan, inventoryStacks, emptySlotsToFit, stackableCounts, placeCounts } from '../src/agent/slot_room.js';
import { obtainPlanner } from '../src/agent/recipe_plan.js';
import { SlotEffects } from '../src/agent/slot_effects.js';
import { roomForItem } from '../src/agent/library/world.js';
import { _freeInventory } from '../src/agent/library/skills.js';
import { Coder } from '../src/agent/coder.js';

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

const none = { runs: 1, items: {} };
function ev(items) { return { runs: 1, items }; }
function analysed(name, consume = {}) {
    return {
        name,
        code: `async function ${name}(bot) { return true; }`,
        task: name,
        effects: [],
        consumes: {},
        stats: { success: 1, fail: 0 },
        consumeEvidence: ev(consume),
    };
}
function planner() {
    return obtainPlanner({ registry, recipesOf: id => Recipe.find(id), known: () => false, proven: () => false, edgeSuccess: () => 1, smeltInputs: () => [], present: () => false });
}
function args(stacks, slotsNeeded, goalItem, goalCount, needItem, skills) {
    const p = planner();
    return {
        registry, skills, stacks, slotsNeeded, goalItem, goalCount, needItem,
        prerequisites: (item, count, inv) => p.prerequisites(item, count, inv),
        toolsNeeded: item => p.toolsNeeded(item, {}),
        recipesOf: id => Recipe.find(id),
    };
}
function capture(fn) {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.map(x => String(x)).join(' ')); };
    try { return { result: fn(), lines }; }
    finally { console.log = orig; }
}
function sync(bot, inv) {
    const placed = placeCounts(registry, inv);
    bot.inventory.slots = placed.slots;
    bot.inventory.inventoryStart = placed.inventoryStart;
    bot.inventory.inventoryEnd = placed.inventoryEnd;
    bot.inventory.emptySlotCount = () => {
        let n = 0;
        for (let i = bot.inventory.inventoryStart; i < bot.inventory.inventoryEnd; i++) if (bot.inventory.slots[i] == null) n += 1;
        return n;
    };
    bot.inventory.items = () => bot.inventory.slots.filter(s => s != null);
}

const TOSS_POST = { pre: 'c => true', post: 'c => c.post.free > c.pre.free', text: 'empty slots increase' };
function tossSkill() {
    return {
        name: 'tossClutter',
        code: 'async function tossClutter(bot, slotsNeeded, plan) { return true; }',
        task: 'tossClutter',
        effects: [],
        consumes: {},
        consumeEvidence: none,
        contract: TOSS_POST,
    };
}
function host(inv, skills, nearby = ['oak_log']) {
    const bot = {
        version: VER,
        registry,
        recipesAll: id => Recipe.find(id),
        inventory: {},
        output: '',
        __psnOut: '',
        interrupt_code: false,
        currentWindow: null,
        entity: { position: { x: 0, y: 64, z: 0 } },
        openChat() {},
    };
    sync(bot, inv);
    const v = Object.create(Voyager.prototype);
    v.agent = { bot, openChat() {} };
    v.skills = skills;
    v.progress = { subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], recipeEdges: {}, goalStats: {}, goalFailStates: [], failedRepairSigs: {} };
    v.slotEffects = new SlotEffects({ runs: {} });
    v._saveProgress = () => {};
    v._saveSkills = () => {};
    v._curSub = null;
    v._repairQueue = [];
    v._lastRunTimedOut = false;
    v.observe = () => ({ inventory: stackableCounts(bot), nearby_blocks: [...nearby], empty_inventory_slots: bot.inventory.emptySlotCount() });
    v._learnRunDurations = () => {};
    v._checkContracts = () => {};
    v._learnVitalsEffects = () => {};
    v._learnSlotEffects = () => {};
    v._diedInRun = () => null;
    v._stalledInRun = () => null;
    v._crashedInRun = () => null;
    return v;
}
function frame(name, parent, depth, ok, extra = {}) {
    return { name, parent, depth, ok, intr: false, fail: !ok, err: null, ownFail: [], o0: 0, o1: 0, args: '[]', ret: ok ? 'true' : 'false', t0: 1, t1: 2, ...extra };
}

describe('fix92: whole-slot plan', () => {
    it('dirt 24 kept at 4 frees no slot and is not selected', () => {
        const stacks = [{ slot: 9, name: 'dirt', count: 24 }];
        const { result, lines } = capture(() => capacityPlan(args(stacks, 1, 'oak_log', 1, 'oak_log', [analysed('dig', { dirt: { runs: 1, max: 4 } })])));
        assert.strictEqual(result.freed, 0);
        assert.deepStrictEqual(result.removals, []);
        const line = lines.find(l => l.includes('item=dirt'));
        assert.match(line, /keep=4/);
        assert.match(line, /provenance=learned/);
        assert.match(line, /remove=20/);
        assert.match(line, /predicted_freed=0 rejected/);
        const effects = new SlotEffects({ runs: {} });
        assert.strictEqual(effects.noteRun('tossClutter', { free: 0 }, { free: 0 }).freed, 0);
    });

    it('a fully analysed kind with no use frees a slot, and the oak_log chain stays', () => {
        const stacks = [{ slot: 9, name: 'dirt', count: 64 }, { slot: 10, name: 'oak_log', count: 32 }];
        const { result, lines } = capture(() => capacityPlan(args(stacks, 1, 'oak_log', 1, 'oak_log', [analysed('idle')])));
        assert.deepStrictEqual(result.removals.map(r => r.item), ['dirt']);
        assert.strictEqual(result.removals[0].remove, 64);
        assert.strictEqual(result.freed, 1);
        const oak = lines.find(l => l.includes('item=oak_log'));
        assert.match(oak, /keep=32/);
        assert.match(oak, /provenance=goal/);
        assert.match(oak, /predicted_freed=0 rejected/);
        assert.doesNotMatch(capacityPlan.toString(), /['"](?:dirt|oak_log|diamond|cobblestone|iron_axe|oak_planks)['"]/);
    });

    it('equipment, a held harvest tool, and the active recipe input stay reserved', () => {
        const axe = [{ slot: 9, name: 'iron_axe', count: 1 }, { slot: 10, name: 'oak_planks', count: 2 }, { slot: 11, name: 'dirt', count: 64 }];
        const sticks = capacityPlan(args(axe, 1, 'stick', 4, 'stick', [analysed('swing', { iron_axe: { runs: 1, max: 1 } })]));
        assert.deepStrictEqual(sticks.removals.map(r => r.item), ['dirt']);
        const plank = sticks.candidates.find(c => c.item === 'oak_planks');
        assert.strictEqual(plank.keep, 2);
        assert.match(plank.provenance, /game-data/);
        const tool = sticks.candidates.find(c => c.item === 'iron_axe');
        assert.strictEqual(tool.keep, 1);
        assert.strictEqual(tool.provenance, 'learned');
        const ore = [{ slot: 9, name: 'stone_pickaxe', count: 1 }, { slot: 10, name: 'dirt', count: 64 }];
        const mined = capacityPlan(args(ore, 1, 'iron_ore', 1, 'iron_ore', [analysed('idle')]));
        assert.deepStrictEqual(mined.removals.map(r => r.item), ['dirt']);
        assert.strictEqual(mined.candidates.find(c => c.item === 'stone_pickaxe').keep, 1);
    });

    it('capacityPlan with mineBlocks-shaped data does not throw incomplete useEvidence', () => {
        const idx = JSON.parse(readFileSync(join(import.meta.dirname, '../bots/icefox2000/skills/index.json'), 'utf8'));
        const mineBlocks = idx.find(s => s.name === 'mineBlocks');
        assert.ok(mineBlocks);
        assert.strictEqual(Object.hasOwn(mineBlocks, 'useEvidence'), false);
        const stacks = [{ slot: 9, name: 'cobblestone', count: 64 }];
        const live = capacityPlan(args(stacks, 1, 'cobblestone', 1, 'cobblestone', [mineBlocks]));
        assert.ok(live.candidates);
        const shaped = { name: 'mineBlocks', code: mineBlocks.code, task: 'mine blocks', description: mineBlocks.description };
        assert.doesNotThrow(() => capacityPlan(args(stacks, 1, 'cobblestone', 1, 'cobblestone', [shaped])));
        const missing = capacityPlan(args(stacks, 1, 'cobblestone', 1, 'cobblestone', [shaped]));
        assert.strictEqual(missing.candidates.find(c => c.item === 'cobblestone').keep, 64);
    });

    it('useEvidence is not a reserve; malformed consume evidence still throws', () => {
        const stacks = [{ slot: 9, name: 'diamond', count: 10 }];
        const stale = analysed('bare');
        stale.useEvidence = ev({ diamond: { runs: 1, max: 10 } });
        assert.throws(() => capacityPlan(args(stacks, 1, 'oak_log', 1, 'oak_log', [stale])), /useEvidence, which is not recorded/);
        const missing = analysed('bare');
        const open = capacityPlan(args(stacks, 1, 'oak_log', 1, 'oak_log', [missing]));
        assert.deepStrictEqual(open.removals.map(r => r.item), ['diamond']);
        const malformed = analysed('bare');
        malformed.consumeEvidence = { runs: 1, items: { diamond: { runs: 1 } } };
        assert.throws(() => capacityPlan(args(stacks, 1, 'oak_log', 1, 'oak_log', [malformed])), /incomplete consumeEvidence for bare item diamond: max/);
        const demoted = [{ name: 'old', demoted: true }, analysed('idle')];
        const plan = capacityPlan(args(stacks, 1, 'oak_log', 1, 'oak_log', demoted));
        assert.deepStrictEqual(plan.removals.map(r => r.item), ['diamond']);
    });

    it('selection spans stacks, skips a partial that cannot empty one, and a partial target stack needs no toss', () => {
        const keep = analysed('dig', { dirt: { runs: 1, max: 4 } });
        const many = [
            { slot: 9, name: 'dirt', count: 64 },
            { slot: 10, name: 'dirt', count: 64 },
            { slot: 11, name: 'dirt', count: 10 },
        ];
        const one = capacityPlan(args(many, 1, 'oak_log', 1, 'oak_log', [keep]));
        assert.strictEqual(one.removals.length, 1);
        assert.strictEqual(one.removals[0].remove, 10);
        assert.deepStrictEqual(one.removals[0].stacks, [{ slot: 11, count: 10 }]);
        const neither = [{ slot: 9, name: 'dirt', count: 30 }, { slot: 10, name: 'dirt', count: 40 }];
        const blocked = capacityPlan(args(neither, 1, 'oak_log', 1, 'oak_log', [analysed('dig', { dirt: { runs: 1, max: 50 } })]));
        assert.strictEqual(blocked.freed, 0);
        assert.strictEqual(blocked.candidates[0].potential, 0);
        const eggs = [
            { slot: 9, name: 'dragon_egg', count: 1, metadata: 0 },
            { slot: 10, name: 'dragon_egg', count: 1, metadata: 1 },
        ];
        const worn = capacityPlan(args(eggs, 1, 'oak_log', 1, 'oak_log', [analysed('keep', { dragon_egg: { runs: 1, max: 1 } })]));
        assert.strictEqual(worn.removals[0].remove, 1);
        assert.deepStrictEqual(worn.removals[0].stacks, [{ slot: 9, count: 1 }]);
        const partial = { oak_log: 10 };
        const bot = { registry, inventory: {} };
        sync(bot, partial);
        assert.strictEqual(emptySlotsToFit(registry, stackableCounts(bot), 'oak_log', 1), 0);
        assert.deepStrictEqual(inventoryStacks(bot).map(s => s.count), [10]);
        const full = { oak_log: 10, dragon_egg: 35 * registry.itemsByName.dragon_egg.stackSize };
        const v = host(full, [tossSkill()]);
        const need = { item: 'oak_log', count: 1, reason: 'slot', source: 'reported by collectBlock', owner: 'collectBlock' };
        assert.strictEqual(v._chainNeeds('Chop 1 oak_log', [need], v.observe()), true);
        assert.deepStrictEqual(v.progress.subgoals.map(s => s.task), ['Chop 1 oak_log']);
        const ss = registry.itemsByName.oak_log.stackSize;
        const stuffed = { oak_log: 10 + 35 * ss };
        assert.ok(emptySlotsToFit(registry, stuffed, 'oak_log', ss) > 0);
    });
});

describe('fix92: nested capacity failure retries the blocked parent', () => {
    const fullDirt = () => ({ dirt: 36 * registry.itemsByName.dirt.stackSize });
    function chopTrace() {
        return [
            frame('collectLogs', -1, 0, false),
            frame('equipBestTool', 0, 1, true),
            frame('mineBlocks', 0, 1, false),
            frame('collectBlock', 2, 2, false, { reportedNeed: { item: 'oak_log', count: 1, reason: 'slot' } }),
            frame('equipToolForBlock', 2, 2, true),
            frame('pickupNearbyItems', 2, 2, true),
        ];
    }
    it('collectLogs > mineBlocks > collectBlock queues capacity work, skips repair, then the retry can gain a log', async () => {
        const v = host(fullDirt(), [analysed('idle'), tossSkill()]);
        const bot = v.agent.bot;
        assert.strictEqual(roomForItem(bot, 'oak_log'), 0);
        bot.__psnTrace = chopTrace();
        const lines = [];
        const orig = console.log;
        console.log = (...a) => { lines.push(a.map(x => String(x)).join(' ')); };
        let verdict;
        try { verdict = v._attribute('collectLogs', 'Chop 1 oak_log', false, {}, null); }
        finally { console.log = orig; }
        assert.strictEqual(verdict, undefined);
        assert.deepStrictEqual(v._repairQueue, []);
        assert.ok(lines.some(l => l.includes('[slot] capacity failure') && l.includes('owner=collectBlock') && l.includes('not a repair')));
        const trace = chopTrace();
        const needs = v._failureNeeds('Chop 1 oak_log', null, trace, v.observe());
        assert.deepStrictEqual(needs.map(n => ({ item: n.item, reason: n.reason, owner: n.owner })), [{ item: 'oak_log', reason: 'slot', owner: 'collectBlock' }]);
        assert.strictEqual(v._chainNeeds('Chop 1 oak_log', needs, v.observe()), true);
        const queued = v.progress.subgoals.map(s => s.task);
        assert.deepStrictEqual(queued, ['tossClutter', 'Chop 1 oak_log']);
        assert.strictEqual(v.progress.subgoals[1].retry, true);
        const req = v.progress.subgoals[0].slotRequest;
        assert.strictEqual(req.owner, 'collectBlock');
        assert.strictEqual(req.parent, 'Chop 1 oak_log');
        assert.ok(req.removals.length > 0);
        assert.ok(req.removals.every(r => r.item !== 'oak_log'));
        const before = stackableCounts(bot).oak_log;
        assert.strictEqual(before, undefined);
        const prim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'tossClutter');
        const toss = new Function(`return (${prim.code});`)();
        bot.closeWindow = () => {};
        bot.on = () => {};
        bot.off = () => {};
        bot.toss = async (type, _meta, n) => {
            let left = n;
            for (let i = 0; i < bot.inventory.slots.length; i++) {
                const s = bot.inventory.slots[i];
                if (!s || s.type !== type) continue;
                const take = s.count < left ? s.count : left;
                s.count -= take;
                left -= take;
                if (s.count === 0) bot.inventory.slots[i] = null;
                if (left === 0) return;
            }
            throw new Error('toss could not remove ' + n);
        };
        const gained = await toss(bot, req.slotsNeeded, req.removals);
        assert.ok(gained >= 1);
        assert.ok(roomForItem(bot, 'oak_log') >= 1);
        const parent = v.progress.subgoals[1];
        assert.strictEqual(parent.task, 'Chop 1 oak_log');
        assert.strictEqual(parent.retry, true);
        if (roomForItem(bot, 'oak_log') < 1) throw new Error('retry has no room for oak_log');
        const empty = bot.inventory.slots.findIndex((s, i) => i >= bot.inventory.inventoryStart && i < bot.inventory.inventoryEnd && s == null);
        const item = registry.itemsByName.oak_log;
        bot.inventory.slots[empty] = { name: item.name, type: item.id, count: 1, slot: empty };
        assert.ok(stackableCounts(bot).oak_log >= 1);
        const blocker = v.progress.blockers.find(b => b.reason === 'slot');
        assert.strictEqual(v._blockerSatisfied(blocker, { oak_log: 0 }), true);
    });

    it('a full stack of the goal item does not satisfy a slot blocker, and a nested non-slot need is not promoted', () => {
        const ss = registry.itemsByName.oak_log.stackSize;
        const v = host({ oak_log: ss, dragon_egg: 35 * registry.itemsByName.dragon_egg.stackSize }, [analysed('idle')]);
        const blocker = { item: 'oak_log', count: 1, reason: 'slot', task: 'Chop 1 oak_log' };
        assert.strictEqual(roomForItem(v.agent.bot, 'oak_log'), 0);
        assert.strictEqual(v._blockerSatisfied(blocker, { oak_log: ss }), false);
        v.agent.bot.inventory.slots[v.agent.bot.inventory.inventoryStart] = null;
        assert.strictEqual(v._blockerSatisfied(blocker, { oak_log: 0 }), true);
        const stick = [
            { name: 'mineBlocks', parent: -1, depth: 0 },
            { name: 'craftRecipe', parent: 0, depth: 1, reportedNeed: { item: 'stick', count: 3, reason: 'ingredients' } },
        ];
        const needs = v._failureNeeds('Collect 4 oak_planks', { kind: 'precondition', need: { item: 'stick', count: 3, reason: 'ingredients' } }, stick, v.observe());
        assert.ok(needs === null || needs.every(n => n.item !== 'stick' && n.reason !== 'slot'), JSON.stringify(needs));
        const swallowed = [
            frame('collectLogs', -1, 0, true),
            frame('collectBlock', 0, 1, false, { reportedNeed: { item: 'oak_log', count: 1, reason: 'slot' } }),
        ];
        assert.strictEqual(v._blockingSlotNeed(swallowed), null);
        const root = [{ name: 'collectBlock', parent: -1, depth: 0, reportedNeed: { item: 'oak_log', count: 1, reason: 'slot' } }];
        const rooted = v._failureNeeds('Collect 1 oak_log', null, root, v.observe());
        assert.strictEqual(rooted[0].owner, 'collectBlock');
        assert.strictEqual(rooted[0].reason, 'slot');
    });
});

describe('fix92: toss measures slots, and the seeded definition is revalidated', () => {
    it('item loss that frees no slot is not success, for the seed and for _freeInventory', async () => {
        const prim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'tossClutter');
        assert.ok(!prim.code.includes('__slotsNeeded'));
        assert.match(prim.code, /async function tossClutter\(bot, slotsNeeded, plan\)/);
        const fn = new Function(`return (${prim.code});`)();
        let count = 24;
        const lines = [];
        const orig = console.log;
        console.log = (...a) => { lines.push(a.join(' ')); };
        const bot = {
            interrupt_code: false,
            currentWindow: null,
            registry,
            inventory: {
                emptySlotCount: () => 0,
                items: () => [{ name: 'dirt', type: registry.itemsByName.dirt.id, count }],
            },
            async toss(_type, _meta, n) { count -= n; },
        };
        let ret;
        try { ret = await fn(bot, 1, [{ item: 'dirt', remove: 20, keep: 4 }]); }
        finally { console.log = orig; }
        assert.strictEqual(ret, false);
        assert.strictEqual(count, 4);
        assert.ok(lines.some(l => l === '[slot] verified empty_before=0 empty_after=0 actual_freed=0'));
        const post = new Function('c', `return (${prim.contract.post})(c);`);
        assert.strictEqual(post({ pre: { free: 0 }, post: { free: 0 } }), false);
        let helperCount = 24;
        const helperLines = [];
        console.log = (...a) => { helperLines.push(a.join(' ')); };
        const helper = {
            interrupt_code: false,
            registry,
            inventory: {
                emptySlotCount: () => 0,
                items: () => [{ name: 'dirt', type: registry.itemsByName.dirt.id, count: helperCount }],
            },
            async toss(_type, _meta, n) { helperCount -= n; },
        };
        let helperRet;
        try { helperRet = await _freeInventory(helper, 1, [{ item: 'dirt', remove: 20, keep: 4 }]); }
        finally { console.log = orig; }
        assert.strictEqual(helperRet, false);
        assert.strictEqual(helperCount, 4);
        assert.ok(helperLines.some(l => l.includes('actual_freed=0')));
    });

    it('a toss that empties stacks across the kind returns the slots gained', async () => {
        const prim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'tossClutter');
        const fn = new Function(`return (${prim.code});`)();
        let empty = 0;
        const stacks = [{ name: 'dirt', type: registry.itemsByName.dirt.id, count: 64 }, { name: 'dirt', type: registry.itemsByName.dirt.id, count: 10 }];
        const calls = [];
        const bot = {
            interrupt_code: false,
            currentWindow: null,
            registry,
            inventory: {
                emptySlotCount: () => empty,
                items: () => stacks.filter(s => s.count > 0),
            },
            async toss(_type, _meta, n) {
                calls.push(n);
                let left = n;
                for (const s of stacks) {
                    const take = s.count < left ? s.count : left;
                    s.count -= take;
                    left -= take;
                    if (s.count === 0) empty += 1;
                }
            },
        };
        const ret = await fn(bot, 2, [{ item: 'dirt', remove: 74, keep: 0, stacks: [{ slot: 9, count: 64 }, { slot: 10, count: 10 }] }]);
        assert.deepStrictEqual(calls, [74]);
        assert.strictEqual(ret, 2);
        assert.strictEqual(empty, 2);
    });

    it('a fresh bot without __slotsNeeded lints the seeded toss, and a read of __slotsNeeded does not', () => {
        const name = '__fix92_lint__';
        const bot = {
            registry,
            inventory: { slots: [], items() { return []; }, emptySlotCount() { return 0; } },
            interrupt_code: false,
            currentWindow: null,
            closeWindow() {},
            on() {},
            off() {},
            async toss() {},
            entity: {},
        };
        assert.strictEqual(Object.hasOwn(bot, '__slotsNeeded'), false);
        const coder = new Coder({ name, bot });
        try {
            const prim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'tossClutter');
            const ok = coder.userGeneratedCodeLintBlockers(`${prim.code}\nawait tossClutter(bot, 1, []);`, []);
            assert.strictEqual(ok, null);
            const bad = coder.userGeneratedCodeLintBlockers('async function tossClutter(bot) {\n    return bot.__slotsNeeded;\n}\nawait tossClutter(bot);', []);
            assert.match(bad, /__slotsNeeded/);
        } finally {
            rmSync(`./bots/${name}`, { recursive: true, force: true });
        }
    });

    it('reheal replaces a persisted item-loss tossClutter and leaves an unrelated skill', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix92-'));
        try {
            const v = Object.create(Voyager.prototype);
            v.dir = dir;
            v._needsReheal = new Set();
            v._saveSkills = () => { v.saved = true; };
            const old = 'async function tossClutter(bot, minFree = 4) { const need = bot.__slotsNeeded; return need; }';
            v.skills = [
                {
                    name: 'tossClutter',
                    code: old,
                    deps: ['moveAway', 'depositToChest'],
                    description: 'old',
                    seeded: true,
                    stats: { success: 3, fail: 1 },
                    contract: { pre: 'c => true', post: 'c => !c.ret || Object.keys(c.delta).some(k => (c.delta[k]||0) < 0)', text: 'success removes inventory stacks' },
                },
                { name: 'unrelated', code: 'async function unrelated(bot) { return true; }', stats: { success: 9, fail: 0 } },
            ];
            v._seedPrimitives();
            const next = v.skills.find(s => s.name === 'tossClutter');
            const prim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'tossClutter');
            assert.strictEqual(next.code, prim.code);
            assert.ok(!next.code.includes('__slotsNeeded'));
            assert.match(next.code, /slotsNeeded, plan/);
            assert.strictEqual(next.contract.post, 'c => c.post.free > c.pre.free');
            assert.strictEqual(next.contract.seeded, true);
            assert.deepStrictEqual(next.deps, []);
            assert.strictEqual(next.stats.success, 3);
            assert.strictEqual(next.stats.fail, 1);
            const other = v.skills.find(s => s.name === 'unrelated');
            assert.strictEqual(other.code, 'async function unrelated(bot) { return true; }');
            assert.strictEqual(other.stats.success, 9);
            assert.ok(readFileSync(join(dir, 'tossClutter.js'), 'utf8').includes('slotsNeeded, plan'));
            assert.strictEqual(v.saved, true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
