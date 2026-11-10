// fix96 (live iMac, 9 Nov 2026):
//  1. No prompt text is ever cut. The fix94 cut (a prefix kept to fit a token estimate from a learned minimum chars-per-token
//     of 2.67, while the curriculum prompt's real density was ~3.8) is gone; Ollama's own silent truncate/shift are off.
//     The curriculum prompt was large because 44 of its 47 BLOCKERS belonged to goals that were no longer queued, and
//     every backed-off failure repeated the full state key; the breakdown log left half the prompt uncounted.
//  2. The food plan picked "Collect 1 apple" (86 of 86 runs failed) because an option's cost was a raw count; entity loot and
//     learned smelt edges were not options at all. ensureCraftingTable read only the oak_planks recipe of crafting_table.
//  3. The watchdog kills at 15:43 and 17:32 GMT: bot.findBlocks read all 4096 blocks of every single-state section (all
//     air, all stone) on every search (mineflayer treats a single-value container as a global palette), 15-17.6 s per miss.
//     The kill evidence did not say which call or which code; it now does.
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { obtainPlanner } from '../src/agent/recipe_plan.js';
import { edibleNames, entityDroppers, planFoodAcquisition } from '../src/agent/food_backchain.js';
import { logPromptBreakdown } from '../src/agent/prompt_utils.js';
import { describeApiArg } from '../src/utils/bot_api_timing.js';

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

// the live failure state of 9 Nov (underground, no logs, one stripped_cherry_wood)
const LIVE_INV = { andesite: 60, coal: 16, cobbled_deepslate: 5, cobblestone: 285, diorite: 105, dirt: 195, granite: 64, iron_helmet: 6, iron_ingot: 40, iron_sword: 1, jukebox: 1, music_disc_11: 1, oak_button: 1, oak_leaves: 6, oak_sapling: 14, raw_copper: 6, raw_iron: 82, shears: 1, stone_sword: 1, stripped_cherry_wood: 1, torch: 80 };
const LIVE_NEAR = ['andesite', 'coal_ore', 'cobblestone', 'copper_ore', 'diorite', 'dirt', 'granite', 'gravel', 'iron_ore', 'lapis_ore', 'stone'];

function mkV(progress) {
    const v = Object.create(Voyager.prototype);
    v.agent = { bot: { version: VER, registry, recipesAll: (id) => Recipe.find(id), inventory: { emptySlotCount: () => 1 } } };
    v.skills = [];
    v.progress = { subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], recipeEdges: {}, goalStats: {}, goalFailStates: [], ...progress };
    v._saveProgress = () => {};
    v._producers = () => [];
    return v;
}

describe('fix96 (1): the curriculum prompt holds only what is relevant, losslessly, and its log counts all of it', () => {
    it('a blocker whose goal is no longer queued is dropped; an open goal keeps its blocker', () => {
        const v = mkV({
            subgoals: [{ task: 'Collect 1 oak_log', retry: true }],
            blockers: [
                { item: 'torch', count: 395, reason: 'ingredients', task: 'If crafting fails, toss surplus low-value items', at: 1 },
                { item: 'coal', count: 79, reason: 'ingredients', task: 'Craft 316 torch', at: 2 },
                { anyOf: ['oak_log', 'birch_log'], count: 1, reason: 'reach', task: 'Collect 1 oak_log', at: 3 },
            ],
        });
        const line = v._blockerHint({});
        assert.strictEqual(line, '\nBLOCKERS (prioritize these - what failed goals lack): "Collect 1 oak_log" needs 1 one of oak_log, birch_log (reach)');
        assert.deepStrictEqual(v.progress.blockers.map(b => b.task), ['Collect 1 oak_log']);
    });

    it('the state key a failure repeats is named "the current state" when it is the current one (lossless), and kept otherwise', () => {
        const v = mkV({});
        const key = v._goalStateKey({ inventory: { dirt: 2 }, nearby_blocks: ['stone'] });
        const other = v._goalStateKey({ inventory: { dirt: 3 }, nearby_blocks: ['stone'] });
        const text = `Collect 1 apple (stale: backed off: failed in this state (x; state ${key}; posterior success 0.25))`;
        assert.strictEqual(v._withCurrentState(text, key), 'Collect 1 apple (stale: backed off: failed in this state (x; the current state; posterior success 0.25))');
        assert.strictEqual(v._withCurrentState(`y; state ${other}; z`, key), `y; state ${other}; z`);
        assert.throws(() => v._withCurrentState(undefined, key), /failure text must be a string/);
    });

    it('failed_in_this_state names the current state once, not once per row', () => {
        const state = { inventory: { dirt: 2 }, nearby_blocks: ['stone'] };
        const v = mkV({});
        const key = v._goalStateKey(state);
        v.progress.goalFailStates = [
            { task: 'Collect 1 apple', ok: false, reason: `no apple (state ${key})`, state: key },
            { task: 'Collect 1 oak_log', ok: false, reason: 'cannot break stone', state: key },
        ];
        v._stateCounts = () => ({ s: 0, f: 1 });
        const hint = v._sameStateFailureHint(state);
        assert.strictEqual(hint.split(key).length - 1, 1, hint);
        assert.match(hint, /"Collect 1 apple" failed because no apple \(the current state\)/);
        assert.match(hint, /"Collect 1 oak_log" failed because cannot break stone/);
    });

    it('the breakdown total is the text sent; what no section names is logged as framing; a short count throws', () => {
        const lines = [];
        const orig = console.log;
        console.log = (l) => lines.push(l);
        try {
            assert.strictEqual(logPromptBreakdown('curriculum', { system: 10, skills: 5 }, 20), 20);
        } finally { console.log = orig; }
        assert.deepStrictEqual(lines, ['[prompt] kind=curriculum total=20 chars: system=10 skills=5 framing=5']);
        assert.throws(() => logPromptBreakdown('curriculum', { system: 10, skills: 5 }, 12), /sent 12 chars but its sections add up to 15/);
        assert.throws(() => logPromptBreakdown('code', { system: -1 }), /non-negative integer/);
    });

    it('known skills carry their whole description (no 120-char cut)', () => {
        const v = mkV({});
        const description = 'Equip the best tool of toolType (pickaxe, axe, sword, shovel, hoe) in the inventory, ranked from game data by what it can harvest and how fast; returns the item name or null.';
        v.skills = [{ name: 'equipBestTool', description, seeded: true }];
        v.slotEffects = { effect: () => null };
        assert.deepStrictEqual(v._knownSkillsFacts(), [`equipBestTool: ${description}`]);
    });
});

describe('fix96 (2): the food plan weighs observed edge success, entity loot and learned smelt edges', () => {
    const planFor = (v, state) => {
        const planner = v._obtainPlanner(state);
        return planFoodAcquisition({
            edibles: edibleNames(registry), inventory: state.inventory,
            cheapest: (items, count, inv) => planner.cheapest(items, count, inv),
            prerequisites: (item, count, inv) => planner.prerequisites(item, count, inv),
            entityDroppersFor: item => entityDroppers(registry, item),
        });
    };
    it('86 failed "Collect 1 apple" runs make apple the costliest food, though oak_leaves are in sight', () => {
        const state = { inventory: { ...LIVE_INV }, nearby_blocks: [...LIVE_NEAR, 'oak_leaves'] };
        const fresh = mkV({});
        assert.strictEqual(fresh._obtainPlanner(state).prerequisites('apple', 1, state.inventory).how, 'collect');
        const learned = mkV({ recipeEdges: { apple: { task: 'Collect 1 apple', status: 'untried', runs: 86, fails: 86 } } });
        assert.strictEqual(learned._edgeSuccess('apple', 'collect'), 1 / 88);
        assert.strictEqual(learned._edgeSuccess('apple', 'craft'), 1, 'another verb is not this edge');
        const apple = learned._obtainPlanner(state).prerequisites('apple', 1, state.inventory);
        assert.deepStrictEqual(apple.cost, [0, 88, 88, 1]);
        const plan = planFor(learned, state);
        assert.notStrictEqual(plan.item, 'apple', JSON.stringify(plan));
    });

    it('an item only a mob drops is an obtain from the named entities, not an opaque obtain', () => {
        const v = mkV({});
        const beef = v._obtainPlanner({ inventory: {}, nearby_blocks: [] }).prerequisites('beef', 1, {});
        assert.strictEqual(beef.task, 'Obtain 1 beef');
        assert.deepStrictEqual(beef.from, ['cow', 'mooshroom']);
        assert.strictEqual(beef.cost[0], 0, 'not opaque');
    });

    it('a smelt goal that succeeded is a learned edge: cooked_beef is planned as beef, then the smelt', () => {
        const v = mkV({ goalStats: { 'Smelt 1 beef into 1 cooked_beef::': { success: 1, fail: 0 }, 'Smelt 3 raw_iron into 3 iron_ingot::': { success: 5, fail: 0 } } });
        const idx = v._learnedSmeltIndex();
        assert.deepStrictEqual([...idx.get('cooked_beef')], ['beef']);
        assert.deepStrictEqual([...idx.get('iron_ingot')], ['raw_iron']);
        const pre = v._obtainPlanner({ inventory: {}, nearby_blocks: [] }).prerequisites('cooked_beef', 1, {});
        assert.strictEqual(pre.task, 'Smelt 1 beef into 1 cooked_beef');
        assert.deepStrictEqual(pre.steps.map(s => s.task), ['Obtain 1 beef']);
        const none = mkV({});
        assert.strictEqual(none._obtainPlanner({ inventory: {}, nearby_blocks: [] }).prerequisites('cooked_beef', 1, {}).how, 'obtain');
        assert.throws(() => mkV({ goalStats: undefined })._learnedSmeltIndex(), /goalStats required/);
    });

    it('the data\'s dropChance is not read as a chance: raw_iron is mined, not crafted from a raw_iron_block', () => {
        const v = mkV({});
        const pre = v._obtainPlanner({ inventory: { stone_pickaxe: 1 }, nearby_blocks: ['iron_ore'] }).prerequisites('raw_iron', 1, { stone_pickaxe: 1 });
        assert.strictEqual(pre.how, 'collect');
    });

    it('a loot key that is not a block in this registry ("grass" in 1.20.4) is not a source', () => {
        assert.ok(Object.hasOwn(registry.blockLoot, 'grass') && !Object.hasOwn(registry.blocksByName, 'grass'));
        const v = mkV({});
        const p = v._obtainPlanner({ inventory: {}, nearby_blocks: [] });
        assert.ok(!p.sources('wheat_seeds').includes('grass'));
        assert.doesNotThrow(() => p.prerequisites('wheat_seeds', 1, {}));
    });

    it('the live state plans a crafting_table from the cherry wood it holds, not from oak logs', () => {
        const v = mkV({});
        const pre = v._obtainPlanner({ inventory: { ...LIVE_INV }, nearby_blocks: LIVE_NEAR }).prerequisites('crafting_table', 1, LIVE_INV);
        assert.deepStrictEqual(pre.plan, ['Craft 4 cherry_planks', 'Craft 1 crafting_table']);
    });
});

// the seeded ensureCraftingTable, run against real recipes and a simulated inventory
function runEnsureCraftingTable(inv) {
    const prim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'ensureCraftingTable');
    const logs = [], needs = [], crafted = [];
    const counts = () => Object.fromEntries(Object.entries(inv).filter(([, n]) => n > 0));
    const bot = {
        registry,
        recipesAll: (id) => Recipe.find(id),
        recipesFor: (id) => Recipe.find(id).filter(r => r.delta.filter(d => d.count < 0).every(d => (inv[registry.items[d.id].name] || 0) >= -d.count)),
        craft: async (r, times) => {
            for (const d of r.delta) { const n = registry.items[d.id].name; inv[n] = (inv[n] || 0) + d.count * times; }
            crafted.push(`${times}x ${registry.items[r.result.id].name}`);
        },
        blockAt: () => ({ name: 'crafting_table' }),
        interrupt_code: false,
    };
    const fn = new Function('getNearestBlock', 'getInventoryCounts', 'log', '__mcPreconditionUnmet__', 'getAllFreeSpaces', 'placeBlock',
        `${prim.code}\nreturn ensureCraftingTable;`)(
        () => null, () => counts(), (b, m) => logs.push(m), (b, d) => needs.push(d.need),
        () => [{ x: 0, y: 0, z: 0, floored() { return this; } }], async () => true);
    return { run: () => fn(bot), logs, needs, crafted };
}

describe('fix96 (2): ensureCraftingTable considers every crafting_table recipe', () => {
    it('one stripped_cherry_wood makes 4 cherry_planks and the table (live: "needs 4 more oak_planks ... no 2x2 recipe")', async () => {
        const inv = { stripped_cherry_wood: 1, cobblestone: 285 };
        const t = runEnsureCraftingTable(inv);
        assert.strictEqual(await t.run(), true, t.logs.join(' | '));
        assert.deepStrictEqual(t.crafted, ['1x cherry_planks', '1x crafting_table']);
        assert.deepStrictEqual(t.needs, []);
    });
    it('with no wood at all the need is 4 of any one plank type, named once, and the log says why', async () => {
        const t = runEnsureCraftingTable({ cobblestone: 285 });
        assert.strictEqual(await t.run(), false);
        assert.strictEqual(t.needs.length, 1);
        assert.strictEqual(t.needs[0].count, 4);
        assert.strictEqual(t.needs[0].reason, 'ingredients');
        assert.ok(t.needs[0].anyOf.includes('oak_planks') && t.needs[0].anyOf.includes('cherry_planks'), JSON.stringify(t.needs[0]));
        assert.match(t.logs.join(' | '), /none of the \d+ crafting_table recipes can be made from the inventory/);
        assert.doesNotMatch(t.logs.join(' | '), /no 2x2 recipe/);
    });
});

describe('fix96 (3): bot.findBlocks answers a single-state section from its one state', () => {
    function world() {
        const Chunk = require('prismarine-chunk')(VER);
        const { Vec3 } = require('vec3');
        const bot = new EventEmitter();
        bot._client = new EventEmitter();
        bot.registry = registry; bot.version = VER; bot.supportFeature = () => false;
        bot.game = { minY: -64, height: 384 };
        bot.entity = { position: new Vec3(0, 40, 0) };
        require('mineflayer/lib/plugins/blocks.js')(bot, { version: VER });
        bot._client.emit('login', { dimension: 'minecraft:overworld', worldName: 'minecraft:overworld' });
        const stone = registry.blocksByName.stone.defaultState, coal = registry.blocksByName.coal_ore.defaultState;
        for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) {
            const c = new Chunk({ minY: -64, worldHeight: 384 });
            for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = -64; y < 64; y++) {
                // y < 0: stone with coal (a palette); 0..63: all stone (one state); 64+: all air (one state)
                c.setBlockStateId(new Vec3(x, y, z), y < 0 && (x * 7 + y * 13 + z * 5) % 97 === 0 ? coal : stone);
            }
            bot.world.setColumn(cx, cz, c);
        }
        let reads = 0;
        const blockAt = bot.blockAt;
        bot.blockAt = (...a) => { reads++; return blockAt(...a); };
        return { bot, reads: () => reads, reset: () => { reads = 0; } };
    }
    it('a miss reads no block; a hit in a palette section still finds the nearest; a single-state match is found', () => {
        const w = world();
        assert.deepStrictEqual(w.bot.findBlocks({ matching: registry.blocksByName.cactus.id, maxDistance: 256, count: 1 }), []);
        assert.strictEqual(w.reads(), 0, 'every section was answered from its palette or its one state');
        w.reset();
        const coal = w.bot.findBlocks({ matching: registry.blocksByName.coal_ore.id, maxDistance: 64, count: 1 });
        assert.strictEqual(coal.length > 0, true);
        assert.strictEqual(w.bot.blockAt(coal[0]).name, 'coal_ore');
        const stone = w.bot.findBlocks({ matching: registry.blocksByName.stone.id, maxDistance: 2, count: 1 });
        assert.strictEqual(w.bot.blockAt(stone[0]).name, 'stone');
        const src = readFileSync(require.resolve('mineflayer/lib/plugins/blocks.js'), 'utf8');
        assert.match(src, /minecraft-ai fix96/, 'patches/mineflayer+4.39.0.patch is applied');
    });
});

describe('fix96 (3): a watchdog kill names the bot API call and the staged code', () => {
    it('describeApiArg shows a call\'s own primitive fields, never a deep or cyclic object', () => {
        const cyclic = { name: 'bot' }; cyclic.self = cyclic;
        assert.strictEqual(describeApiArg({ matching: 81, maxDistance: 512, count: 1 }), '{matching:81,maxDistance:512,count:1}');
        assert.strictEqual(describeApiArg(cyclic), '{name:"bot"}');
        assert.strictEqual(describeApiArg(function isCactus() {}), 'fn isCactus');
        assert.strictEqual(describeApiArg([1, { a: 1 }]), '[1,obj]');
    });
    it('blocked inside proxied findBlocks: watchdog_kill.json has the call with its maxDistance and the staged source', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix96-wd-'));
        const ev = join(dir, 'watchdog_kill.json');
        const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/fix96-watchdog-call-child.mjs', import.meta.url)), '200', ev], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d; });
        const signal = await new Promise(r => child.on('exit', (c, s) => r(s)));
        assert.strictEqual(signal, 'SIGKILL', stderr);
        assert.ok(existsSync(ev));
        const e = JSON.parse(readFileSync(ev, 'utf8'));
        assert.strictEqual(e.call, 'findBlocks({matching:81,maxDistance:512,count:1}) ctx=searchFar');
        assert.strictEqual(e.callUnreadBytes, 0);
        assert.strictEqual(e.code.label, 'fixture:voyager:exec');
        assert.match(e.code.source, /async function searchFar/);
        assert.match(stderr, /bot_api_call="findBlocks\(\{matching:81,maxDistance:512,count:1\}\) ctx=searchFar"/);
        rmSync(dir, { recursive: true, force: true });
    });
    it('the next process prints the kill once, with the code, and marks it reported', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fix96-rep-'));
        const ev = join(dir, 'watchdog_kill.json');
        const fs = require('node:fs');
        fs.writeFileSync(ev, JSON.stringify({ pid: 7, at: 'T', silentMs: 1, limitMs: 1, phases: ['p'], skill: 's', stack: 's', call: 'findBlocks({maxDistance:512})', callUnreadBytes: 0, code: { label: 'p', source: 'SRC', at: 'T' } }));
        const v = Object.create(Voyager.prototype);
        const errs = [];
        const orig = console.error;
        console.error = (l) => errs.push(l);
        try { v._reportWatchdogKill(ev); v._reportWatchdogKill(ev); } finally { console.error = orig; }
        assert.strictEqual(errs.length, 2, errs.join('\n'));
        assert.match(errs[0], /bot API call findBlocks\(\{maxDistance:512\}\)/);
        assert.match(errs[1], /staged code running at the kill \(p, staged T\):\nSRC/);
        assert.strictEqual(JSON.parse(readFileSync(ev, 'utf8')).reported, true);
        rmSync(dir, { recursive: true, force: true });
    });
});

// ---- fix96 reset: outcomes learned from the oak-only ensureCraftingTable failure ----
it('fix96 reset: the manifest takes every outcome with the oak-only failure text and deletes identical rows by count', async () => {
    const { buildManifest } = await import('../scripts/fix96_crafting_table_manifest.js');
    const { applyManifest } = await import('../scripts/reset_bug_poisoned.js');
    const fsm = await import('fs'); const osm = await import('os'); const pathm = await import('path');
    const bug = 'ensureCraftingTable: PREREQUISITE FAILED: ensureCraftingTable needs 4 more oak_planks but cannot craft it (no 2x2 recipe or missing sub-ingredients). Decompose to obtain oak_planks first. [food 4/20 health 16/20]';
    const row = { task: 'Collect 1 apple', ok: false, reason: bug, state: 'inv:stripped_cherry_wood:1' };
    const keep = { task: 'Collect 1 apple', ok: false, reason: 'failed 4x', state: 'inv:stripped_cherry_wood:1' };
    const progress = {
        goalStats: { [`Collect 1 apple::${bug}`]: { success: 0, fail: 2 }, 'Collect 1 apple::failed 4x': { success: 0, fail: 70 } },
        goalFailStates: [row, keep, { ...row }],
    };
    const m = buildManifest(progress, 'icefox2000', 'test');
    assert.deepEqual(m.records.map(r => r.id), ['goalStats.1', 'goalFailStates.1']);
    assert.equal(m.records[1].expect_count, 2);
    const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'fix96-reset-'));
    fsm.mkdirSync(pathm.join(dir, 'skills'));
    fsm.writeFileSync(pathm.join(dir, 'skills', 'index.json'), JSON.stringify({ skills: {} }));
    fsm.writeFileSync(pathm.join(dir, 'skills', 'progress.json'), JSON.stringify(progress));
    applyManifest({ manifest: m, botsDir: dir, apply: true, log: () => {} });
    const after = JSON.parse(fsm.readFileSync(pathm.join(dir, 'skills', 'progress.json'), 'utf8'));
    assert.deepEqual(after.goalStats, { 'Collect 1 apple::failed 4x': { success: 0, fail: 70 } });
    assert.deepEqual(after.goalFailStates, [keep]);
    // a count that moved since the manifest was built refuses
    fsm.writeFileSync(pathm.join(dir, 'skills', 'progress.json'), JSON.stringify(progress));
    assert.throws(() => applyManifest({ manifest: { ...m, records: [{ ...m.records[1], expect_count: 3 }] }, botsDir: dir, apply: false, log: () => {} }), /expect mismatch/);
    assert.throws(() => buildManifest({ goalStats: {}, goalFailStates: [keep] }, 'icefox2000', 'test'), /nothing to reset/);
});
