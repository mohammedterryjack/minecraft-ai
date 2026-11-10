/**
 * fix84: a full inventory is a structured slot need (the same marker as chest proximity and the reach need),
 * chained through a learned slot-freeing skill or code-gen. A chest that needs logs that need a slot is broken
 * by a craft whose stack sizes free a slot, or thrown by name when nothing does. Surplus is verified consumption.
 * fix83's name-list check does not reject iron_shovel for iron_ore; harvestTools does.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as acorn from 'acorn';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsesAsScript } from '../src/agent/skill_graph.js';
import { loadManifest, applyManifest } from '../scripts/reset_bug_poisoned.js';
import { SlotEffects } from '../src/agent/slot_effects.js';
import { roomFor, placeCounts, bestSlotFreeingCraft, surplusFromConsumption } from '../src/agent/slot_room.js';
import { roomForItem } from '../src/agent/library/world.js';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(registry);
const has = (inv, k) => (Object.hasOwn(inv, k) ? inv[k] : 0);

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
});

function sync(bot, inv) {
    const placed = placeCounts(registry, inv);
    bot.inventory.slots = placed.slots;
    bot.inventory.inventoryStart = placed.inventoryStart;
    bot.inventory.inventoryEnd = placed.inventoryEnd;
}

function applyTask(task, inv, nearby, v) {
    if (task === 'tossClutter') {
        const req = v._curSub && v._curSub.slotRequest;
        if (!req || !Array.isArray(req.removals)) throw new Error('test world: tossClutter without a slot plan');
        for (const row of req.removals) {
            if (!Object.hasOwn(inv, row.item) || inv[row.item] < row.remove) throw new Error(`test world: cannot toss ${row.remove} ${row.item}`);
            inv[row.item] -= row.remove;
            if (inv[row.item] === 0) delete inv[row.item];
        }
        sync(v.agent.bot, inv);
        return { ok: true };
    }
    if (task === 'depositSurplus') {
        if (!nearby.includes('chest')) return { ok: false, reported: { kind: 'precondition', need: { item: 'chest', count: 1, reason: 'proximity' } } };
        const ss = registry.itemsByName.dragon_egg.stackSize;
        if (has(inv, 'dragon_egg') < ss) throw new Error('test world: depositSurplus found no full dragon_egg stack');
        inv.dragon_egg -= ss;
        if (inv.dragon_egg === 0) delete inv.dragon_egg;
        sync(v.agent.bot, inv);
        return { ok: true };
    }
    if (task === 'tossSurplus') {
        for (const s of surplusFromConsumption(v.skills, inv)) {
            inv[s.item] -= s.count;
            if (inv[s.item] === 0) delete inv[s.item];
        }
        sync(v.agent.bot, inv);
        return { ok: true };
    }
    if (task.startsWith('ensure ')) {
        const item = task.slice('ensure '.length);
        if (has(inv, item) < 1) return { ok: false, reported: { kind: 'precondition', need: { item, count: 1, reason: 'place' } } };
        inv[item] -= 1;
        if (inv[item] === 0) delete inv[item];
        nearby.push(item);
        sync(v.agent.bot, inv);
        return { ok: true };
    }
    const parts = task.split(' ');
    const verb = parts[0];
    const count = Number(parts[1]);
    const item = parts.slice(2).join('_');
    if (!registry.itemsByName[item] && !registry.blocksByName[item]) throw new Error(`test world: unknown task ${task}`);
    if (verb === 'Collect') {
        if (roomFor(registry, inv, item) < 1) return { ok: false, reported: { kind: 'precondition', need: { item, count, reason: 'slot' } } };
        inv[item] = has(inv, item) + count;
        sync(v.agent.bot, inv);
        return { ok: true };
    }
    if (verb === 'Craft') {
        if (!registry.itemsByName[item]) throw new Error(`test world: ${item} is not an item`);
        for (const rc of Recipe.find(registry.itemsByName[item].id)) {
            const times = Math.ceil(count / rc.result.count);
            const ings = rc.delta.filter(d => d.count < 0);
            if (!ings.every(d => has(inv, registry.items[d.id].name) >= -d.count * times)) continue;
            for (const d of ings) {
                const n = registry.items[d.id].name;
                inv[n] -= -d.count * times;
                if (inv[n] === 0) delete inv[n];
            }
            inv[item] = has(inv, item) + times * rc.result.count;
            sync(v.agent.bot, inv);
            return { ok: true };
        }
        return { ok: false, reported: { kind: 'precondition', need: { item, count, reason: 'ingredients' } } };
    }
    throw new Error(`test world: unknown task ${task}`);
}

function skill(name, extra = {}) {
    return {
        name,
        code: `async function ${name}(bot) { return true; }`,
        task: name,
        effects: [],
        consumes: {},
        contract: { pre: 'c => true', post: 'c => c.ret === true' },
        ...extra,
    };
}

function mkV({ inv, nearby, skills, runs }) {
    const bot = { version: VER, registry, recipesAll: id => Recipe.find(id), inventory: {}, openChat() {} };
    sync(bot, inv);
    const v = Object.create(Voyager.prototype);
    v.agent = { bot };
    v.skills = skills;
    v.npGraph = null;
    v.progress = { subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], recipeEdges: {}, goalStats: {}, slots: { runs } };
    v.slotEffects = new SlotEffects(v.progress.slots);
    v._saveProgress = () => {};
    v._windowCheck = () => {};
    v._afterSuccess = () => {};
    v._prefetchPlan = () => {};
    v._curSub = null;
    v.ran = [];
    v.observe = () => ({ inventory: { ...inv }, nearby_blocks: [...nearby], empty_inventory_slots: 0 });
    v._findReplay = task => ({ name: `route_${task.replace(/ /g, '_')}`, call: '' });
    v._structuredReplay = v._findReplay;
    v._embedReplay = async () => null;
    v._backchain = async () => null;
    v._replay = async (task) => {
        v.ran.push(task);
        const res = applyTask(task, inv, nearby, v);
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
        if (++guard > 80) throw new Error(`test: queue did not drain: ${v.progress.subgoals.map(s => s.task).join(' | ')} ran ${v.ran.join(' -> ')}`);
        v._curSub = null;
        const sub = v._subgoalTask();
        await v._pursueProposedTask(sub.task, sub, v.observe());
    }
}
const quiet = async f => { const o = console.log; console.log = () => {}; try { return await f(); } finally { console.log = o; } };

function evidence(items = {}) { return { runs: 1, items }; }

describe('fix84: a full inventory whose held kinds are reserved is broken by a slot-freeing craft', () => {
    const full = () => ({ coal: 1, stick: 1, dragon_egg: 34 * registry.itemsByName.dragon_egg.stackSize });
    it('reserved eggs, coal and sticks stay, and the torch craft (stack sizes) frees the slot for the log', async () => {
        const inv = full();
        const freeing = bestSlotFreeingCraft(registry, id => Recipe.find(id), inv);
        assert.ok(freeing && freeing.freed >= 1, 'the held coal and stick craft into one slot');
        const holder = skill('holds', {
            consumeEvidence: evidence({
                dragon_egg: { runs: 1, max: inv.dragon_egg },
                coal: { runs: 1, max: 1 },
                stick: { runs: 1, max: 1 },
            }),
        });
        const v = mkV({ inv, nearby: [], skills: [holder], runs: {} });
        await quiet(() => drive(v, 'Collect 1 oak_log'));
        assert.ok(v.ran.includes(freeing.task), v.ran.join(' -> '));
        assert.strictEqual(inv.dragon_egg, 34 * registry.itemsByName.dragon_egg.stackSize);
        assert.ok(has(inv, 'oak_log') >= 1);
        assert.ok(v.progress.completed.includes('Collect 1 oak_log'));
    });
    it('a plan that frees a slot but has no tossClutter throws instead of inventing an open task', async () => {
        const ss = registry.itemsByName.oak_log.stackSize;
        const inv = { oak_log: ss, dragon_egg: 35 * registry.itemsByName.dragon_egg.stackSize };
        const v = mkV({ inv, nearby: [], skills: [], runs: {} });
        await assert.rejects(
            quiet(() => v._pursueProposedTask('Collect 65 oak_log', { task: 'Collect 65 oak_log' }, v.observe())),
            /\[fix92\] LOUD: capacity plan frees \d+ slot\(s\) for oak_log but tossClutter is not in the library/,
        );
    });
});

describe('fix84: surplus counts are not a slot plan; the smaller emptyable stack is the one tossed', () => {
    it('verified cobblestone surplus stays in the old helper, and the slot plan tosses the smaller zero-reserve stack', async () => {
        const keep = 8;
        const inv = { cobblestone: 35 * registry.itemsByName.cobblestone.stackSize, diamond: 10 };
        const consumer = skill('useCobble', {
            consumeEvidence: { runs: 2, items: { cobblestone: { runs: 2, max: keep } } },
        });
        const toss = skill('tossClutter', {
            code: 'async function tossClutter(bot) { return true; }',
            consumeEvidence: evidence(),
            contract: { pre: 'c => true', post: 'c => c.post.free > c.pre.free', text: 'empty slots increase' },
        });
        const surplus = surplusFromConsumption([consumer, toss], inv);
        assert.deepStrictEqual(surplus.map(s => s.item), ['cobblestone']);
        assert.strictEqual(surplus[0].count, inv.cobblestone - keep);
        const v = mkV({ inv, nearby: ['oak_log'], skills: [consumer, toss], runs: {} });
        await quiet(() => drive(v, 'Collect 1 oak_log'));
        assert.ok(v.ran.includes('tossClutter'), v.ran.join(' -> '));
        assert.strictEqual(inv.cobblestone, 35 * registry.itemsByName.cobblestone.stackSize);
        assert.strictEqual(has(inv, 'diamond'), 0);
        assert.ok(has(inv, 'oak_log') >= 1);
        assert.ok(v.progress.completed.includes('Collect 1 oak_log'));
    });
});

describe('fix84: a full inventory with nothing that frees a whole slot throws', () => {
    it('36 reserved dragon eggs (no recipe) cannot collect a log', async () => {
        const inv = { dragon_egg: 36 * registry.itemsByName.dragon_egg.stackSize };
        assert.strictEqual(bestSlotFreeingCraft(registry, id => Recipe.find(id), inv), null);
        const holder = skill('holds', {
            consumeEvidence: evidence({ dragon_egg: { runs: 1, max: inv.dragon_egg } }),
        });
        const v = mkV({ inv, nearby: [], skills: [holder], runs: {} });
        await assert.rejects(quiet(() => drive(v, 'Collect 1 oak_log')), /\[fix92\] LOUD: no whole-slot plan frees 1 slot\(s\) for 1 oak_log/);
    });
});

describe('fix84: room counts partial stacks from stackSize', () => {
    it('a partial oak_log stack still has room; a window of other full stacks does not', () => {
        const ss = registry.itemsByName.oak_log.stackSize;
        const partial = { oak_log: 10 };
        const bot = { registry, inventory: placeCounts(registry, partial) };
        assert.strictEqual(roomForItem(bot, 'oak_log'), roomFor(registry, partial, 'oak_log'));
        assert.strictEqual(roomForItem(bot, 'oak_log'), 35 * ss + (ss - 10));
        const stuffed = { dragon_egg: 36 * registry.itemsByName.dragon_egg.stackSize };
        assert.strictEqual(roomForItem({ registry, inventory: placeCounts(registry, stuffed) }, 'oak_log'), 0);
        const almost = { oak_log: 10 + 35 * ss };
        assert.strictEqual(roomFor(registry, almost, 'oak_log'), ss - 10);
    });
    it('seeded collectBlock and pickupNearbyItems mark a slot need, and the reach marker is unchanged', () => {
        const collect = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'collectBlock').code;
        const pickup = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'pickupNearbyItems').code;
        assert.match(collect, /const sources = types\.filter\(t => Object\.hasOwn\(bot\.registry\.blocksByName, t\)\);/);
        assert.match(collect, /reason: 'reach'/);
        assert.match(collect, /roomForItem\(bot, dropItem\.name\) < 1/);
        assert.match(collect, /reason: 'slot'/);
        assert.match(pickup, /getDroppedItem\(\)/);
        assert.match(pickup, /reason: 'slot'/);
        for (const src of [collect, pickup]) assert.doesNotThrow(() => acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }));
        const bad = parsesAsScript('async function f(bot) {');
        assert.strictEqual(typeof bad, 'string');
        assert.match(bad, /Unexpected token/);
        assert.strictEqual(parsesAsScript('async function f(bot) { return true; }'), true);
    });
});

describe('fix84: harvestTools rejects iron_shovel for iron_ore; fix83\'s name-list check does not', () => {
    const LIVE = JSON.parse(readFileSync(new URL('../scripts/fix84_harvest_tool_manifest.json', import.meta.url), 'utf8'));
    const ct = LIVE.records[0].expect.contract;
    it('the manifest post is a single name, so contractNameLists is empty and _validContract names harvestTools', () => {
        const v = mkV({ inv: {}, nearby: [], skills: [], runs: {} });
        assert.deepStrictEqual(Voyager.contractNameLists(ct.pre), []);
        assert.deepStrictEqual(Voyager.contractNameLists(ct.post), []);
        assert.match(v._validContract(ct), /post expects 'iron_shovel' for block 'iron_ore', whose harvestTools are .*iron_pickaxe/);
        const ok = { pre: ct.pre, post: "c => c.ret === false || c.ret === null || (c.post.alive && c.post.eq.heldItem === 'iron_pickaxe')" };
        assert.strictEqual(v._validContract(ok), null);
        const tools = v._contractGame().harvestTools('iron_ore');
        assert.deepStrictEqual([...tools].sort(), ['diamond_pickaxe', 'iron_pickaxe', 'netherite_pickaxe', 'stone_pickaxe']);
        assert.strictEqual(v._contractGame().harvestTools('oak_log'), null);
        assert.match(Voyager.CONTRACT_SPEC, /c\.game\.harvestTools\(block\)/);
        assert.match(Voyager.CONTRACT_SPEC, /must not require a held or returned item that a named block's harvestTools omit/);
    });
    it('the reset manifest dry-run / apply deletes that contract and refuses a second apply', () => {
        const m = loadManifest(new URL('../scripts/fix84_harvest_tool_manifest.json', import.meta.url).pathname);
        assert.strictEqual(m.records.length, 1);
        assert.deepStrictEqual(m.records[0].delete, ['contract', 'contractTried']);
        assert.deepStrictEqual(m.records[0].set, {});
        const dir = mkdtempSync(join(tmpdir(), 'fix84-')); mkdirSync(join(dir, 'skills'));
        try {
            writeFileSync(join(dir, 'skills/index.json'), JSON.stringify([{ name: 'equipBestToolForIronOre', code: 'async function equipBestToolForIronOre(bot) { return "iron_shovel"; }', contract: ct, contractTried: 1 }]));
            writeFileSync(join(dir, 'skills/progress.json'), '{}');
            const dry = applyManifest({ manifest: m, botsDir: dir, apply: false, log: () => {} });
            assert.strictEqual(dry.dryRun, true);
            assert.strictEqual(dry.changes.filter(c => c.op === 'delete').length, 2);
            applyManifest({ manifest: m, botsDir: dir, apply: true, log: () => {} });
            const after = JSON.parse(readFileSync(join(dir, 'skills/index.json'), 'utf8'));
            assert.strictEqual(Object.hasOwn(after[0], 'contract'), false);
            assert.strictEqual(Object.hasOwn(after[0], 'contractTried'), false);
            assert.throws(() => applyManifest({ manifest: m, botsDir: dir, apply: false, log: () => {} }), /expect mismatch/);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
