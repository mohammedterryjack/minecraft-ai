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
import { nestedBotMemberError, getBareAPI, Coder } from '../src/agent/coder.js';
import { getNearestBlocks, getNearestBlocksWhere, getNearbyBlockTypes } from '../src/agent/library/world.js';
import { wrapBotForApiTiming } from '../src/utils/bot_api_timing.js';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
        assert.strictEqual(typeof pre.fuel, 'string');
        assert.ok(pre.plan.some(s => s.includes(pre.fuel)), `${pre.fuel}: ${pre.plan.join(' | ')}`);
        assert.ok(pre.from.length === 0 || pre.plan.includes('Obtain 1 mutton'));
    });

    it('held oak_log with oak nearby makes cooked_beef reachable, and the fuel is oak_log', () => {
        const v = mkV({});
        const inv = { oak_log: 10, cobblestone: 8 };
        const planner = v._obtainPlanner({ inventory: inv, nearby_blocks: ['oak_log'] });
        const pre = planner.prerequisites('cooked_beef', 1, inv);
        assert.strictEqual(pre.how, 'smelt');
        assert.strictEqual(pre.fuel, 'oak_log');
        const chosen = planner.cheapest(['cooked_beef'], 1, inv, true);
        assert.strictEqual(chosen.item, 'cooked_beef');
    });

    it('egg and milk_bucket are obtains, not a missing recipe', () => {
        const v = mkV({});
        const planner = v._obtainPlanner({ inventory: {}, nearby_blocks: [] });
        const egg = planner.prerequisites('egg', 1, {});
        const milk = planner.prerequisites('milk_bucket', 1, {});
        assert.strictEqual(egg.how, 'obtain');
        assert.strictEqual(milk.how, 'obtain');
        assert.throws(() => planner.cheapest(['egg'], 1, {}, true), /none of egg is reachable/);
    });
});

describe('fix97 goal identity: Collect 1 apple stays Collect 1 apple', () => {
    it('reaches one present source, not every leaf in list order', async () => {
        const v = mkV({});
        v._askLocal = async () => { throw new Error('the model must not rewrite an item goal'); };
        v._producers = () => [{ s: { name: 'collectSurface', task: 'Collect 64 dirt', effects: ['apple'], code: 'async function collectSurface(bot) { return true; }' }, V: 1 }];
        v.observe = () => ({ inventory: {}, nearby_blocks: ['dirt'] });
        assert.strictEqual(await v._decompose('Collect 1 apple', 'no apples'), false);
        assert.strictEqual(v.progress.decomposed['Collect 1 apple'], undefined);
        v.observe = () => ({ inventory: {}, nearby_blocks: ['oak_leaves', 'dirt'] });
        assert.strictEqual(await v._decompose('Collect 1 apple', 'no apples'), true);
        const subs = v.progress.decomposed['Collect 1 apple'].subs;
        assert.deepStrictEqual(subs, ['reach oak_leaves']);
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
        const buried = { name: 'checkOakLog', code: 'async function checkOakLog(bot) { return 155; }', consumes: {}, effects: [], stats: { success: 5512, fail: 0 } };
        const still = v._validContract({ pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' }, buried);
        assert.match(still, /pre uses 55/);
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

    it('parses a skill as a module and a contract as a parenthesized expression, and a comment or string is not a numeric literal', () => {
        const v = mkV({});
        const helper = 'function helper(bot) { return 1; }\nasync function checkOakLog(bot) { return helper(bot); }\n';
        const trailing = 'async function checkOakLog(bot) { return true; }\nawait checkOakLog(bot);\n';
        assert.deepStrictEqual(Voyager.numericLiterals(Voyager.parseSkill(helper)), [1]);
        assert.deepStrictEqual(Voyager.numericLiterals(Voyager.parseSkill(trailing)), []);
        assert.throws(() => Voyager.parseSkill('function ( {'), /skill does not parse as a module/);
        assert.deepStrictEqual(Voyager.contractLiteralUses('c => c.pre.inv.oak_log < 55').map(u => u.n), [55]);
        assert.throws(() => Voyager.parseContract('function ( {'), /contract does not parse/);
        const commented = 'async function checkOakLog(bot) {\n  // currently 55\n  log(bot, "currently 55");\n  return true;\n}';
        const skill = { name: 'checkOakLog', code: commented, consumes: {}, effects: [] };
        assert.match(v._validContract({ pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' }, skill), /pre uses 55/);
        assert.match(Voyager.prototype._learnContracts.toString(), /String\(e\.code\)/);
        assert.doesNotMatch(Voyager.prototype._learnContracts.toString(), /sourceForContractPrompt/);
        const coded = { name: 'checkOakLog', code: 'async function checkOakLog(bot) { const n = 55; return n; }', consumes: {}, effects: [] };
        assert.strictEqual(v._validContract({ pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' }, coded), null);
        const copied = { name: 'checkOakLog', code: 'async function checkOakLog(bot) { const counts = getInventoryCounts(bot); return counts.oak_log >= 55; }', consumes: {}, effects: [], promptCounts: { oak_log: 55 } };
        assert.match(v._validContract({ pre: 'c => c.pre.inv.oak_log >= 55', post: 'c => true' }, copied), /pre uses 55/);
    });

    it('armour slots and a stack size are minecraft-data; the other review literals stay wrong', () => {
        const v = mkV({});
        const armorCode = 'async function equipBestArmor(bot) {\n  for (const slot of ["helmet", "chestplate", "leggings", "boots"]) { if (bot.interrupt_code) return 0; }\n  return 0;\n}';
        const setCode = 'async function craftArmorSet(bot, material = "iron") {\n  for (const slot of ["helmet", "chestplate", "leggings", "boots"]) { if (bot.interrupt_code) return 0; }\n  return await equipBestArmor(bot);\n}';
        const chestCode = 'async function ensureStorageChestNearby(bot) {\n  const kind = `chest`;\n  return getNearestBlock(bot, kind, 32);\n}';
        assert.strictEqual(v._validContract({ pre: 'c => true', post: 'c => c.ret <= 4' }, { name: 'equipBestArmor', code: armorCode }), null);
        assert.strictEqual(v._validContract({ pre: 'c => true', post: 'c => c.ret <= 4' }, { name: 'craftArmorSet', code: setCode }), null);
        assert.strictEqual(v._validContract({ pre: 'c => true', post: 'c => c.post.inv.cobblestone <= 64' }, { name: 'ensureStorageChestNearby', code: chestCode }), null);
        const tool = 'async function craftToolSet(bot, material = "stone") {\n  const tools = ["pickaxe", "axe", "sword"].map(t => material + "_" + t);\n  if ((world.getInventoryCounts(bot)["stick"] || 0) < 5) await craftItem(bot, "stick", 5);\n  return tools.every(t => world.getInventoryCounts(bot)[t]);\n}';
        const safe = 'function isSafeTarget(bot, x, z, maxRange = 48) {\n  const p = bot.entity.position;\n  if (Math.hypot(x - p.x, z - p.z) > maxRange) return false;\n  return Math.hypot(x - (-800), z - 500) > 200;\n}';
        const crop = 'async function harvestCrop(bot, crop = "wheat", count = 4) {\n  const maxAge = crop === "beetroots" ? 3 : 7;\n  return maxAge;\n}';
        const brk = 'async function breakBlockAt(bot, x, y, z) {\n  if (bot.entity.position.distanceTo(block.position) > 4.5) await goToPosition(bot, x, y, z, 4);\n  return true;\n}';
        const pick = 'async function equipBestPickaxeForIronOre(bot) {\n  return await equipBestTool(bot, "pickaxe");\n}';
        const travel = 'async function travelWestAvoidDeathHotspot(bot) {\n  const destX = -178, destY = 53, destZ = 107;\n  if (d <= 4) return;\n  const step = Math.min(32, d);\n  await goToPosition(bot, destX, destY, destZ, 3);\n  await travelTo(bot, destX, destY, destZ, 8);\n}';
        const skills = [
            { name: 'craftToolSet', code: tool, contract: { pre: 'c => true', post: 'c => c.ret === 3' } },
            { name: 'isSafeTarget', code: safe, contract: { pre: 'c => c.args.length >= 2 && c.args.length <= 3 && c.args.length === 2', post: 'c => true' } },
            { name: 'equipBestArmor', code: armorCode, contract: { pre: 'c => true', post: 'c => c.ret <= 4' } },
            { name: 'craftArmorSet', code: setCode, contract: { pre: 'c => true', post: 'c => c.ret === 4' } },
            { name: 'harvestCrop', code: crop, contract: { pre: 'c => true', post: 'c => c.ret >= 2' } },
            { name: 'breakBlockAt', code: brk, contract: { pre: 'c => c.args.length >= 2', post: 'c => true' } },
            { name: 'ensureStorageChestNearby', code: chestCode, contract: { pre: 'c => true', post: 'c => c.ret <= 64' } },
            { name: 'equipBestPickaxeForIronOre', code: pick, contract: { pre: 'c => true', post: 'c => c.ret === 4 || c.ret === 5' } },
            { name: 'travelWestAvoidDeathHotspot', code: travel, contract: { pre: 'c => true', post: 'c => Math.abs(c.post.pos.y - 53) <= 6' } },
            { name: 'equipIronAxe', code: 'async function equipIronAxe(bot) {\n  const need = "iron_ingot";\n  await craftItem(bot, "iron_axe", 1);\n  return true;\n}', contract: { pre: 'c => true', post: 'c => c.ret === 9' } },
            { name: 'exploreForIronOre', code: 'async function exploreForIronOre(bot) {\n  return getNearestBlock(bot, "iron_ore", 32);\n}', contract: { pre: 'c => true', post: 'c => c.ret <= 4' } },
            { name: 'scanForIronOreBlocks', code: 'async function scanForIronOreBlocks(bot) {\n  return getNearestBlocks(bot, ["iron_ore", "deepslate_iron_ore"], 128, 20);\n}', contract: { pre: 'c => true', post: 'c => c.ret >= 0.5' } },
            { name: 'mineIronOreDeposit', code: 'async function mineIronOreDeposit(bot) {\n  const b = getNearestBlock(bot, "iron_ore", 32);\n  if (!b) return false;\n  await mineBlock(bot, b);\n  return true;\n}', contract: { pre: 'c => c.args.length >= 2', post: 'c => c.ret >= 2' } },
            { name: 'checkOakLog', code: 'async function checkOakLog(bot) {\n  const counts = getInventoryCounts(bot);\n  return counts.oak_log >= 55;\n}', promptCounts: { oak_log: 55 }, contract: { pre: 'c => c.pre.inv.oak_log >= 55', post: 'c => true' } },
        ];
        const manifest = buildContractManifest(skills);
        assert.deepStrictEqual(manifest.records.map(r => r.id), [
            'craftToolSet.post.3',
            'isSafeTarget.pre.2',
            'isSafeTarget.pre.3',
            'isSafeTarget.pre.2',
            'harvestCrop.post.2',
            'breakBlockAt.pre.2',
            'equipBestPickaxeForIronOre.post.4',
            'equipBestPickaxeForIronOre.post.5',
            'travelWestAvoidDeathHotspot.post.6',
            'equipIronAxe.post.9',
            'exploreForIronOre.post.4',
            'scanForIronOreBlocks.post.0.5',
            'mineIronOreDeposit.pre.2',
            'mineIronOreDeposit.post.2',
            'checkOakLog.code.55',
            'checkOakLog.pre.55',
        ]);
        assert.deepStrictEqual(manifest.reasonLines, manifest.records.map(r => r.verdict));
        for (const r of manifest.records) assert.ok(r.verdict.startsWith(r.id), r.verdict);
        const byId = Object.fromEntries(manifest.records.map(r => [r.id, r.verdict]));
        assert.match(byId['ensureStorageChestNearby.post.64'] || '', /^$/);
        assert.match(byId['equipIronAxe.post.9'], /iron_ingot recipe result count 9/);
        assert.match(byId['equipIronAxe.post.9'], /not c\.ret/);
        assert.match(byId['exploreForIronOre.post.4'], /not a minecraft-data fact of that field/);
        assert.match(byId['scanForIronOreBlocks.post.0.5'], /not a minecraft-data fact of that field/);
        assert.match(byId['mineIronOreDeposit.pre.2'], /c\.args\.length/);
        assert.match(byId['mineIronOreDeposit.post.2'], /c\.ret/);
        assert.match(byId['checkOakLog.code.55'], /promptCounts count of oak_log/);
        assert.match(byId['checkOakLog.pre.55'], /promptCounts count of oak_log/);
        assert.strictEqual(manifest.checkOakLogPresent, true);
    });
});

describe('fix97 code state and decompose limits', () => {
    it('the code prompt keeps item counts, and a comparison that copies one is feedback', () => {
        const v = mkV({});
        const text = v._codeState({
            inventory: { oak_log: 55, cobblestone: 8 }, position: '0, 64, 0', biome: 'plains', time: 'day (1000)',
            health_value: 20, health_max: 20, food_value: 17, food_max: 20, inventory_slots: '2/36', empty_inventory_slots: 34,
            equipment: { hand: 'empty' }, threats: 'none',
        });
        assert.match(text, /oak_log:55/);
        assert.match(text, /cobblestone:8/);
        const src = Voyager.prototype._pursueProposedTask.toString();
        assert.match(src, /_codeState\(currentState\)/);
        assert.match(src, /Do not write one of those counts into a comparison/);
        const copied = 'async function checkOakLog(bot) {\n  const counts = getInventoryCounts(bot);\n  return counts.oak_log >= 55;\n}';
        const feedback = Voyager.snapshotThresholdFeedback(copied, { oak_log: 55, cobblestone: 8 });
        assert.match(feedback.join('\n'), /oak_log >= 55/);
        const distance = 'async function checkOakLog(bot) {\n  return getNearestBlock(bot, "oak_log", 32);\n}';
        assert.deepStrictEqual(Voyager.snapshotThresholdFeedback(distance, { oak_log: 55 }), []);
    });

    it('a depth-2 goal still decomposes, and a queued split is not repeated on a clock', async () => {
        const v = mkV({});
        v._askLocal = async () => { throw new Error('the model must not rewrite an item goal'); };
        v._producers = () => [];
        v._curSub = { task: 'Collect 1 apple', depth: 2 };
        v.observe = () => ({ inventory: {}, nearby_blocks: ['oak_leaves'] });
        assert.strictEqual(await v._decompose('Collect 1 apple', 'overflow'), true);
        assert.strictEqual(await v._decompose('Collect 1 apple', 'again'), false);
        v.progress.subgoals = [];
        v.progress.decomposed['Collect 1 apple'].at = Date.now();
        assert.strictEqual(await v._decompose('Collect 1 apple', 'no timer'), true);
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
        const noWidth = { ...item };
        delete noWidth.width;
        const bare = { ...bot, nearestEntity: () => noWidth };
        await assert.rejects(pickupNearbyItems(bare), /no width/);
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

    it('a failed split is recorded and not repeated, and the next overflow decomposes', async () => {
        const v = mkV({});
        const code = 'async function bigSkill(bot) {\n' + '  return true;\n'.repeat(41) + '}';
        v.skills = [{ name: 'bigSkill', description: 'd', code, deps: [], primitive: false, handwritten: false, demoted: false }];
        v._maturity = () => ({ V: 0.1 });
        v._cursorLimited = () => false;
        v._hashReply = Voyager.prototype._hashReply;
        v.scopedAPIList = () => '';
        v._splitHint = 'bigSkill';
        v._splitDue = true;
        v._splitBecause = null;
        v._inferMeta = () => ({});
        v._closure = () => [];
        v._ask = async () => { throw new Error('split model failed'); };
        assert.strictEqual(await v._split(), false);
        assert.strictEqual(v.progress.splitFailures.length, 1);
        v._detectSplit();
        assert.notStrictEqual(v._splitDue, true);
        v.currentTask = 'Collect 1 oak_log';
        let decomposed = null;
        v._decompose = async (task) => { decomposed = task; return true; };
        const err = new Error('request (9925 tokens) exceeds the available context size (8192 tokens)');
        err.code = CONTEXT_FULL;
        await v._onStepError(err);
        assert.strictEqual(decomposed, 'Collect 1 oak_log');
        const logs = [];
        const orig = console.error;
        console.error = (...args) => logs.push(args.join(' '));
        v._decompose = async () => false;
        try { await v._onStepError(err); }
        finally { console.error = orig; }
        assert.match(logs.join('\n'), /blocked by context size: prompt 9925 tokens, context 8192 tokens/);
        assert.match(v._contextBlockReason('Collect 1 oak_log'), /9925/);
        const restarted = mkV({ contextBlocked: v.progress.contextBlocked, subgoals: [{ task: 'Collect 1 oak_log', parent: 'parent' }] });
        restarted.skills = v.skills;
        assert.match(restarted._staleSubgoal(restarted.progress.subgoals[0], {}), /blocked by context size/);
        assert.match(restarted._rejectTask('Collect 1 oak_log', true, { inventory: {}, nearby_blocks: [] }), /blocked by context size/);
        restarted.skills = [{ name: 'checkOakLog', code: 'async function checkOakLog(bot) { return true; }' }];
        assert.strictEqual(restarted._contextBlockReason('Collect 1 oak_log'), null);
        assert.strictEqual(Object.hasOwn(restarted.progress.contextBlocked, 'Collect 1 oak_log'), false);
        let again = null;
        restarted.currentTask = 'Collect 1 oak_log';
        restarted._decompose = async (task) => { again = task; return true; };
        await restarted._onStepError(err);
        assert.strictEqual(again, 'Collect 1 oak_log');
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

describe('fix97 findBlocks refuses a non-numeric maxDistance or count', () => {
    it('the mineIronOres call shape throws before any scan, and the coder sees number types not count=10000', () => {
        let scanned = false;
        const bot = { findBlocks() { scanned = true; return []; }, registry };
        const names = ['iron_ore', 'deepslate_iron_ore'];
        assert.throws(() => getNearestBlocks(bot, null, names), /getNearestBlocks: distance must be a finite number, got \["iron_ore","deepslate_iron_ore"\]/);
        assert.throws(() => getNearestBlocks(bot, names, 32), /count must be a finite number, got undefined/);
        assert.throws(() => getNearestBlocksWhere(bot, () => true, names, 10000), /getNearestBlocksWhere: distance must be a finite number/);
        assert.throws(() => getNearbyBlockTypes(bot, names), /getNearbyBlockTypes: distance must be a finite number/);
        assert.throws(() => getNearbyBlockTypes(bot), /getNearbyBlockTypes: distance must be a finite number, got undefined/);
        assert.strictEqual(scanned, false);
        const sig = getBareAPI().byName.getNearestBlocks.sig;
        assert.match(sig, /block_types: string\|string\[\]\|null/);
        assert.match(sig, /distance: number/);
        assert.match(sig, /count: number/);
        assert.doesNotMatch(sig, /10000/);
        assert.match(getBareAPI().byName.getNearbyBlockTypes.sig, /distance: number/);
        assert.doesNotMatch(getBareAPI().byName.getNearbyBlocks.sig, /=/);
        assert.match(Voyager.prototype._pursueProposedTask.toString(), /maxDistance and count are finite numbers/);
        assert.match(Voyager.prototype._pursueProposedTask.toString(), /findBlock\(options\) returns one block and does not take count/);
        const { EventEmitter } = require('events');
        const raw = new EventEmitter();
        raw._client = new EventEmitter();
        raw.registry = registry;
        raw.version = VER;
        raw.supportFeature = () => false;
        require('mineflayer/lib/plugins/blocks.js')(raw, { version: VER });
        assert.throws(() => raw.findBlocks({ matching: [registry.blocksByName.iron_ore.id], maxDistance: names, count: 10000 }), /findBlocks: maxDistance must be a finite number, got \["iron_ore","deepslate_iron_ore"\]/);
        assert.throws(() => raw.findBlocks({ matching: [registry.blocksByName.iron_ore.id], maxDistance: 16 }), /findBlocks: count must be a finite number, got undefined/);
        let wrapped = false;
        const proxy = wrapBotForApiTiming({ findBlocks() { wrapped = true; return []; }, findBlock() { wrapped = true; return null; } });
        assert.throws(() => proxy.findBlocks({ matching: [1057], maxDistance: names, count: 10000 }), /findBlocks: maxDistance must be a finite number/);
        assert.throws(() => proxy.findBlock({ matching: [1057], maxDistance: 16, count: names }), /findBlock: count must be a finite number/);
        assert.strictEqual(wrapped, false);
        assert.strictEqual(proxy.findBlock({ matching: [1057], maxDistance: 16 }), null);
        assert.strictEqual(wrapped, true);
        const coder = new Coder({ name: 'icefox2000', bot: { findBlocks() {}, findBlock() {}, registry: { itemsByName: {}, blocksByName: {}, entitiesByName: {} } } });
        const generated = 'async function mineIronOres(bot) {\n    return getNearestBlocks(bot, null, ["iron_ore", "deepslate_iron_ore"]);\n}\nawait mineIronOres(bot);\n';
        const direct = 'async function mineIronOres(bot) {\n    return bot.findBlocks({ matching: [1057], maxDistance: ["iron_ore", "deepslate_iron_ore"], count: 10000 });\n}\nawait mineIronOres(bot);\n';
        const objectOpt = 'async function mineIronOres(bot) {\n    return bot.findBlocks({ matching: [1057], maxDistance: { blocks: 2 }, count: 1 });\n}\nawait mineIronOres(bot);\n';
        const feedback = coder.userGeneratedCodeLintBlockers(generated, ['getNearestBlocks', 'mineIronOres']);
        assert.match(feedback, /getNearestBlocks distance is an array literal, not a finite number/);
        assert.match(coder.userGeneratedCodeLintBlockers(direct, ['mineIronOres']), /findBlocks option maxDistance is an array literal/);
        assert.match(coder.userGeneratedCodeLintBlockers(objectOpt, ['mineIronOres']), /findBlocks option maxDistance is an object literal/);
        assert.strictEqual(generated.includes('getNearestBlocks(bot, null,'), true);
        assert.doesNotMatch(coder._nonNumericScanOptionLint.toString(), /replace\(/);
    });
    it('bot.findBlock({ matching, maxDistance }) returns one block', () => {
        const { EventEmitter } = require('events');
        const { Vec3 } = require('vec3');
        const Chunk = require('prismarine-chunk')(VER);
        const bot = new EventEmitter();
        bot._client = new EventEmitter();
        bot.registry = registry;
        bot.version = VER;
        bot.supportFeature = () => false;
        bot.game = { minY: -64, height: 384 };
        bot.entity = { position: new Vec3(8, 40, 8) };
        require('mineflayer/lib/plugins/blocks.js')(bot, { version: VER });
        bot._client.emit('login', { dimension: 'minecraft:overworld', worldName: 'minecraft:overworld' });
        const chunk = new Chunk({ minY: -64, worldHeight: 384 });
        chunk.setBlockStateId(new Vec3(8, 40, 8), registry.blocksByName.stone.defaultState);
        bot.world.setColumn(0, 0, chunk);
        const block = bot.findBlock({ matching: registry.blocksByName.stone.id, maxDistance: 8 });
        assert.strictEqual(block && block.name, 'stone');
        assert.throws(() => bot.findBlocks({ matching: registry.blocksByName.stone.id, maxDistance: 8 }), /count must be a finite number/);
    });
});

describe('fix97 the incomplete useEvidence throw is unreachable', () => {
    function jsFiles(dir) {
        const out = [];
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) out.push(...jsFiles(p));
            else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p);
        }
        return out;
    }
    it('src and scripts never throw incomplete useEvidence, and live mineBlocks has no such field', () => {
        const roots = [join(import.meta.dirname, '../src'), join(import.meta.dirname, '../scripts')];
        const hits = [];
        for (const root of roots) {
            for (const file of jsFiles(root)) {
                const text = readFileSync(file, 'utf8');
                if (text.includes('incomplete useEvidence') || text.includes("readEvidence(s, 'useEvidence')") || text.includes('missing @')) hits.push(file);
            }
        }
        assert.deepStrictEqual(hits, []);
        const botDir = join(import.meta.dirname, '../bots/icefox2000');
        const jsonHits = [];
        const walkJson = dir => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) walkJson(p);
                else if (name.endsWith('.json') && readFileSync(p, 'utf8').includes('useEvidence')) jsonHits.push(p);
            }
        };
        walkJson(botDir);
        assert.deepStrictEqual(jsonHits, []);
        const idx = JSON.parse(readFileSync(join(botDir, 'skills/index.json'), 'utf8'));
        const mb = idx.find(s => s.name === 'mineBlocks');
        assert.ok(mb);
        assert.strictEqual(Object.hasOwn(mb, 'useEvidence'), false);
    });
});
