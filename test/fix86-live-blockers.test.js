/**
 * fix86 (live icefox2000, d4b44e7, 6 Nov ~20:17-21:07 GMT).
 * The collect matcher read position on mineflayer's palette probe (position null). A torch craft of the count
 * already held was multiplied by the recipe yield and then by the held count. Recipe cycles overflowed the stack.
 * Contracts called methods the snapshot does not have. A reach goal died on duplicate replies before any search.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkCraftNeeds } from '../src/agent/library/world.js';
import { markPreconditionUnmet, peekPreconditionUnmet } from '../src/agent/precondition.js';
import { PRECONDITION_UNMET_BINDING } from '../src/agent/coder.js';
import { markerCallsMissing } from '../src/agent/skill_graph.js';
import { loadManifest, applyManifest } from '../scripts/reset_bug_poisoned.js';
import { obtainPlanner } from '../src/agent/recipe_plan.js';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(VER);
let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
});

const LIVE_INV = { cobblestone: 379, raw_iron: 114, torch: 79 };

describe('fix86: findBlocks palette probe has no position', () => {
    it('the seeded collectBlock matcher matches a type with position null and still excludes a placed block', () => {
        const src = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'collectBlock').code;
        let pred = null;
        const getNearestBlocksWhere = (_bot, p) => { pred = p; return []; };
        const fn = new Function('getNearestBlocksWhere', 'getInventoryCounts', 'log', '__mcPreconditionUnmet__', 'goToPosition', 'goToReachBlock', 'breakBlockAt', 'equipToolForBlock', 'mineflayer',
            `${src}\nreturn collectBlock;`);
        const bot = {
            registry,
            inventory: { items: () => [], emptySlotCount: () => 4 },
            entity: { position: { x: -125, y: 43, z: 61 } },
            blockAt: () => null,
        };
        const collect = fn(getNearestBlocksWhere, () => ({ ...LIVE_INV }), () => {}, markPreconditionUnmet, () => {}, () => {}, () => {}, () => {}, {});
        return collect(bot, 'coal', 1).then(() => {
            assert.strictEqual(typeof pred, 'function');
            assert.strictEqual(pred({ name: 'coal_ore', position: null }), true);
            assert.strictEqual(pred({ name: 'oak_log', position: null }), false);
            const placed = { name: 'coal_ore', position: { x: 1, y: 2, z: 3 } };
            assert.strictEqual(pred(placed), true);
            assert.doesNotThrow(() => pred({ name: 'stone', position: null }));
        });
    });
});

describe('fix86: a craft of the count already held is not a shortfall of crafts', () => {
    it('craftRecipe(torch, 79) with 79 torches held does not report 316', async () => {
        const src = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'craftRecipe').code;
        const out = [];
        const bot = { registry, recipesFor: () => [], recipesAll: id => Recipe.find(id) };
        const fn = new Function('log', 'getInventoryCounts', '__mcPreconditionUnmet__', 'getNearestBlock', 'ensureCraftingTable', 'collectBlock', 'goToReachBlock',
            `${src}\nreturn craftRecipe;`)((_b, m) => out.push(m), () => ({ ...LIVE_INV }), markPreconditionUnmet,
            () => { throw new Error('not reached'); }, () => { throw new Error('not reached'); }, () => { throw new Error('not reached'); }, () => { throw new Error('not reached'); });
        const ok = await fn(bot, 'torch', 79);
        assert.strictEqual(ok, false);
        assert.strictEqual(peekPreconditionUnmet(bot), null);
        assert.match(out.join('\n'), /79 is already held/);
        assert.ok(!out.join('\n').includes('316'));
    });
});

describe('fix86: a recipe cycle throws by name', () => {
    it('torch -> coal -> coal_block -> coal, and coal -> a pickaxe, throw the cycle instead of overflowing', () => {
        const nameOf = id => registry.items[id].name;
        const ingredientsOf = item => {
            const it = registry.itemsByName[item];
            if (!it) return [];
            const recipes = Recipe.find(it.id);
            if (recipes.length) {
                const delta = recipes[0].delta.filter(d => d.count < 0).map(d => nameOf(d.id));
                return [...new Set(delta)];
            }
            const block = registry.blocksByName[item];
            if (!block || !block.harvestTools) return [];
            const tools = Object.keys(block.harvestTools).map(id => registry.items[id].name);
            return tools.length ? [tools[0]] : [];
        };
        assert.throws(() => walkCraftNeeds('torch', ingredientsOf), /\[fix86\] recipe cycle: torch -> .*coal -> coal_block -> coal/);
        const toolFirst = item => {
            const block = registry.blocksByName[item];
            const tools = block && block.harvestTools ? [registry.items[Object.keys(block.harvestTools)[0]].name] : [];
            const it = registry.itemsByName[item];
            const recipes = it ? Recipe.find(it.id) : [];
            const ings = recipes.length ? [...new Set(recipes[0].delta.filter(d => d.count < 0).map(d => nameOf(d.id)))] : [];
            return [...new Set([...tools, ...ings])];
        };
        assert.throws(() => walkCraftNeeds('coal_block', toolFirst), /\[fix86\] recipe cycle: coal_block -> coal -> coal_block/);
        const torchNeedsAPickaxe = item => item === 'torch' ? ['coal', 'stick'] : item === 'stick' ? [] : item === 'coal' ? ['wooden_pickaxe'] : item === 'wooden_pickaxe' ? ['coal'] : [];
        assert.throws(() => walkCraftNeeds('torch', torchNeedsAPickaxe), /\[fix86\] recipe cycle: torch -> coal -> wooden_pickaxe -> coal/);
    });
});

describe('fix86: contracts are validated against the snapshot shape', () => {
    const v = () => {
        const x = Object.create(Voyager.prototype);
        x.agent = { bot: { registry } };
        return x;
    };
    it('c.post.pos.dist is rejected; distance is c.dist', () => {
        const why = v()._validContract({ pre: 'c => true', post: 'c => c.post.pos.dist(c.pre.pos) < 16' });
        assert.match(why, /post: c\.post\.pos\.dist is not on the contract state shape/);
    });
    it('heldItem.type is rejected, and a post is false for the skill\'s returned name', () => {
        const skill = { name: 'equipBestToolForAxe', code: 'async function equipBestToolForAxe(bot) { return "iron_axe"; }', observedRuns: [{ rv: 'iron_axe', heldItem: 'iron_axe' }] };
        const why = v()._validContract({ pre: 'c => true', post: "c => c.ret === false || c.ret === null || c.post.eq.heldItem.type === 'iron_axe'" }, skill);
        assert.match(why, /heldItem\.type is not on the contract state shape/);
        const mismatch = v()._validContract({ pre: 'c => true', post: "c => c.ret === null || c.post.eq.heldItem === 'diamond_axe'" }, skill);
        assert.match(mismatch, /post is false for the skill's return "iron_axe"/);
        assert.match(mismatch, /heldItem is "iron_axe"/);
        const ok = v()._validContract({ pre: 'c => true', post: 'c => c.ret === null || c.post.eq.heldItem === c.ret' }, skill);
        assert.strictEqual(ok, null);
    });
    it('a TypeError from a method the state does not have deletes the contract', () => {
        const x = v();
        x.progress = {};
        x._saveProgress = () => {};
        x._saveSkills = () => { x.saved = true; };
        const e = { name: 'ensureCraftingTableAndPlanks', contract: { pre: 'c => true', post: 'c => c.post.pos.dist(c.pre.pos) < 16' } };
        x.skills = [e];
        const pos = { x: 0, y: 64, z: 0 };
        const s = { pos, hp: 20, food: 20, sky: 0, alive: true, dim: 'overworld', inv: {}, free: 4, eq: { heldItem: null } };
        x._checkContracts([{ name: e.name, argv: [], rv: true, s0: s, s1: s, delta: {}, intr: false }], false);
        assert.strictEqual(Object.hasOwn(e, 'contract'), false);
        assert.strictEqual(x.saved, true);
    });
});

describe('fix86: equipBestToolForAxe contract reset', () => {
    it('the manifest deletes contract and contractTried and refuses a second apply', () => {
        const m = loadManifest(new URL('../scripts/fix86_axe_contract_manifest.json', import.meta.url).pathname);
        assert.deepStrictEqual(m.records[0].delete, ['contract', 'contractTried']);
        const dir = mkdtempSync(join(tmpdir(), 'fix86-'));
        mkdirSync(join(dir, 'skills'));
        try {
            writeFileSync(join(dir, 'skills/index.json'), JSON.stringify([{ name: 'equipBestToolForAxe', code: 'async function equipBestToolForAxe(bot) { return "iron_axe"; }', contract: m.records[0].expect.contract, contractTried: 1 }]));
            writeFileSync(join(dir, 'skills/progress.json'), '{}');
            applyManifest({ manifest: m, botsDir: dir, apply: true, log: () => {} });
            const after = JSON.parse(readFileSync(join(dir, 'skills/index.json'), 'utf8'));
            assert.strictEqual(Object.hasOwn(after[0], 'contract'), false);
            assert.strictEqual(Object.hasOwn(after[0], 'contractTried'), false);
            assert.throws(() => applyManifest({ manifest: m, botsDir: dir, apply: false, log: () => {} }), /expect mismatch/);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('fix86: a generic description is not a subgoal, and a self-decomposition is a cycle', () => {
    it('craftItem\'s task "Craft N of an item" cannot become the subgoal for iron_pickaxe', () => {
        const v = Object.create(Voyager.prototype);
        v.skills = [{ name: 'craftItem', task: 'Craft N of an item', code: 'async function craftItem(bot) { return false; }', effects: ['iron_pickaxe'], consumes: {}, demoted: false, candidate: false, mergedInto: null }];
        v.npGraph = null;
        v._boltzmann = list => list[0];
        // fix95: not a subgoal, and not a throw (the throw recurred every step and exited the process): null, so the
        //        caller takes the game-data plan, whose task names the item.
        assert.strictEqual(v._subgoalToObtainItem('iron_pickaxe', 1, {}, new Set()), null);
    });
    it('a subgoal whose task is the parent task throws', () => {
        const v = Object.create(Voyager.prototype);
        v.progress = { subgoals: [], decomposed: {}, failed: [], blockers: [], recipeEdges: {}, goalStats: {} };
        v._curSub = null;
        v._saveProgress = () => {};
        v.agent = { bot: { registry, recipesAll: id => Recipe.find(id) } };
        v._subgoalForNeed = () => ({ task: 'Craft N of an item', need: { item: 'iron_pickaxe', count: 1, reason: 'tool' }, edge: null });
        assert.throws(
            () => v._chainNeeds('Craft N of an item', [{ item: 'iron_pickaxe', count: 1, reason: 'tool', source: 'reported' }], { inventory: {}, nearby_blocks: [] }),
            /subgoal cycle: "Craft N of an item" decomposes into itself/,
        );
    });
});

describe('fix86: a trial cannot drop the reported need', () => {
    it('a collectBlock candidate that returns 0 without the marker is rejected and not kept', () => {
        const v = Object.create(Voyager.prototype);
        const incumbent = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'collectBlock').code;
        const candidateCode = 'async function collectBlock(bot, blockType, num) { log(bot, "No oak_log nearby"); return 0; }';
        v.skills = [{ name: 'collectBlock', code: incumbent, deps: [], candidate: { code: candidateCode, deps: [], task: 'Collect 1 oak_log' } }];
        v._graph = () => ({});
        v._saveSkills = () => {};
        const dropped = markerCallsMissing(incumbent, candidateCode, PRECONDITION_UNMET_BINDING);
        assert.match(dropped, /repair dropped/);
        const first = v._trialClosure('collectBlock', true);
        assert.strictEqual(first.over.collectBlock, undefined);
        assert.match(first.rejected.get('collectBlock'), /repair dropped/);
        assert.strictEqual(v.skills[0].candidate, undefined);
        assert.match(v.skills[0].repairHistory[0].outcome, /rejected dropped need/);
        assert.match(v.skills[0].repairHistory[0].evidence, /repair dropped/);
        assert.doesNotThrow(() => v._trialClosure('collectBlock', true));
    });
});

describe('fix86: coal\'s tool comes from harvestTools', () => {
    it('wooden_pickaxe harvests coal, and a contract that names only iron_pickaxe is not the need when cobblestone is held', () => {
        const tools = Object.keys(registry.blocksByName.coal_ore.harvestTools).map(id => registry.items[id].name);
        assert.ok(tools.includes('wooden_pickaxe'));
        const planner = obtainPlanner({ registry, recipesOf: id => Recipe.find(id), known: () => false, proven: () => false, edgeSuccess: () => 1, smeltInputs: () => [], present: () => false });
        const plan = planner.prerequisites('coal', 79, { ...LIVE_INV });
        assert.ok(!plan.plan.includes('Craft 1 iron_pickaxe'), plan.plan.join(' > '));
        const v = Object.create(Voyager.prototype);
        v.progress = { subgoals: [], decomposed: {}, failed: [], blockers: [], recipeEdges: {}, goalStats: {} };
        v._curSub = null;
        v._saveProgress = () => {};
        v.skills = [];
        v.npGraph = { confirmedProduces: () => [], getProducersOf: () => [] };
        v.agent = { bot: { registry, recipesAll: id => Recipe.find(id) } };
        v._chainNeeds('Collect 79 coal', [{ item: 'iron_pickaxe', count: 1, reason: 'contract', source: 'contract of equipToolOrCraft' }], { inventory: { ...LIVE_INV }, nearby_blocks: [] });
        const sub = v.progress.subgoals.find(s => s.task !== 'Collect 79 coal');
        assert.ok(sub, JSON.stringify(v.progress.subgoals));
        assert.notStrictEqual(sub.task, 'Craft 1 iron_pickaxe');
        assert.match(sub.task, /pickaxe/);
        assert.ok(tools.includes(sub.task.split(' ').pop()));
    });
});

describe('fix86: underground, no logs, the chain reaches a log through a learned skill', () => {
    it('from (-125, 43, 61) with the live inventory, Collect oak_log chains to reach oak_log and then collects it', async () => {
        const v = Object.create(Voyager.prototype);
        const inv = { ...LIVE_INV };
        const nearby = [];
        const position = { x: -125, y: 43, z: 61 };
        v.agent = { bot: { version: VER, registry, recipesAll: id => Recipe.find(id), inventory: { emptySlotCount: () => 4 }, entity: { position } }, openChat() {} };
        v.skills = [
            { name: 'collectLogs', task: 'Collect logs', description: 'collect logs', code: 'async function collectLogs(bot, count, blockType) { return true; }', effects: ['oak_log'], consumes: {}, deps: [], demoted: false, primitive: false, stats: { success: 1, fail: 0 } },
            { name: 'seekSource', task: 'seek a source that was brought into range', description: 'bring a missing block into range', code: 'async function seekSource(bot) { return true; }', effects: [], consumes: {}, deps: [], broughtNear: ['oak_log'], demoted: false, primitive: false, stats: { success: 1, fail: 0 } },
        ];
        v.npGraph = { confirmedProduces: () => [], getProducersOf: () => [], recordDelta() {} };
        v.progress = { subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], recipeEdges: {}, goalStats: {} };
        v._saveProgress = () => {};
        v._saveSkills = () => {};
        v._windowCheck = () => {};
        v._afterSuccess = () => {};
        v._prefetchPlan = () => {};
        v._curSub = null;
        v.observe = () => ({ inventory: { ...inv }, nearby_blocks: [...nearby], empty_inventory_slots: 4, position: `${position.x}, ${position.y}, ${position.z}`, food_value: 20, health_value: 20, is_day: true });
        v.ran = [];
        v._embedReplay = async () => null;
        v._backchain = async () => null;
        v._cursorLimited = () => true;
        v._replay = async (task, _before, route) => {
            v.ran.push(`${task} via ${route.name}`);
            if (route.name === 'seekSource') { nearby.push('oak_log'); return { ok: true, name: 'seekSource' }; }
            if (task.startsWith('Collect') && task.includes('oak_log')) {
                if (!nearby.includes('oak_log')) return { ok: false, name: route.name, needs: [{ item: 'oak_log', count: 1, reason: 'reach', source: 'reported by collectBlock' }] };
                inv.oak_log = 1;
                return { ok: true, name: route.name };
            }
            return { ok: false, name: route.name, reason: 'unhandled in the test world' };
        };
        const drive = async (task) => {
            for (let i = 0; i < 8; i++) {
                const sub = v._subgoalTask();
                await v._pursueProposedTask(sub ? sub.task : task, { reasoning: 'test', context: '' }, v.observe());
                if (v.progress.completed.includes(task)) return;
                if (!v.progress.subgoals.length && !v._curSub) return;
            }
        };
        assert.deepStrictEqual([position.x, position.y, position.z], [-125, 43, 61]);
        assert.ok(!nearby.includes('oak_log'));
        await drive('Collect 1 oak_log');
        assert.ok(v.ran.some(r => r.startsWith('Collect 1 oak_log')), v.ran.join(' | '));
        assert.ok(v.ran.some(r => r === 'reach oak_log via seekSource'), v.ran.join(' | '));
        assert.ok(v.progress.completed.includes('Collect 1 oak_log'), v.ran.join(' | '));
        assert.strictEqual(inv.oak_log, 1);
    });
});
