/**
 * fix97: root causes from the icefox soak.
 *  1. Food is queued only when a leaf is held, nearby, an entity drop, a furnace recipe, or a proven edge.
 *  2. An item goal keeps its task; subgoals are game-data sources, not a producer's task string.
 *  3. A contract number that is not in the skill or its evidence is refused. The reset manifest is a dry run.
 *  4. pickupNearbyItems stops when the same item is still on the ground.
 *  5. cooked_mutton backchains through the mob, a furnace, and a fuel.
 *  7. equipToolForBlock throws when the block argument is missing; the contract requires one.
 *  8. bot.inventory.hasItem is an API-gate error naming the closest real members.
 *  9. A repair that does not fit the context is split, not resent.
 *  10. A skill with no useEvidence does not block a surplus toss.
 *  11. Embed calls run one at a time.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { edibleNames, planFoodAcquisition } from '../src/agent/food_backchain.js';
import { buildContractManifest } from '../scripts/fix97_contract_manifest.js';
import { nestedBotMemberError } from '../src/agent/coder.js';
import { CONTEXT_FULL } from '../src/models/ollama.js';
import * as acorn from 'acorn';

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

function mkV(progress) {
    const v = Object.create(Voyager.prototype);
    v.agent = { name: 'icefox2000', bot: { version: VER, registry, recipesAll: (id) => Recipe.find(id), inventory: { emptySlotCount: () => 1 }, health: 10, food: 0, game: {} } };
    v.skills = [];
    v.progress = { subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], recipeEdges: {}, goalStats: {}, goalFailStates: [], ...progress };
    v._saveProgress = () => {};
    v._producers = () => [];
    v.slotEffects = { effect: () => null };
    return v;
}

describe('fix97 food: an unreachable craft is not queued', () => {
    it('honey_bottle is not the food when only dirt and stone are nearby; beef is', () => {
        const v = mkV({});
        const state = { inventory: {}, nearby_blocks: ['dirt', 'stone', 'cobblestone'] };
        const planner = v._obtainPlanner(state);
        const plan = planFoodAcquisition({
            edibles: edibleNames(registry),
            inventory: state.inventory,
            cheapest: (items, count, inv) => planner.cheapest(items, count, inv, true),
            prerequisites: (item, count, inv) => planner.prerequisites(item, count, inv),
            entityDroppersFor: () => [],
        });
        assert.notStrictEqual(plan.item, 'honey_bottle');
        assert.strictEqual(plan.item, 'beef');
        assert.strictEqual(plan.how, 'obtain');
    });

    it('cooked_mutton backchains to the sheep drop, a furnace, and a fuel', () => {
        const v = mkV({});
        const pre = v._obtainPlanner({ inventory: {}, nearby_blocks: [] }).prerequisites('cooked_mutton', 1, {});
        assert.strictEqual(pre.how, 'smelt');
        assert.ok(pre.plan.includes('Obtain 1 mutton'), pre.plan.join(' | '));
        assert.ok(pre.plan.some(s => s.includes('furnace')), pre.plan.join(' | '));
        assert.ok(pre.plan.some(s => s.includes('mangrove_log')), pre.plan.join(' | '));
        assert.ok(pre.from.length === 0 || pre.plan.includes('Obtain 1 mutton'));
    });
});

describe('fix97 goal identity: Collect 1 apple stays Collect 1 apple', () => {
    it('subgoals are the leaf blocks that drop an apple, not a dirt skill task', async () => {
        const v = mkV({});
        v.observe = () => ({ inventory: {}, nearby_blocks: ['dirt'] });
        v._askLocal = async () => { throw new Error('the model must not rewrite an item goal'); };
        v._producers = () => [{ s: { name: 'collectSurface', task: 'Collect 64 dirt', effects: ['apple'], code: 'async function collectSurface(bot) { return true; }' }, V: 1 }];
        const ok = await v._decompose('Collect 1 apple', 'no apples');
        assert.strictEqual(ok, true);
        const subs = v.progress.decomposed['Collect 1 apple'].subs;
        assert.ok(subs.includes('reach oak_leaves'), subs.join(', '));
        assert.ok(subs.includes('reach dark_oak_leaves'), subs.join(', '));
        assert.ok(!subs.some(s => s.includes('dirt')), subs.join(', '));
        assert.ok(v.progress.subgoals.some(s => s.task === 'Collect 1 apple' && s.retry === true));
    });
});

describe('fix97 contracts: a hallucinated number is refused, and the manifest is a dry run', () => {
    it('Oak log count < 55 is refused; 0 and 1 are not', () => {
        const v = mkV({});
        const skill = { name: 'checkOakLog', code: 'async function checkOakLog(bot) { return true; }', consumes: {}, effects: [] };
        const bad = v._validContract({ pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' }, skill);
        assert.match(bad, /pre uses 55/);
        const ok = v._validContract({ pre: 'c => c.args.length >= 1 && c.args[0] === null', post: 'c => true' }, skill);
        assert.strictEqual(ok, null);
    });

    it('the manifest lists a 55 contract and does not apply; this checkout has no checkOakLog', () => {
        const fixture = [
            { name: 'checkOakLog', code: 'async function checkOakLog(bot) { return true; }', contract: { pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' } },
            { name: 'ok', code: 'async function ok(bot) { return 2; }', contract: { pre: 'c => c.pre.free > 2', post: 'c => true' } },
        ];
        const manifest = buildContractManifest(fixture);
        assert.strictEqual(manifest.apply, false);
        assert.strictEqual(manifest.dryRun, true);
        assert.deepStrictEqual(manifest.records.map(r => r.id), ['checkOakLog.pre.55']);
        const live = JSON.parse(readFileSync(new URL('../bots/icefox2000/skills/index.json', import.meta.url), 'utf8'));
        const disk = buildContractManifest(live);
        assert.strictEqual(disk.checkOakLogPresent, false);
        assert.strictEqual(disk.apply, false);
        assert.ok(disk.records.length === 0, JSON.stringify(disk.records));
    });
});

describe('fix97 pickup stops when the item is still there', () => {
    it('one failed path and a still-valid item returns false', async () => {
        const { pickupNearbyItems } = await import('../src/agent/library/skills.js');
        const item = { name: 'item', isValid: true, width: 0.25, position: { x: 3, y: 64, z: 0 }, getDroppedItem() { return { name: 'oak_log', count: 1 }; } };
        let paths = 0;
        const bot = {
            output: '', interrupt_code: false, version: VER,
            nearestEntity: () => item,
            entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 2 } },
            pathfinder: { setMovements() {}, getPathTo: async () => { paths++; throw new Error('no path'); }, stop() {} },
            registry, inventory: { slots: new Array(46).fill(null), inventoryStart: 9, inventoryEnd: 45, items() { return []; } },
            on() {}, removeListener() {},
            game: { gameMode: 'survival' }, modes: { isOn: () => false },
        };
        const { log: _ignored } = {};
        assert.strictEqual(await pickupNearbyItems(bot), false);
        assert.strictEqual(paths, 1);
        assert.match(bot.output, /No progress/);
        void _ignored;
    });
});

describe('fix97 equipToolForBlock requires a block', () => {
    it('a call with no block throws, and the seeded contract requires an object argument', async () => {
        const { equipToolForBlock } = await import('../src/agent/library/skills.js');
        const bot = { registry, output: '', inventory: { items: () => [] } };
        await assert.rejects(equipToolForBlock(bot), /block argument required/);
        await assert.rejects(equipToolForBlock(bot, null), /block argument required/);
        const seeded = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'equipToolForBlock');
        assert.strictEqual(seeded.code, equipToolForBlock.toString());
        assert.match(seeded.contract.pre, /c\.args\.length >= 1 && c\.args\[0\] === null/);
    });
});

describe('fix97 API gate sees nested bot members', () => {
    it('bot.inventory.hasItem names the closest real inventory members and does not rewrite', () => {
        const inventory = { items() {}, slots: [], count() {}, findInventoryItem() {} };
        const bot = { inventory, registry: { itemsByName: {}, blocksByName: {}, entitiesByName: {} } };
        const ast = acorn.parse('async function getOneCod(bot) { return bot.inventory.hasItem("cod"); }', { ecmaVersion: 'latest' });
        let node = null;
        const walk = n => {
            if (!n || typeof n.type !== 'string') return;
            if (n.type === 'MemberExpression' && n.property && n.property.name === 'hasItem') node = n;
            for (const v of Object.values(n)) {
                if (Array.isArray(v)) v.forEach(walk);
                else if (v && typeof v.type === 'string') walk(v);
            }
        };
        walk(ast);
        const err = nestedBotMemberError(bot, node, new Set(), []);
        assert.match(err, /bot\.inventory\.hasItem does not exist/);
        assert.match(err, /findInventoryItem|items|count/);
    });
});

describe('fix97 prompts do not paste skill bodies, and an overflow splits', () => {
    it('the code prompt builder names signatures, not bodies', () => {
        const src = Voyager.prototype._pursueProposedTask.toString();
        assert.match(src, /signatureOf\(s\.code, s\.name\)/);
        assert.doesNotMatch(src, /\$\{s\.code\}/);
    });

    it('a repair that overflows the context is queued for a split', async () => {
        const v = mkV({});
        v.skills = [{ name: 'ensureCraftingTable', description: 'd', code: 'async function ensureCraftingTable(bot) {\n  return true;\n}', deps: [], repairHistory: [] }];
        v.repairMemory = { formatHintsForCoder: () => '', retrieveSimilar: async () => [] };
        v._cursorLimited = () => false;
        v._updateAllowed = () => true;
        v._logPromptBreakdown = () => {};
        v._noteProposal = () => {};
        v._inferMeta = () => ({});
        v._closure = () => [];
        v._graph = () => ({});
        const err = new Error('request (9925 tokens) exceeds the available context size (8192 tokens)');
        err.code = CONTEXT_FULL;
        v._ask = async () => { throw err };
        v._repairQueue = [{ target: 'ensureCraftingTable', kind: 'callee_fix', task: 'Craft 1 crafting_table', path: ['ensureCraftingTable'], evidence: 'overflow', trace: 'tr' }];
        const ok = await v._repair();
        assert.strictEqual(ok, false);
        assert.strictEqual(v._splitDue, true);
        assert.strictEqual(v._splitHint, 'ensureCraftingTable');
        assert.strictEqual(v._splitBecause, 'context');
    });
});

describe('fix97 embeds are single-flight', () => {
    it('two embeds do not overlap', async () => {
        const v = mkV({});
        let active = 0;
        let max = 0;
        v.agent.prompter = { embedding_model: { embed: async () => {
            active++;
            if (active > max) max = active;
            await new Promise(r => setTimeout(r, 20));
            active--;
            return [1, 0];
        } } };
        await Promise.all([v._embed('a'), v._embed('b')]);
        assert.strictEqual(max, 1);
    });
});
