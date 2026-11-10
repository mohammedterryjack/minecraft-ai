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
import { applyContractResets, buildContractManifest } from '../scripts/fix97_contract_manifest.js';
import { nestedBotMemberError, getBareAPI, Coder } from '../src/agent/coder.js';
import { getNearestBlocks, getNearestBlocksWhere, getNearbyBlockTypes, getNearbyBlocks, nearbyBlockRadius, perceivedStats, perceivedBuildStats, indexPerceivedChunks, pathToBlock } from '../src/agent/library/world.js';
import { buildServerTerrain, makeServerChunk, serverHeight } from './server_terrain.js';
import { gunzipSync } from 'node:zlib';
import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
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
    (await import('../src/utils/mcdata.js'))._setVersionForTest(VER);
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

    it('an unsearched fuel log is searched when the smelt chooses it, and only noPath rules it out', async () => {
        const v = mkV({});
        const calls = [];
        v.agent.bot.game = { gameMode: 'survival' };
        v.agent.bot.entity = { eyeHeight: 1.62, position: { x: 0, y: 64, z: 0 } };
        v.agent.bot.world = {};
        v.agent.bot.waitForTicks = async () => {};
        v.agent.bot.pathfinder = {
            movements: {},
            tickTimeout: 40,
            getPathFromTo: function * (movements, start, goal) {
                calls.push(goal.pos.x);
                yield { result: { status: goal.pos.x === 4 ? 'noPath' : 'success', cost: 1 } };
            },
        };
        const inv = { beef: 1, cobblestone: 8 };
        const open = {
            inventory: inv,
            nearby_blocks: ['oak_log', 'stone'],
            perceived_at: { oak_log: { x: 3, y: 64, z: 1 }, stone: { x: 9, y: 64, z: 1 } },
        };
        assert.deepStrictEqual(calls, []);
        const pre = v._obtainPlanner(open).prerequisites('cooked_beef', 1, inv);
        assert.strictEqual(pre.how, 'smelt');
        assert.strictEqual(pre.fuel, 'oak_log');
        assert.deepStrictEqual(calls, [3]);
        assert.strictEqual(open._reach.oak_log, 'success');
        assert.strictEqual(Object.hasOwn(open._reach, 'stone'), false);
        const chosen = v._obtainPlanner(open).cheapest(['cooked_beef'], 1, inv, true);
        assert.strictEqual(chosen.item, 'cooked_beef');
        const blocked = {
            inventory: inv,
            nearby_blocks: ['oak_log'],
            perceived_at: { oak_log: { x: 4, y: 64, z: 1 } },
        };
        assert.throws(() => v._obtainPlanner(blocked).cheapest(['cooked_beef'], 1, inv, true), /none of cooked_beef is reachable/);
        assert.strictEqual(blocked._reach.oak_log, 'noPath');
        calls.length = 0;
        v.agent.bot.pathfinder.getPathFromTo = function * (movements, start, goal) {
            calls.push(goal.pos.x);
            yield { result: { status: 'partial', path: [] } };
            yield { result: { status: 'success', cost: 1 } };
        };
        const partial = {
            inventory: inv,
            nearby_blocks: ['oak_log'],
            perceived_at: { oak_log: { x: 5, y: 64, z: 1 } },
        };
        assert.throws(() => v._obtainPlanner(partial).prerequisites('cooked_beef', 1, inv), /has not been searched/);
        const continued = await v._withChosenSearches(partial, (plannerOf) => plannerOf().prerequisites('cooked_beef', 1, inv));
        assert.strictEqual(continued.fuel, 'oak_log');
        assert.strictEqual(partial._reach.oak_log, 'success');
        assert.ok(calls.includes(5));
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
        v.agent.bot.game = { gameMode: 'survival' };
        v.agent.bot.entity = { eyeHeight: 1.62, position: { x: 0, y: 64, z: 0 } };
        v.agent.bot.world = {};
        v.agent.bot.waitForTicks = async () => {};
        v.agent.bot.pathfinder = {
            movements: {},
            tickTimeout: 40,
            getPathFromTo: function * () { yield { result: { status: 'success', cost: 1 } }; },
        };
        v.observe = () => ({ inventory: {}, nearby_blocks: ['dirt'], perceived_at: {} });
        assert.strictEqual(await v._decompose('Collect 1 apple', 'no apples'), false);
        assert.strictEqual(v.progress.decomposed['Collect 1 apple'], undefined);
        v.observe = () => ({ inventory: {}, nearby_blocks: ['oak_leaves', 'dirt'], perceived_at: { oak_leaves: { x: 1, y: 70, z: 1 } } });
        assert.strictEqual(await v._decompose('Collect 1 apple', 'no apples'), true);
        const subs = v.progress.decomposed['Collect 1 apple'].subs;
        assert.deepStrictEqual(subs, ['reach oak_leaves']);
        assert.ok(v.progress.subgoals.some(s => s.task === 'Collect 1 apple' && s.retry === true));
    });
});

describe('fix97 contracts: a hallucinated number is refused, and the manifest is a dry run', () => {
    it('an inventory comparison to an ungrounded literal is refused; a bare 55 is not one', () => {
        const v = mkV({});
        const skill = { name: 'checkOakLog', code: 'async function checkOakLog(bot) { return true; }', consumes: {}, effects: [] };
        assert.match(v._validContract({ pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' }, skill), /pre uses 55/);
        const bare = { name: 'checkOakLog', code: 'async function checkOakLog(bot) { return 55; }', consumes: {}, effects: [] };
        assert.strictEqual(v._validContract({ pre: 'c => true', post: 'c => true' }, bare), null);
        const withArg = { name: 'checkOakLog', code: 'async function checkOakLog(bot, block) { return block === null; }', consumes: {}, effects: [] };
        const ok = v._validContract({ pre: 'c => c.args.length >= 1 && c.args[0] === null', post: 'c => true' }, withArg);
        assert.strictEqual(ok, null);
        assert.strictEqual(withArg.contractEval, Voyager.CONTRACT_EVAL);
        const bareParam = { name: 'checkOakLog', code: 'async function checkOakLog(bot, block) { return true; }', consumes: {}, effects: [] };
        assert.strictEqual(v._validContract({ pre: 'c => c.args[0] === null', post: 'c => true' }, bareParam), null);
        assert.strictEqual(bareParam.contractEval, Voyager.CONTRACT_EVAL);
        const buried = { name: 'checkOakLog', code: 'async function checkOakLog(bot) { return 155; }', consumes: {}, effects: [], stats: { success: 5512, fail: 0 } };
        const buriedReason = v._validContract({ pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' }, buried);
        assert.match(buriedReason, /pre uses 55/);
        assert.doesNotMatch(buriedReason, /155|5512/);
        const goal = { ...skill, task: 'Collect 55 oak_log' };
        assert.strictEqual(v._validContract({ pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' }, goal), null);
    });

    it('the manifest lists a 55 contract and does not apply; this checkout has no checkOakLog', () => {
        const fixture = [
            { name: 'checkOakLog', code: 'async function checkOakLog(bot) { return true; }', contract: { pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' } },
            { name: 'ok', code: 'async function ok(bot) { return 2; }', contract: { pre: 'c => c.pre.free > 2', post: 'c => true' } },
        ];
        const manifest = buildContractManifest(fixture);
        assert.strictEqual(manifest.apply, false);
        assert.strictEqual(manifest.dryRun, true);
        assert.deepStrictEqual(manifest.records.map(r => r.id), ['checkOakLog.pre.oak_log.55']);
        const live = JSON.parse(readFileSync(new URL('../bots/icefox2000/skills/index.json', import.meta.url), 'utf8'));
        const disk = buildContractManifest(live);
        assert.strictEqual(disk.checkOakLogPresent, false);
        assert.strictEqual(disk.apply, false);
        assert.deepStrictEqual(disk.records.map(r => r.id), []);
        for (const id of ['checkOakLog.code.oak_log.55', 'checkOakLog.pre.oak_log.55', 'smeltIronIntoIngot.code.1', 'mineBlocks.pre.2', 'craftItem.pre.2', 'craftArmorSet.post.4']) {
            assert.ok(!disk.records.some(r => r.id === id), id);
        }
    });

    it('the live 163-skill index records only copied counts, with the item in the id', () => {
        const skills = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/icefox-live-index.json.gz', import.meta.url))));
        assert.strictEqual(skills.length, 163);
        const manifest = buildContractManifest(skills);
        assert.deepStrictEqual(manifest.records.map(r => r.id).sort(), [
            'checkOakLeavesCount.code.oak_leaves.6',
            'checkOakLeavesCount.post.oak_leaves.6',
            'checkOakLog.code.oak_log.55',
            'checkOakLog.pre.oak_log.55',
            'confirmInventoryUpdate.code.oak_leaves.6',
            'confirmInventoryUpdate.post.oak_leaves.6',
        ]);
        for (const name of ['tossClutterSafe', 'ensureInventorySpaceForApple', 'verifyInventoryAndChest']) {
            assert.ok(!manifest.records.some(r => r.id.startsWith(`${name}.`)), name);
        }
        assert.deepStrictEqual(manifest.resets.map(r => r.id).sort(), [
            'checkForAppleTrees.pre.args[0]',
            'confirmInventoryUpdate.pre.args[0]',
            'confirmInventoryUpdate.pre.args[1]',
            'cookFood.pre.args[1]',
            'gatherOakLog.pre.args[0]',
            'harvestCrop.post.args[2]',
            'recommendTillingAction.post.args[0]',
            'removeItem.pre.args[2]',
            'tossOneRawCopper.pre.args[0]',
            'tossOneRawCopper.pre.args[1]',
            'verifyBlockType.pre.args[0]',
            'verifyBlockType.pre.args[1]',
            'verifyBlockType.pre.args[2]',
            'verifyInventorySlots.post.args[1]',
            'verifyInventorySlots.pre.args[1]',
        ]);
        const cleared = JSON.parse(JSON.stringify(skills));
        const applied = applyContractResets(cleared);
        assert.strictEqual(applied.length, manifest.resets.length);
        const resetNames = new Set(manifest.resets.map(r => r.skill));
        assert.strictEqual(resetNames.size, 10);
        for (const skill of cleared) {
            if (!resetNames.has(skill.name)) continue;
            assert.strictEqual(Object.hasOwn(skill, 'contract'), false, skill.name);
            assert.strictEqual(Object.hasOwn(skill, 'contractPrev'), false, skill.name);
            assert.strictEqual(Object.hasOwn(skill, 'contractFail'), false, skill.name);
            assert.strictEqual(typeof skill.code, 'string');
        }
        const kept = cleared.find(s => s.name === 'checkOakLog');
        assert.ok(kept.contract && kept.contract.pre);
    });

    it('a call argument does not excuse an inventory comparison; a non-item count does', () => {
        const sleep = {
            name: 'checkOakLog',
            code: 'async function checkOakLog(bot) { await sleep(bot, 55); const counts = getInventoryCounts(bot); return counts.oak_log < 55; }',
            contract: { pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' },
        };
        assert.ok(Voyager.copiedInventoryHits(sleep, registry).some(h => h.where === 'pre' && h.item === 'oak_log' && h.n === 55));
        const apple = {
            name: 'ensureInventorySpaceForApple',
            code: 'async function ensureInventorySpaceForApple(bot) { const emptySlots = bot.inventory.emptySlotCount(); return emptySlots < 10; }',
            contract: { pre: 'c => c.pre.inv.pink_petals < 10', post: 'c => true' },
        };
        assert.ok(!Voyager.copiedInventoryHits(apple, registry).some(h => h.item === 'pink_petals'));
    });

    it('c.args past the parameters after bot is rejected, and the error names that list', () => {
        const v = mkV({});
        const skill = { name: 'cookFood', code: 'async function cookFood(bot, count = 1) { return true; }', consumes: {}, effects: [] };
        const reason = v._validContract({ pre: 'c => c.args[1] >= 1', post: 'c => true' }, skill);
        assert.match(reason, /parameters after bot are \(count = 1\)/);
        assert.match(reason, /c\.args\[1\]/);
        assert.strictEqual(v._validContract({ pre: 'c => c.args[0] >= 1 && c.args.length === 1', post: 'c => true' }, skill), null);
        assert.match(v._validContract({ pre: 'c => c.args.length >= 2', post: 'c => true' }, skill), /arity 1/);
        const rest = { name: 'cookFood', code: 'async function cookFood(bot, count = 1, ...more) { return true; }', consumes: {}, effects: [] };
        assert.strictEqual(v._validContract({ pre: 'c => c.args[3] >= 1', post: 'c => true' }, rest), null);
        const mid = { name: 'place', code: 'async function place(bot, a, b = 1, c = 2) { return true; }', consumes: {}, effects: [] };
        assert.strictEqual(v._validContract({ pre: 'c => c.args.length === 2', post: 'c => true' }, mid), null);
        assert.strictEqual(v._validContract({ pre: 'c => c.args.length === 1', post: 'c => true' }, mid), null);
        assert.strictEqual(v._validContract({ pre: 'c => c.args.length === 3', post: 'c => true' }, mid), null);
        assert.match(v._validContract({ pre: 'c => c.args.length === 4', post: 'c => true' }, mid), /parameters after bot are \(a, b = 1, c = 2\)/);
        assert.match(v._validContract({ pre: 'c => c.args.length === 0', post: 'c => true' }, mid), /c\.args\.length compared to 0/);
        const midRest = { name: 'place', code: 'async function place(bot, a, b = 1, c = 2, ...more) { return more; }', consumes: {}, effects: [] };
        assert.strictEqual(v._validContract({ pre: 'c => c.args.length === 4', post: 'c => true' }, midRest), null);
        const derived = { name: 'cookFood', code: 'async function cookFood(bot, count = Number("1")) { return count >= 1; }', consumes: {}, effects: [] };
        assert.strictEqual(v._validContract({ pre: 'c => c.args[0] >= 1', post: 'c => true' }, derived), null);
        assert.strictEqual(derived.contractEval, Voyager.CONTRACT_EVAL);
        const invented = { name: 'cookFood', code: 'async function cookFood(bot, count = Number("1")) { return true; }', consumes: {}, effects: [] };
        assert.strictEqual(v._validContract({ pre: 'c => c.args[0] >= 1', post: 'c => true' }, invented), null);
        assert.strictEqual(invented.contractEval, Voyager.CONTRACT_EVAL);
        assert.strictEqual(v._validContract({ pre: 'c => true', post: 'c => true' }, invented), null);
        assert.strictEqual(Object.hasOwn(invented, 'contractEval'), false);
    });

    it('craftItem\'s typeof contract is accepted from a recorded call, a contradicting contract is rejected, and no call is pending', () => {
        const v = mkV({});
        const craft = {
            name: 'craftItem',
            code: 'async function craftItem(bot, itemName, target = 1) { if (!itemName) return false; return true; }',
            stats: { success: 1, fail: 0, streakFail: 0, tasks: [] },
        };
        const typeofString = { pre: "c => c.pre.alive && typeof c.args[0] === 'string' && (c.args.length === 1 || (c.args.length === 2 && typeof c.args[1] === 'number' && c.args[1] >= 1))", post: 'c => true' };
        assert.strictEqual(v._validContract(typeofString, craft), null);
        assert.strictEqual(craft.contractEval, Voyager.CONTRACT_EVAL);
        assert.strictEqual(Object.hasOwn(craft.stats, 'calls'), false);
        assert.strictEqual(Voyager.recordCallShape(craft, ['oak_planks', 1]), true);
        assert.strictEqual(Voyager.recordCallShape(craft, ['oak_planks', 1]), false);
        assert.strictEqual(craft.stats.calls.length, 1);
        assert.strictEqual(craft.stats.calls[0].shape, Voyager.CALL_SHAPE);
        assert.deepStrictEqual(craft.stats.calls[0].types, ['string', 'number']);
        assert.strictEqual(v._validContract(typeofString, craft), null);
        assert.strictEqual(Object.hasOwn(craft, 'contractEval'), false);
        assert.match(v._validContract({ pre: "c => typeof c.args[0] === 'number'", post: 'c => true' }, craft), /contradicts recorded call \("oak_planks", 1\)/);
        assert.strictEqual(Voyager.recordCallShape(craft, ['stick', 4]), true);
        assert.strictEqual(craft.stats.calls.length, 2);
        const named = Voyager.skillArgCounts({ name: 'take', code: 'function take(bot, { item }, [n]) { return item === null && n === 1; }' });
        assert.deepStrictEqual(named.names, ['{item}', '[n]']);
        assert.throws(() => Voyager.parameterSample({
            type: 'FunctionDeclaration',
            body: { type: 'FunctionExpression' },
            params: [{ type: 'Identifier', name: 'a' }],
        }, { type: 'Identifier', name: 'a' }), /FunctionExpression has no parameter list/);
        const pos = { x: 0, y: 64, z: 0 };
        const s = { pos, hp: 20, food: 20, sky: 15, alive: true, dim: 'overworld', inv: {}, free: 0, eq: { heldItem: null } };
        const live = {
            name: 'craftItem',
            code: craft.code,
            stats: { success: 0, fail: 0, streakFail: 0, tasks: [] },
            contract: typeofString,
            contractEval: Voyager.CONTRACT_EVAL,
        };
        v.skills = [live];
        v._repairQueue = [];
        v._checkContracts([{ name: 'craftItem', argv: ['oak_planks', 1], rv: true, s0: s, s1: s, delta: {}, intr: false }], true);
        assert.strictEqual(Object.hasOwn(live, 'contractEval'), false);
        assert.strictEqual(live.stats.calls.length, 1);
        assert.strictEqual(Object.hasOwn(live, 'contractFail'), false);
        v._checkContracts([{ name: 'craftItem', argv: ['oak_planks', 1], rv: true, s0: s, s1: s, delta: {}, intr: false }], true);
        assert.strictEqual(live.stats.calls.length, 1);
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
        assert.deepStrictEqual(Voyager.copiedInventoryHits({ ...skill, contract: { pre: 'c => true', post: 'c => true' } }, registry), []);
        assert.match(Voyager.prototype._learnContracts.toString(), /String\(e\.code\)/);
        assert.doesNotMatch(Voyager.prototype._learnContracts.toString(), /sourceForContractPrompt/);
        const coded = { name: 'checkOakLog', code: 'async function checkOakLog(bot) { const n = 55; return n; }', consumes: {}, effects: [] };
        assert.match(v._validContract({ pre: 'c => c.pre.inv.oak_log < 55', post: 'c => true' }, coded), /pre uses 55/);
        assert.deepStrictEqual(Voyager.copiedInventoryHits({ ...coded, contract: { pre: 'c => true', post: 'c => true' } }, registry), []);
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
            'checkOakLog.code.oak_log.55',
            'checkOakLog.pre.oak_log.55',
        ]);
        assert.deepStrictEqual(manifest.reasonLines, manifest.records.map(r => r.verdict));
        for (const r of manifest.records) assert.ok(r.verdict.startsWith(r.id), r.verdict);
        const byId = Object.fromEntries(manifest.records.map(r => [r.id, r.verdict]));
        assert.match(byId['checkOakLog.code.oak_log.55'], /not the parsed goal quantity of oak_log/);
        assert.match(byId['checkOakLog.pre.oak_log.55'], /not the parsed goal quantity of oak_log/);
        assert.strictEqual(manifest.checkOakLogPresent, true);
        const absent = [
            { name: 'smeltIronIntoIngot', code: 'async function smeltIronIntoIngot(bot) { const c = getInventoryCounts(bot); return c.raw_iron < 1; }', promptCounts: { raw_iron: 1 }, contract: { pre: 'c => true', post: 'c => true' } },
            { name: 'mineBlocks', code: 'async function mineBlocks(bot, blockName, count = 1) { return true; }', contract: { pre: 'c => c.args.length >= 2', post: 'c => true' } },
            { name: 'craftItem', code: 'async function craftItem(bot, itemName, target = 1) { return true; }', contract: { pre: 'c => c.args.length >= 2', post: 'c => true' } },
            { name: 'hasItemCount', code: 'async function hasItemCount(bot, name, count) { return true; }', contract: { pre: 'c => c.args.length >= 2', post: 'c => true' } },
            { name: 'ensureIngredientsAndCraft', code: 'async function ensureIngredientsAndCraft(bot, itemName, count = 1) { return true; }', contract: { pre: 'c => c.args.length >= 2', post: 'c => true' } },
            { name: 'craftArmorSet', code: 'async function craftArmorSet(bot, material = "iron") {\n  const counts = getInventoryCounts(bot);\n  if (counts.iron_ingot < 4) return false;\n  return true;\n}', promptCounts: { iron_ingot: 4 }, contract: { pre: 'c => true', post: 'c => c.ret === 4' } },
            { name: 'isSafeTarget', code: 'function isSafeTarget(bot, x, z, maxRange = 48) { return true; }', contract: { pre: 'c => c.args.length >= 2 && c.args.length <= 3', post: 'c => true' } },
        ];
        const cleared = buildContractManifest(absent);
        for (const id of ['smeltIronIntoIngot.code.1', 'mineBlocks.pre.2', 'craftItem.pre.2', 'hasItemCount.pre.2', 'ensureIngredientsAndCraft.pre.2', 'craftArmorSet.post.4', 'isSafeTarget.pre.2', 'isSafeTarget.pre.3']) {
            assert.ok(!cleared.records.some(r => r.id === id), `${id} in ${cleared.records.map(r => r.id).join(',')}`);
        }
    });

    it('the 21 live-index hits keep only an inventory count equal to the count the skill was generated from', () => {
        const fn = (name, body = 'return true;') => `async function ${name}(bot, a, b, c = 0) {\n  ${body}\n}`;
        const oakTask = 'Check inventory for oak_log and confirm count (currently 55) to ensure input is valid for crafting oak_planks';
        const skills = [
            { name: 'craftToolSet', code: fn('craftToolSet'), contract: { pre: 'c => true', post: 'c => Object.keys(c.post.inv).filter(k=>k.endsWith(\'_pickaxe\')||k.endsWith(\'_axe\')||k.endsWith(\'_sword\')).length === 3' } },
            { name: 'isSafeTarget', code: fn('isSafeTarget'), contract: { pre: 'c => c.args.length === 2 || (c.args.length === 3 && typeof c.args[2] === \'number\')', post: 'c => true' } },
            { name: 'craftArmorSet', code: fn('craftArmorSet'), contract: { pre: 'c => true', post: 'c => Number(c.ret) === 0 || (Number(c.ret) > 0 && Number(c.ret) <= 4 && c.post.alive)' } },
            { name: 'harvestCrop', code: fn('harvestCrop'), contract: { pre: 'c => true', post: 'c => Number(c.ret) >= 0 && Number(c.ret) <= (c.args[2]||4)' } },
            { name: 'breakBlockAt', code: fn('breakBlockAt'), contract: { pre: 'c => c.pre.alive && c.args[0] != null && c.args[1] != null && c.args[2] != null', post: 'c => true' } },
            { name: 'exploreForIronOre', code: fn('exploreForIronOre'), contract: { pre: 'c => true', post: 'c => c.dist(c.post.pos, {x: c.pre.pos.x + (c.args[0] % 3 - 1) * 40, y: c.pre.pos.y + Math.min(0, -8 - c.args[0] * 2), z: c.pre.pos.z}) <= 4' } },
            { name: 'scanForIronOreBlocks', code: fn('scanForIronOreBlocks'), contract: { pre: 'c => true', post: 'c => c.post.alive && c.dist(c.pre.pos, c.post.pos) < 0.5 && c.post.alive' } },
            { name: 'exploreForIronOreDeposit', code: fn('exploreForIronOreDeposit'), contract: { pre: 'c => true', post: 'c => c.dist(c.post.pos, {x: c.pre.pos.x, y: c.pre.pos.y, z: c.pre.pos.z}) <= 5' } },
            { name: 'mineIronOreDeposit', code: fn('mineIronOreDeposit'), contract: { pre: 'c => c.pre.alive && typeof c.args[1] === \'number\' && typeof c.args[2] === \'number\' && (c.pre.inv.raw_iron || 0) - c.args[1] < c.args[2]', post: 'c => { const startRaw = c.args[1], goal = c.args[2]; return true; }' } },
            { name: 'ensureStorageChestNearby', code: fn('ensureStorageChestNearby'), contract: { pre: 'c => true', post: 'c => c.ret !== true || (c.post.alive && c.post.dim === c.pre.dim && c.dist(c.pre.pos, c.post.pos) <= 64)' } },
            { name: 'equipBestPickaxeForIronOre', code: fn('equipBestPickaxeForIronOre'), contract: { pre: 'c => true', post: 'c => { const tier = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, golden_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }; return tier.diamond_pickaxe === 4 && tier.netherite_pickaxe === 5; }' } },
            { name: 'travelWestAvoidDeathHotspot', code: fn('travelWestAvoidDeathHotspot'), contract: { pre: 'c => true', post: 'c => c.dist(c.post.pos, {x:-178,y:53,z:107}) <= 8 && Math.abs(c.post.pos.y - 53) <= 6' } },
            { name: 'verifyBlockType', code: fn('verifyBlockType'), contract: { pre: 'c => c.args[0] === -28 && c.args[1] === 73 && c.args[2] === 56 && c.pre.alive', post: 'c => true' } },
            { name: 'chopDownTrees', code: fn('chopDownTrees'), contract: { pre: 'c => c.pre.sky > 5', post: 'c => true' } },
            { name: 'removeItem', code: fn('removeItem'), contract: { pre: 'c => c.args[2] === 0', post: 'c => true' } },
            { name: 'collectSurfaceDirt', code: fn('collectSurfaceDirt'), contract: { pre: 'c => c.pre.sky > 4 && c.pre.inv.iron_hoe !== undefined', post: 'c => true' } },
            {
                name: 'checkOakLog',
                task: oakTask,
                description: oakTask,
                code: fn('checkOakLog', 'const inventory = getInventoryCounts(bot);\n  if (inventory && inventory.oak_log >= 55) { return true; }\n  if (inventory.oak_log >= 55) { return true; }\n  log(bot, \'FAILED: Oak log count is less than 55\');\n  return false;'),
                contract: { pre: 'c => c.pre.inv.oak_log >= 55', post: 'c => c.ret', text: 'Check if oak_log count is at least 55 in the inventory.' },
                stats: { success: 2, fail: 0, tasks: ['reach oak_log'] },
                effectEvidence: { runs: 1, items: {} },
                consumeEvidence: { runs: 1, items: {} },
                effects: [],
                consumes: {},
                repairHistory: [{ evidence: 'failure only in non-library code checkOakLog (FAILED: Oak log count is less than 55 [food 0/20 health 10/20] | PRECONDITION violated: checkOakLog() does not satisfy its precondition c => c.pre.inv.oak_log >= 55)' }],
            },
            {
                name: 'craftBirchPlanks',
                task: 'Craft 4 birch_planks',
                code: fn('craftBirchPlanks', 'const counts = getInventoryCounts(bot);\n  return counts.birch_planks >= 4;'),
                promptCounts: { birch_planks: 4 },
                contract: { pre: 'c => c.pre.inv.birch_planks >= 4', post: 'c => true' },
            },
            {
                name: 'collectSevenDirt',
                task: 'Collect 7 dirt',
                code: fn('collectSevenDirt', 'const counts = getInventoryCounts(bot);\n  return counts.dirt >= 7;'),
                promptCounts: { dirt: 7 },
                contract: { pre: 'c => c.pre.inv.dirt >= 7', post: 'c => true' },
            },
        ];
        const manifest = buildContractManifest(skills);
        const wrong = [
            'craftToolSet.post.3', 'isSafeTarget.pre.2', 'craftArmorSet.post.4', 'harvestCrop.post.2', 'breakBlockAt.pre.2',
            'exploreForIronOre.post.4', 'scanForIronOreBlocks.post.0.5', 'exploreForIronOreDeposit.post.5',
            'mineIronOreDeposit.pre.2', 'mineIronOreDeposit.post.2', 'ensureStorageChestNearby.post.64',
            'equipBestPickaxeForIronOre.post.4', 'equipBestPickaxeForIronOre.post.5', 'travelWestAvoidDeathHotspot.post.6',
            'verifyBlockType.pre.2', 'chopDownTrees.pre.5', 'removeItem.pre.2', 'collectSurfaceDirt.pre.4',
            'craftBirchPlanks.pre.4', 'craftBirchPlanks.code.4', 'collectSevenDirt.pre.7', 'collectSevenDirt.code.7',
        ];
        for (const id of wrong) assert.ok(!manifest.records.some(r => r.id === id), id);
        assert.strictEqual(Voyager.countIsGameFact(registry, 'dirt', 7), false);
        assert.deepStrictEqual(manifest.records.map(r => r.id), ['checkOakLog.code.oak_log.55', 'checkOakLog.pre.oak_log.55']);
        assert.strictEqual(manifest.records.filter(r => r.id === 'checkOakLog.code.oak_log.55').length, 1);
        const code55 = manifest.records.find(r => r.id === 'checkOakLog.code.oak_log.55');
        assert.match(code55.evidence, /not the parsed goal quantity of oak_log/);
        assert.doesNotMatch(code55.evidence, /promptCounts|name:count|currently/);
        const dirtTask = 'collectSurface: Collect 32 dirt blocks within 32 blocks of the current position to ensure tilling surface is available for planting wheat_seeds';
        assert.ok(Voyager.goalQuantities(dirtTask).some(g => g.item === 'dirt' && g.n === 32));
        assert.strictEqual(mkV({})._resolveGoal(dirtTask).count, 32);
        assert.ok(!Voyager.goalQuantities(oakTask).some(g => g.n === 55));
    });

    it('the live check skills are the only records, and a kind-prefixed collect goal is not', () => {
        const fn = (name, body = 'return true;') => `async function ${name}(bot, a, b, c = 0) {\n  ${body}\n}`;
        const oakTask = 'Check inventory for oak_log and confirm count (currently 55) to ensure input is valid for crafting oak_planks';
        const leavesTask = 'Verify that oak_leaves count is currently 6 in inventory by checking item count';
        const dirtTask = 'collectSurface: Collect 32 dirt blocks within 32 blocks of the current position to ensure tilling surface is available for planting wheat_seeds';
        const dirtDesc = 'Collect 32 dirt blocks within 32 blocks of the current position to ensure tilling surface is available for planting wheat_seeds';
        const skills = [
            { name: 'craftToolSet', code: fn('craftToolSet'), contract: { pre: 'c => true', post: 'c => Object.keys(c.post.inv).filter(k=>k.endsWith(\'_pickaxe\')||k.endsWith(\'_axe\')||k.endsWith(\'_sword\')).length === 3' } },
            { name: 'isSafeTarget', code: fn('isSafeTarget'), contract: { pre: 'c => c.args.length === 2 || (c.args.length === 3 && typeof c.args[2] === \'number\')', post: 'c => true' } },
            { name: 'craftArmorSet', code: fn('craftArmorSet'), contract: { pre: 'c => true', post: 'c => Number(c.ret) === 0 || (Number(c.ret) > 0 && Number(c.ret) <= 4 && c.post.alive)' } },
            { name: 'harvestCrop', code: fn('harvestCrop'), contract: { pre: 'c => true', post: 'c => Number(c.ret) >= 0 && Number(c.ret) <= (c.args[2]||4)' } },
            { name: 'breakBlockAt', code: fn('breakBlockAt'), contract: { pre: 'c => c.pre.alive && c.args[0] != null && c.args[1] != null && c.args[2] != null', post: 'c => true' } },
            { name: 'exploreForIronOre', code: fn('exploreForIronOre'), contract: { pre: 'c => true', post: 'c => c.dist(c.post.pos, {x: c.pre.pos.x + (c.args[0] % 3 - 1) * 40, y: c.pre.pos.y + Math.min(0, -8 - c.args[0] * 2), z: c.pre.pos.z}) <= 4' } },
            { name: 'scanForIronOreBlocks', code: fn('scanForIronOreBlocks'), contract: { pre: 'c => true', post: 'c => c.post.alive && c.dist(c.pre.pos, c.post.pos) < 0.5 && c.post.alive' } },
            { name: 'exploreForIronOreDeposit', code: fn('exploreForIronOreDeposit'), contract: { pre: 'c => true', post: 'c => c.dist(c.post.pos, {x: c.pre.pos.x, y: c.pre.pos.y, z: c.pre.pos.z}) <= 5' } },
            { name: 'mineIronOreDeposit', code: fn('mineIronOreDeposit'), contract: { pre: 'c => c.pre.alive && typeof c.args[1] === \'number\' && typeof c.args[2] === \'number\' && (c.pre.inv.raw_iron || 0) - c.args[1] < c.args[2]', post: 'c => { const startRaw = c.args[1], goal = c.args[2]; return true; }' } },
            { name: 'ensureStorageChestNearby', code: fn('ensureStorageChestNearby'), contract: { pre: 'c => true', post: 'c => c.ret !== true || (c.post.alive && c.post.dim === c.pre.dim && c.dist(c.pre.pos, c.post.pos) <= 64)' } },
            { name: 'equipBestPickaxeForIronOre', code: fn('equipBestPickaxeForIronOre'), contract: { pre: 'c => true', post: 'c => { const tier = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, golden_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }; return tier.diamond_pickaxe === 4 && tier.netherite_pickaxe === 5; }' } },
            { name: 'travelWestAvoidDeathHotspot', code: fn('travelWestAvoidDeathHotspot'), contract: { pre: 'c => true', post: 'c => c.dist(c.post.pos, {x:-178,y:53,z:107}) <= 8 && Math.abs(c.post.pos.y - 53) <= 6' } },
            { name: 'verifyBlockType', code: fn('verifyBlockType'), contract: { pre: 'c => c.args[0] === -28 && c.args[1] === 73 && c.args[2] === 56 && c.pre.alive', post: 'c => true' } },
            { name: 'chopDownTrees', code: fn('chopDownTrees'), contract: { pre: 'c => c.pre.sky > 5', post: 'c => true' } },
            { name: 'removeItem', code: fn('removeItem'), contract: { pre: 'c => c.args[2] === 0', post: 'c => true' } },
            { name: 'collectSurfaceDirt', code: fn('collectSurfaceDirt'), contract: { pre: 'c => c.pre.sky > 4 && c.pre.inv.iron_hoe !== undefined', post: 'c => true' } },
            {
                name: 'checkOakLog',
                task: oakTask,
                description: oakTask,
                code: fn('checkOakLog', 'const inventory = getInventoryCounts(bot);\n  if (inventory && inventory.oak_log >= 55) { return true; }\n  if (inventory.oak_log >= 55) { return true; }\n  log(bot, \'FAILED: Oak log count is less than 55\');\n  return false;'),
                contract: { pre: 'c => c.pre.inv.oak_log >= 55', post: 'c => c.ret', text: 'Check if oak_log count is at least 55 in the inventory.' },
                stats: { success: 2, fail: 0, tasks: ['reach oak_log'] },
                repairHistory: [{ evidence: 'failure only in non-library code checkOakLog (FAILED: Oak log count is less than 55 [food 0/20 health 10/20] | PRECONDITION violated: checkOakLog() does not satisfy its precondition c => c.pre.inv.oak_log >= 55)' }],
            },
            {
                name: 'checkOakLeavesCount',
                task: leavesTask,
                description: leavesTask,
                code: 'async function checkOakLeavesCount(bot) {\n  const inventory = getInventoryCounts(bot);\n  if (inventory.oak_leaves === 6) { return true; } else { return false; }\n}',
                contract: { pre: 'c => c.pre.inv.oak_leaves === null', post: 'c => c.post.inv.oak_leaves === 6' },
                stats: { success: 1, fail: 2, streakFail: 2, practiceRuns: 3 },
                repairHistory: [],
            },
            {
                name: 'collectDirtForTilling',
                task: dirtTask,
                description: dirtDesc,
                code: 'async function collectDirtForTilling(bot, count = 32) {\n  let collected = 0;\n  while (collected < count) {\n    const block = getNearestBlocksWhere(bot, bl => bl.name === \'dirt\', 32, 1)[0];\n    if (!block) return collected;\n    collected += 1;\n  }\n  return collected;\n}',
                contract: { pre: 'c => c.pre.inv.dirt >= 32 || c.pre.free >= 32', post: 'c => c.ret >= 32' },
                repairHistory: [{ evidence: 'Pathfinding stopped: Cannot break stone with current tools. [food 4/20 health 16/20] | FAILED: navigation error: Path was stopped ...' }],
            },
            {
                name: 'craftBirchPlanks',
                task: 'Craft 4 birch_planks',
                code: fn('craftBirchPlanks', 'const counts = getInventoryCounts(bot);\n  return counts.birch_planks >= 4;'),
                contract: { pre: 'c => c.pre.inv.birch_planks >= 4', post: 'c => true' },
            },
            {
                name: 'collectSevenDirt',
                task: 'Collect 7 dirt',
                code: fn('collectSevenDirt', 'const counts = getInventoryCounts(bot);\n  return counts.dirt >= 7;'),
                contract: { pre: 'c => c.pre.inv.dirt >= 7', post: 'c => true' },
            },
        ];
        const manifest = buildContractManifest(skills);
        assert.ok(!Voyager.goalQuantities(leavesTask).some(g => g.item === 'oak_leaves' && g.n === 6));
        assert.deepStrictEqual(manifest.records.map(r => r.id), [
            'checkOakLog.code.oak_log.55',
            'checkOakLog.pre.oak_log.55',
            'checkOakLeavesCount.code.oak_leaves.6',
            'checkOakLeavesCount.post.oak_leaves.6',
        ]);
    });

    it('curriculum task text and the 21-entry texts do not throw or add records', () => {
        const v = mkV({});
        v.npGraph = { getFactsText: () => '' };
        const state = {
            inventory: { cobblestone: 8, oak_log: 55 }, position: '0, 64, 0', biome: 'plains', time: 'day (1000)',
            health_value: 20, health_max: 20, food_value: 17, food_max: 20, inventory_slots: '2/36', empty_inventory_slots: 34,
            equipment: { hand: 'empty', off_hand: 'empty', head: 'empty', torso: 'empty', legs: 'empty', feet: 'empty' },
            threats: 'none', nearby_blocks: ['oak_log', 'stone'], nearby_entities: [], dimension: 'overworld',
        };
        const oakTask = 'Check inventory for oak_log and confirm count (currently 55) to ensure input is valid for crafting oak_planks';
        const oakEvidence = 'failure only in non-library code checkOakLog (FAILED: Oak log count is less than 55 [food 0/20 health 10/20] | PRECONDITION violated: checkOakLog() does not satisfy its precondition c => c.pre.inv.oak_log >= 55)';
        const tier = '{ wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, golden_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }';
        const texts = [
            'Mine 5 birch_log',
            'Craft 1 stone_pickaxe',
            'Smelt 3 iron_ingot',
            'Build a 5x5 cobblestone floor next to the hut',
            'Smelt 3 raw_iron into 3 iron_ingot',
            'ensure crafting_table',
            'Collect 1 stripped_birch_wood',
            'Mine 8 iron_ore',
            'Collect 4 oak_log',
            'Get 2 stick',
            'Kill 1 zombie',
            'Harvest 4 wheat',
            'Craft 1 iron_pickaxe using 3 iron_ingot and 2 stick',
            'Mine 5 birch_log within 32 blocks',
            oakTask,
            oakEvidence,
            tier,
            v._codeState(state),
            v._compactState(state),
            v._stateText(state),
            'c => Object.keys(c.post.inv).filter(k=>k.endsWith(\'_pickaxe\')||k.endsWith(\'_axe\')||k.endsWith(\'_sword\')).length === 3',
            'c => c.args.length === 2 || (c.args.length === 3 && typeof c.args[2] === \'number\')',
            'c => Number(c.ret) === 0 || (Number(c.ret) > 0 && Number(c.ret) <= 4 && c.post.alive)',
            'c => Number(c.ret) >= 0 && Number(c.ret) <= (c.args[2]||4)',
            'c => c.pre.alive && c.args[0] != null && c.args[1] != null && c.args[2] != null',
            'c => c.dist(c.post.pos, {x: c.pre.pos.x + (c.args[0] % 3 - 1) * 40, y: c.pre.pos.y + Math.min(0, -8 - c.args[0] * 2), z: c.pre.pos.z}) <= 4',
            'c => c.post.alive && c.dist(c.pre.pos, c.post.pos) < 0.5 && c.post.alive',
            'c => c.dist(c.post.pos, {x: c.pre.pos.x, y: c.pre.pos.y, z: c.pre.pos.z}) <= 5',
            'c => c.pre.alive && typeof c.args[1] === \'number\' && typeof c.args[2] === \'number\' && (c.pre.inv.raw_iron || 0) - c.args[1] < c.args[2]',
            'c => { const startRaw = c.args[1], goal = c.args[2]; return true; }',
            'c => c.ret !== true || (c.post.alive && c.post.dim === c.pre.dim && c.dist(c.pre.pos, c.post.pos) <= 64)',
            'c => c.dist(c.post.pos, {x:-178,y:53,z:107}) <= 8 && Math.abs(c.post.pos.y - 53) <= 6',
            'c => c.args[0] === -28 && c.args[1] === 73 && c.args[2] === 56 && c.pre.alive',
            'c => c.pre.sky > 5',
            'c => c.args[2] === 0',
            'c => c.pre.sky > 4 && c.pre.inv.iron_hoe !== undefined',
            'c => c.pre.inv.oak_log >= 55',
        ];
        const codeOf = (name, body) => `async function ${name}(bot) {\n  ${body}\n}`;
        const base = [
            { name: 'craftToolSet', code: codeOf('craftToolSet', 'return true;'), contract: { pre: 'c => true', post: texts[20] } },
            { name: 'isSafeTarget', code: codeOf('isSafeTarget', 'return true;'), contract: { pre: texts[21], post: 'c => true' } },
            { name: 'craftArmorSet', code: codeOf('craftArmorSet', 'return true;'), contract: { pre: 'c => true', post: texts[22] } },
            { name: 'harvestCrop', code: codeOf('harvestCrop', 'return true;'), contract: { pre: 'c => true', post: texts[23] } },
            { name: 'breakBlockAt', code: codeOf('breakBlockAt', 'return true;'), contract: { pre: texts[24], post: 'c => true' } },
            { name: 'exploreForIronOre', code: codeOf('exploreForIronOre', 'return true;'), contract: { pre: 'c => true', post: texts[25] } },
            { name: 'scanForIronOreBlocks', code: codeOf('scanForIronOreBlocks', 'return true;'), contract: { pre: 'c => true', post: texts[26] } },
            { name: 'exploreForIronOreDeposit', code: codeOf('exploreForIronOreDeposit', 'return true;'), contract: { pre: 'c => true', post: texts[27] } },
            { name: 'mineIronOreDeposit', code: codeOf('mineIronOreDeposit', 'return true;'), contract: { pre: texts[28], post: texts[29] } },
            { name: 'ensureStorageChestNearby', code: codeOf('ensureStorageChestNearby', 'return true;'), contract: { pre: 'c => true', post: texts[30] } },
            { name: 'equipBestPickaxeForIronOre', code: codeOf('equipBestPickaxeForIronOre', 'return true;'), contract: { pre: 'c => true', post: `c => { const tier = ${tier}; return tier.diamond_pickaxe === 4 && tier.netherite_pickaxe === 5; }` } },
            { name: 'travelWestAvoidDeathHotspot', code: codeOf('travelWestAvoidDeathHotspot', 'return true;'), contract: { pre: 'c => true', post: texts[31] } },
            { name: 'verifyBlockType', code: codeOf('verifyBlockType', 'return true;'), contract: { pre: texts[32], post: 'c => true' } },
            { name: 'chopDownTrees', code: codeOf('chopDownTrees', 'return true;'), contract: { pre: texts[33], post: 'c => true' } },
            { name: 'removeItem', code: codeOf('removeItem', 'return true;'), contract: { pre: texts[34], post: 'c => true' } },
            { name: 'collectSurfaceDirt', code: codeOf('collectSurfaceDirt', 'return true;'), contract: { pre: texts[35], post: 'c => true' } },
            {
                name: 'checkOakLog',
                code: codeOf('checkOakLog', 'const inventory = getInventoryCounts(bot);\n  if (inventory && inventory.oak_log >= 55) return true;\n  return false;'),
                contract: { pre: texts[36], post: 'c => c.ret' },
            },
        ];
        const wrong = [
            'craftToolSet.post.3', 'isSafeTarget.pre.2', 'craftArmorSet.post.4', 'harvestCrop.post.2', 'breakBlockAt.pre.2',
            'exploreForIronOre.post.4', 'scanForIronOreBlocks.post.0.5', 'exploreForIronOreDeposit.post.5',
            'mineIronOreDeposit.pre.2', 'mineIronOreDeposit.post.2', 'ensureStorageChestNearby.post.64',
            'equipBestPickaxeForIronOre.post.4', 'equipBestPickaxeForIronOre.post.5', 'travelWestAvoidDeathHotspot.post.6',
            'verifyBlockType.pre.2', 'chopDownTrees.pre.5', 'removeItem.pre.2', 'collectSurfaceDirt.pre.4',
        ];
        for (const text of texts) {
            Voyager.goalQuantities(text);
            for (const field of ['task', 'description', 'repairHistory']) {
                const skills = base.map(s => {
                    const copy = { ...s, contract: { ...s.contract } };
                    if (field === 'repairHistory') copy.repairHistory = [{ evidence: text }];
                    else copy[field] = text;
                    return copy;
                });
                const manifest = buildContractManifest(skills);
                for (const id of wrong) assert.ok(!manifest.records.some(r => r.id === id), `${field} ${JSON.stringify(text).slice(0, 80)} -> ${id}`);
                const ids = manifest.records.map(r => r.id);
                for (const id of ids) assert.ok(id === 'checkOakLog.code.oak_log.55' || id === 'checkOakLog.pre.oak_log.55', `${field} produced ${id} from ${JSON.stringify(text).slice(0, 120)}`);
            }
        }
        const withState = base.map(s => ({ ...s, contract: { ...s.contract }, description: v._compactState(state), repairHistory: [{ evidence: oakEvidence }] }));
        const oak = withState.find(s => s.name === 'checkOakLog');
        oak.task = oakTask;
        const manifest = buildContractManifest(withState);
        assert.deepStrictEqual(manifest.records.map(r => r.id).sort(), ['checkOakLog.code.oak_log.55', 'checkOakLog.pre.oak_log.55']);
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
        const entries = [{ item: 'oak_log', n: 55, source: 'promptCounts' }];
        const bound = 'async function checkOakLog(bot) {\n  const counts = getInventoryCounts(bot);\n  const need = 55;\n  return counts.oak_log >= need;\n}';
        const aliased = 'async function checkOakLog(bot) {\n  const counts = getInventoryCounts(bot);\n  const n = counts.oak_log;\n  return n >= 55;\n}';
        const both = 'async function checkOakLog(bot) {\n  const counts = getInventoryCounts(bot);\n  const need = 55;\n  const n = counts.oak_log;\n  return n >= need;\n}';
        for (const src of [bound, aliased, both]) {
            const hits = Voyager.copiedCountComparisons(src, entries, registry);
            assert.ok(hits.some(h => h.item === 'oak_log' && h.n === 55), src);
        }
        const one = 'async function placeTable(bot) {\n  const counts = getInventoryCounts(bot);\n  return counts.crafting_table >= 1;\n}';
        const sticks = 'async function craftSticks(bot) {\n  const counts = getInventoryCounts(bot);\n  return counts.stick < 2;\n}';
        const raw = 'async function smeltIronIntoIngot(bot) {\n  const counts = getInventoryCounts(bot);\n  return counts.raw_iron < 1;\n}';
        assert.deepStrictEqual(Voyager.copiedCountComparisons(one, [{ item: 'crafting_table', n: 1, source: 'promptCounts' }], registry), []);
        assert.deepStrictEqual(Voyager.copiedCountComparisons(sticks, [{ item: 'stick', n: 2, source: 'promptCounts' }], registry), []);
        assert.deepStrictEqual(Voyager.copiedCountComparisons(raw, [{ item: 'raw_iron', n: 1, source: 'promptCounts' }], registry), []);
    });

    it('a depth-2 goal still decomposes, and a queued split is not repeated on a clock', async () => {
        const v = mkV({});
        v._askLocal = async () => { throw new Error('the model must not rewrite an item goal'); };
        v._producers = () => [];
        v._curSub = { task: 'Collect 1 apple', depth: 2 };
        v.agent.bot.game = { gameMode: 'survival' };
        v.agent.bot.entity = { eyeHeight: 1.62, position: { x: 0, y: 64, z: 0 } };
        v.agent.bot.world = {};
        v.agent.bot.waitForTicks = async () => {};
        v.agent.bot.pathfinder = {
            movements: {},
            tickTimeout: 40,
            getPathFromTo: function * () { yield { result: { status: 'success', cost: 1 } }; },
        };
        v.observe = () => ({ inventory: {}, nearby_blocks: ['oak_leaves'], perceived_at: { oak_leaves: { x: 1, y: 70, z: 1 } } });
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
        assert.throws(() => getNearbyBlockTypes(bot), /position/);
        assert.throws(() => getNearbyBlocks(bot), /position/);
        assert.strictEqual(scanned, false);
        const sig = getBareAPI().byName.getNearestBlocks.sig;
        assert.match(sig, /block_types: string\|string\[\]\|null/);
        assert.match(sig, /distance: number/);
        assert.match(sig, /count: number/);
        assert.doesNotMatch(sig, /10000/);
        assert.doesNotMatch(getBareAPI().byName.getNearbyBlockTypes.sig, /distance/);
        assert.doesNotMatch(getBareAPI().byName.getNearbyBlocks.sig, /distance/);
        assert.doesNotMatch(getBareAPI().byName.getNearbyBlocks.sig, /=/);
        const { CHUNK_WIDTH } = require('prismarine-chunk/src/pc/common/constants.js');
        assert.throws(() => nearbyBlockRadius({}), /viewDistance/);
        assert.throws(() => nearbyBlockRadius({ game: {}, settings: { viewDistance: 'far' } }), /client request/);
        assert.throws(() => nearbyBlockRadius({ game: { serverViewDistance: 0 } }), /viewDistance is 0/);
        assert.throws(() => nearbyBlockRadius({ game: { simulationDistance: 4 } }), /viewDistance is undefined/);
        assert.strictEqual(nearbyBlockRadius({ game: { serverViewDistance: 8 } }), 8 * CHUNK_WIDTH);
        assert.strictEqual(nearbyBlockRadius({ game: { serverViewDistance: 10, simulationDistance: 5 } }), 10 * CHUNK_WIDTH);
        const { BLOCK_SECTION_VOLUME, SECTION_HEIGHT } = require('prismarine-chunk/src/pc/common/constants.js');
        const stoneId = registry.blocksByName.stone.defaultState;
        const oakLogId = registry.blocksByName.oak_log.defaultState;
        const diamondId = registry.blocksByName.diamond_ore.defaultState;
        const emeraldId = registry.blocksByName.emerald_ore.defaultState;
        const dirtId = registry.blocksByName.dirt.defaultState;
        assert.strictEqual(registry.blocksByStateId[stoneId].boundingBox, 'block');
        assert.notStrictEqual(registry.blocksByStateId[stoneId].transparent, true);
        const eyeHeight = 1.62;
        const feetY = 64;
        const minY = -64;
        const viewDistance = 10;
        const diamondY = feetY - 111;
        let cellReads = 0;
        let farReads = 0;
        const stoneOnly = { palette: [stoneId], data: { value: stoneId } };
        const eyeOriginY = minY + ((feetY - minY) >> 4) * SECTION_HEIGHT;
        const stateOf = (x, y, z) => {
            if (y >= diamondY - (diamondY - minY) % SECTION_HEIGHT && y < diamondY - (diamondY - minY) % SECTION_HEIGHT + SECTION_HEIGHT && x >= 0 && x < 16 && z >= 0 && z < 16) return diamondId;
            if (x === 8 && z === 10 && y >= feetY && y <= feetY + 2) return stoneId;
            if (x === 8 && y === feetY + 1 && z === 12) return dirtId;
            if (x === 8 && y === feetY + 1 && z === 11) return 0;
            if (x === 8 && (y === feetY + 1 || y === feetY + 2) && z === 8) return 0;
            return stoneId;
        };
        const eyeSection = {
            palette: [stoneId, oakLogId, dirtId],
            data: { get(index) {
                cellReads += 1;
                const lx = index & 15, lz = (index >> 4) & 15, ly = (index >> 8) & 15;
                return stateOf(lx, eyeOriginY + ly, lz);
            } },
        };
        const diamondOrigin = minY + ((diamondY - minY) >> 4) * SECTION_HEIGHT;
        const diamondSection = {
            palette: [diamondId],
            data: { get() { cellReads += 1; return diamondId; } },
        };
        const stoodSections = Array.from({ length: 24 }, (_, si) => {
            const originY = minY + si * SECTION_HEIGHT;
            if (originY === eyeOriginY) return eyeSection;
            if (originY === diamondOrigin) return diamondSection;
            return stoneOnly;
        });
        const columns = [];
        for (let cz = -viewDistance; cz <= viewDistance; cz++) {
            for (let cx = -viewDistance; cx <= viewDistance; cx++) {
                columns.push({ chunkX: cx, chunkZ: cz, column: { minY, sections: cx === 0 && cz === 0 ? stoodSections : Array.from({ length: 24 }, () => stoneOnly) } });
            }
        }
        const outside = {
            palette: [emeraldId],
            data: { get() { farReads += 1; throw new Error('emerald_ore outside view distance was read'); } },
        };
        columns.push({ chunkX: viewDistance + 1, chunkZ: 0, column: { minY, sections: [outside] } });
        const raycast = (from, dir, range) => {
            // The aim point is the face. Step just past it so the sample lands in the block, which is what
            // prismarine-world's shape intersection reports (the measurement fixture uses that raycast).
            let hit = null;
            for (let t = 0; t <= range + 0.05; t += 0.05) {
                const x = Math.floor(from.x + dir.x * t);
                const y = Math.floor(from.y + dir.y * t);
                const z = Math.floor(from.z + dir.z * t);
                const id = stateOf(x, y, z);
                const block = registry.blocksByStateId[id];
                if (id !== 0 && block && block.boundingBox === 'block' && block.transparent !== true) {
                    hit = { position: { x, y, z } };
                    break;
                }
            }
            return hit;
        };
        const viewBot = {
            game: { serverViewDistance: viewDistance, gameMode: 'survival' },
            registry,
            entity: { position: new Vec3(8, feetY, 8), eyeHeight },
            blockAt() { return null; },
            findBlocks() { throw new Error('nearby blocks must not call findBlocks'); },
            world: { getColumns() { return columns; }, on() {} },
        };
        const nearbyNames = getNearbyBlockTypes(viewBot);
        const stats = perceivedStats(viewBot);
        const readsAfterIndex = cellReads;
        getNearbyBlockTypes(viewBot);
        assert.strictEqual(cellReads, readsAfterIndex, 'a second observe does not re-read indexed sections');
        const cube = (viewDistance * CHUNK_WIDTH * 2 + 1) ** 3;
        assert.ok(nearbyNames.includes('stone'), 'an exposed stone face the ray hits is perceived');
        assert.ok(!nearbyNames.includes('dirt'), 'dirt behind the wall is occluded');
        assert.ok(!nearbyNames.includes('oak_log'), 'a palette entry no cell still holds is not perceived');
        assert.ok(!nearbyNames.includes('diamond_ore'), 'buried diamond_ore has no face open to a non-occluding block');
        assert.ok(!nearbyNames.includes('emerald_ore'), 'emerald_ore outside the view distance is not read');
        assert.strictEqual(farReads, 0);
        assert.ok(cellReads > 0);
        assert.ok(cellReads < BLOCK_SECTION_VOLUME * 16, `cell reads ${cellReads} walked more than a handful of sections`);
        assert.ok(cellReads < cube, `cell reads ${cellReads} against the view-distance cube ${cube}`);
        assert.ok(stats.candidates > 0 && stats.candidates < BLOCK_SECTION_VOLUME, `candidates ${stats.candidates} allocated a section or more`);
        assert.ok(stats.candidates < cube);
        assert.strictEqual(stats.raycasts, 0);
        assert.ok(stats.ddaSteps > 0 && stats.ddaRays > 0 && stats.ddaRays <= stats.candidates);
        const listed = getNearbyBlocks(viewBot);
        const stone = listed.find(b => b.name === 'stone');
        assert.ok(stone, 'an exposed stone is in the block list');
        assert.ok(Number.isInteger(stone.x) && Number.isInteger(stone.y) && Number.isInteger(stone.z));
        assert.ok(!listed.some(b => b.name === 'diamond_ore' || b.name === 'oak_log' || b.name === 'emerald_ore' || b.name === 'dirt'));
        const queriesSrc = readFileSync(new URL('../src/agent/commands/queries.js', import.meta.url), 'utf8');
        assert.match(queriesSrc, /world\.getNearbyBlocks\(bot\)/);
        assert.doesNotMatch(queriesSrc, /getNearbyBlocks\(bot,/);
        assert.doesNotMatch(queriesSrc, /nearbyBlockRadius/);
        const hole = Array.from({ length: 24 }, () => stoneOnly);
        hole[(feetY - minY) >> 4] = null;
        const holeColumns = [];
        for (let cz = -viewDistance; cz <= viewDistance; cz++) {
            for (let cx = -viewDistance; cx <= viewDistance; cx++) {
                holeColumns.push({ chunkX: cx, chunkZ: cz, column: { minY, sections: cx === 0 && cz === 0 ? hole : Array.from({ length: 24 }, () => stoneOnly) } });
            }
        }
        const missingNeighbor = columns.filter(c => !(c.chunkX === 1 && c.chunkZ === 0));
        assert.doesNotThrow(() => getNearbyBlockTypes({
            game: { serverViewDistance: viewDistance, gameMode: 'survival' },
            registry,
            entity: { position: new Vec3(8, feetY, 8), eyeHeight },
            world: { getColumns() { return missingNeighbor; }, on() {} },
        }));
        const notStanding = columns.filter(c => !(c.chunkX === 0 && c.chunkZ === 0));
        assert.throws(() => getNearbyBlockTypes({
            game: { serverViewDistance: viewDistance, gameMode: 'survival' },
            registry,
            entity: { position: new Vec3(8, feetY, 8), eyeHeight },
            world: { getColumns() { return notStanding; }, on() {} },
        }), /standing in/);
        assert.throws(() => getNearbyBlockTypes({
            game: { serverViewDistance: viewDistance },
            registry,
            entity: { position: new Vec3(8, feetY, 8), eyeHeight },
            world: { getColumns() { return holeColumns; }, on() {} },
        }), /not loaded/);
        assert.throws(() => getNearbyBlockTypes({ game: { serverViewDistance: viewDistance }, registry, entity: { position: new Vec3(8, feetY, 8), eyeHeight } }), /getColumns/);
        const { EventEmitter } = require('events');
        const client = new EventEmitter();
        const gameBot = {
            _client: client,
            supportFeature(name) { return name === 'dimensionIsAString' || name === 'customChannelIdentifier'; },
            emit() {},
            registry: { dimensionsByName: {} },
        };
        client.registerChannel = () => {};
        client.writeChannel = () => {};
        require('mineflayer/lib/plugins/game.js')(gameBot, { brand: 'test' });
        client.emit('login', { dimension: 'overworld', gameMode: 0, maxPlayers: 20, viewDistance: 6, simulationDistance: 4 });
        assert.strictEqual(gameBot.game.serverViewDistance, 6);
        assert.strictEqual(gameBot.game.simulationDistance, undefined);
        assert.strictEqual(nearbyBlockRadius(gameBot), 6 * CHUNK_WIDTH);
        client.emit('simulation_distance', { distance: 7 });
        assert.strictEqual(gameBot.game.simulationDistance, undefined);
        assert.strictEqual(nearbyBlockRadius(gameBot), 6 * CHUNK_WIDTH);
        client.emit('update_view_distance', { viewDistance: 9 });
        assert.strictEqual(gameBot.game.serverViewDistance, 9);
        assert.strictEqual(nearbyBlockRadius(gameBot), 9 * CHUNK_WIDTH);
        assert.throws(() => client.emit('update_view_distance', { viewDistance: 9.5 }), /varint/);
        assert.strictEqual(gameBot.game.serverViewDistance, 9);
        assert.match(Voyager.prototype._pursueProposedTask.toString(), /maxDistance and count are finite numbers/);
        assert.match(Voyager.prototype._pursueProposedTask.toString(), /findBlock\(options\) returns one block and does not take count/);
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

describe('fix97 reachability is a pathfinder search per target', () => {
    it('the food planner calls getPathTo once for each source it still has to judge', async () => {
        const v = mkV({});
        const calls = [];
        v.agent.bot.game = { gameMode: 'survival' };
        v.agent.bot.entity = { eyeHeight: 1.62, position: { x: 0, y: 64, z: 0 } };
        v.agent.bot.world = {};
        v.agent.bot.waitForTicks = async () => {};
        v.agent.bot.pathfinder = {
            movements: { id: 'bot-movements' },
            tickTimeout: 40,
            getPathFromTo: function * (movements, start, goal) {
                assert.strictEqual(movements, v.agent.bot.pathfinder.movements);
                calls.push(goal.pos.x);
                yield { result: { status: goal.pos.x === 4 ? 'noPath' : 'success', cost: goal.pos.x } };
            },
        };
        const src = v._obtainPlanner({ inventory: {}, nearby_blocks: [], perceived_at: {} }).sources('raw_iron');
        assert.ok(src.length >= 2, `raw_iron sources: ${src.join(', ')}`);
        const state = {
            inventory: { stone_pickaxe: 1 },
            nearby_blocks: [...src, 'dirt'],
            perceived_at: { [src[0]]: { x: 4, y: 12, z: 4 }, [src[1]]: { x: 8, y: 12, z: 4 } },
        };
        assert.deepStrictEqual(calls, [], 'an unjudged source is not a path status');
        assert.throws(() => v._pathStatus(state, src[0]), /has not been searched/);
        await v._judgeTargets(state, src, false);
        const pre = v._obtainPlanner(state).prerequisites('raw_iron', 1, state.inventory);
        assert.strictEqual(pre.how, 'collect');
        assert.deepStrictEqual(calls, [4, 8], `pathfinder targets were ${calls.join(', ')} for sources ${src.join(', ')}`);
        calls.length = 0;
        const namedOnly = { inventory: { stone_pickaxe: 1 }, nearby_blocks: [src[0], 'dirt'], perceived_at: {} };
        await v._judgeTargets(namedOnly, src, false);
        assert.deepStrictEqual(calls, [], 'a nearby name with no perceived position is not a pathfinder target');
        const direct = await pathToBlock(v.agent.bot, { x: 8, y: 12, z: 4 });
        assert.strictEqual(direct.status, 'success');
        v.agent.bot.pathfinder.getPathFromTo = function * () { return { result: { status: 'partial', path: [] } }; };
        await assert.rejects(pathToBlock(v.agent.bot, { x: 8, y: 12, z: 4 }), /partial/);
    });
    it('getPathFromTo is stepped until it finishes, and a partial slice is not a reach need', async () => {
        const v = mkV({});
        const calls = [];
        v.agent.bot.game = { gameMode: 'survival' };
        v.agent.bot.entity = { eyeHeight: 1.62, position: { x: 0, y: 64, z: 0 } };
        v.agent.bot.world = {};
        v.agent.bot.waitForTicks = async () => {};
        v.agent.bot.pathfinder = {
            movements: { id: 'bot-movements' },
            tickTimeout: 40,
            getPathTo() { throw new Error('getPathTo takes one slice'); },
            getPathFromTo: function * (movements, start, goal) {
                calls.push(goal.pos.x);
                yield { result: { status: 'partial', path: [] } };
                yield { result: { status: goal.pos.x === 4 ? 'noPath' : 'success', cost: goal.pos.x } };
            },
        };
        const src = v._obtainPlanner({ inventory: {}, nearby_blocks: [], perceived_at: {} }).sources('raw_iron');
        const state = {
            inventory: { stone_pickaxe: 1 },
            nearby_blocks: [...src, 'dirt'],
            perceived_at: { [src[0]]: { x: 4, y: 12, z: 4 }, [src[1]]: { x: 8, y: 12, z: 4 } },
        };
        assert.deepStrictEqual(calls, []);
        assert.throws(() => v._pathStatus(state, src[0]), /has not been searched/);
        await v._judgeTargets(state, src, false);
        const pre = v._obtainPlanner(state).prerequisites('raw_iron', 1, state.inventory);
        assert.strictEqual(pre.how, 'collect');
        assert.deepStrictEqual(calls, [4, 8]);
        const direct = await pathToBlock(v.agent.bot, { x: 8, y: 12, z: 4 });
        assert.strictEqual(direct.status, 'success');
    });
    it('a target that takes more than one tick of search ends in success', async () => {
        const turns = [];
        let turn = 0;
        const bot = {
            game: { gameMode: 'survival' },
            entity: { eyeHeight: 1.62, position: { x: 0, y: 64, z: 0 } },
            world: {},
            waitForTicks: async () => { turn += 1; },
            pathfinder: {
                movements: {},
                tickTimeout: 40,
                getPathTo() { throw new Error('getPathTo takes one slice'); },
                getPathFromTo: function * () {
                    turns.push(turn);
                    yield { result: { status: 'partial', path: [] } };
                    turns.push(turn);
                    yield { result: { status: 'partial', path: [] } };
                    turns.push(turn);
                    yield { result: { status: 'success', path: [{ x: 8 }] } };
                },
            },
        };
        const result = await pathToBlock(bot, { x: 30, y: 64, z: 0 });
        assert.strictEqual(result.status, 'success');
        assert.deepStrictEqual(turns, [0, 1, 2], 'each partial slice yields before the next tickTimeout slice');
        assert.strictEqual(turn, 2);
    });
});

describe('fix97 observe on a view-distance world', () => {
    it('layered terrain is indexed once per chunk and observe reads that index', async () => {
        const { performance } = require('perf_hooks');
        const viewDistance = 10;
        const minY = -64;
        const feetY = serverHeight(8, 8) + 1;
        const world = await buildServerTerrain(registry, viewDistance, { plants: true });
        world.setBlockStateId(new Vec3(9, serverHeight(9, 8) + 1, 8), registry.blocksByName.wheat.defaultState);
        world.setBlockStateId(new Vec3(10, serverHeight(10, 8) + 1, 8), registry.blocksByName.sugar_cane.defaultState);
        const bot = {
            game: { serverViewDistance: viewDistance, gameMode: 'survival', dimension: 'overworld', minY, height: 384 },
            registry,
            version: VER,
            health: 20,
            food: 20,
            oxygenLevel: 300,
            heldItem: null,
            time: { timeOfDay: 6000 },
            entities: {},
            entity: { position: new Vec3(8.5, feetY, 8.5), eyeHeight: 1.62 },
            inventory: { items: () => [], emptySlotCount: () => 36, slots: new Array(46).fill(null) },
            world,
        };
        const v = Object.create(Voyager.prototype);
        v.agent = { bot, recentDeaths: [] };
        v._recovery = () => ({ blocked: false });
        v._hunger = () => ({ urgent: false, belowRegen: false });
        v._getChestFacts = () => [];
        v._threats = () => 'none';
        v._deathHotspots = () => 'none';
        if (typeof global.gc === 'function') global.gc();
        const heapBefore = process.memoryUsage().heapUsed;
        const built = await indexPerceivedChunks(bot);
        if (typeof global.gc === 'function') global.gc();
        const heapAfterIndex = process.memoryUsage().heapUsed;
        const perChunk = built.chunks ? built.ms / built.chunks : 0;
        const maxChunk = built.perChunkMs.reduce((m, t) => t > m ? t : m, 0);
        const t0 = performance.now();
        const state = v.observe();
        const ms = performance.now() - t0;
        const stats = perceivedStats(bot);
        const t1 = performance.now();
        const second = v.observe();
        const secondMs = performance.now() - t1;
        const secondStats = perceivedStats(bot);
        const build = perceivedBuildStats(bot);
        const { BLOCK_SECTION_VOLUME } = require('prismarine-chunk/src/pc/common/constants.js');
        for (const name of ['grass_block', 'oak_log', 'oak_leaves', 'water', 'short_grass', 'poppy', 'wheat', 'sugar_cane']) {
            assert.ok(state.nearby_blocks.includes(name), `${name} missing from ${state.nearby_blocks.join(',')}`);
        }
        assert.ok(!state.nearby_blocks.includes('copper_block'), 'buried copper_block is seen from the surface');
        assert.ok(!state.nearby_blocks.includes('emerald_ore'), 'enclosed emerald_ore is seen from the surface');
        assert.ok(!state.nearby_blocks.includes('bedrock'));
        assert.match(state.perception, /^index complete, \d+ of \d+ chunks$/);
        assert.ok(stats.sectionsReached > 0 && stats.sectionsReached < build.sectionsBuilt);
        assert.ok(stats.candidates > 0 && stats.candidates < BLOCK_SECTION_VOLUME, `candidates ${stats.candidates}`);
        assert.strictEqual(stats.raycasts, 0);
        assert.ok(stats.ddaSteps > 0 && stats.ddaRays > 0);
        assert.deepStrictEqual(second.nearby_blocks, state.nearby_blocks);
        assert.strictEqual(secondStats.ddaSteps, 0);
        assert.strictEqual(secondStats.raycasts, 0);
        assert.strictEqual(stats.cellReads, 0);
        assert.strictEqual(build.cellReads, built.cellReads);
        assert.strictEqual(built.chunks, (viewDistance * 2 + 1) ** 2);
        assert.ok(ms < 2000, `observe took ${ms} ms`);
        assert.ok(secondMs < 2000, `second observe took ${secondMs} ms`);
        console.log(`[fix97] server terrain view-distance ${viewDistance}: index ${built.chunks} chunks in ${built.ms.toFixed(1)} ms (${perChunk.toFixed(2)} ms/chunk, max ${maxChunk.toFixed(2)}), cell reads ${built.cellReads}, sections ${built.sectionsBuilt} skipped ${built.sectionsSkipped}, heap +${((heapAfterIndex - heapBefore) / 1e6).toFixed(1)} MB; observe ${ms.toFixed(1)} ms then ${secondMs.toFixed(1)} ms, sections reached ${stats.sectionsReached}, candidates ${stats.candidates}, dda ${stats.ddaRays}/${stats.ddaSteps}, names ${state.nearby_blocks.join(',')}`);
    });

    it('a cave the bot is standing in is perceived, and a dug shaft makes that cave visible from the surface', async () => {
        const viewDistance = 2;
        const world = await buildServerTerrain(registry, viewDistance, { plants: false });
        const column = makeServerChunk(registry, 0, 0);
        let cy = null;
        for (let y = 10; y < 45; y++) if (column.getBlockStateId(new Vec3(5, y, 5)) === 0) { cy = y; break; }
        assert.ok(cy !== null, 'the enclosed cave has no air cell');
        const make = (x, y, z) => ({
            game: { serverViewDistance: viewDistance, gameMode: 'survival' },
            registry,
            entity: { position: new Vec3(x, y, z), eyeHeight: 1.62 },
            world,
        });
        const top = serverHeight(5, 5);
        const surface = make(5.5, top + 1, 5.5);
        await indexPerceivedChunks(surface);
        const above = getNearbyBlockTypes(surface);
        assert.ok(above.includes('grass_block'));
        assert.ok(!above.includes('emerald_ore'), `surface saw ${above.join(',')}`);
        const inside = make(5.5, cy + 1, 5.5);
        await indexPerceivedChunks(inside);
        const cave = getNearbyBlockTypes(inside);
        assert.ok(cave.includes('emerald_ore'), `cave saw ${cave.join(',')}`);
        world.setBlockStateId(new Vec3(5, cy - 1, 5), registry.blocksByName.emerald_ore.defaultState);
        for (let y = cy + 4; y <= top; y++) world.setBlockStateId(new Vec3(5, y, 5), 0);
        const opened = getNearbyBlockTypes(surface);
        assert.ok(opened.includes('emerald_ore'), `shaft saw ${opened.join(',')}`);
        assert.ok(opened.includes('grass_block'));
    });

    it('says the index is incomplete until every loaded column is built, and a crossing builds only the new columns', async () => {
        const viewDistance = 1;
        const world = await buildServerTerrain(registry, viewDistance, { plants: false });
        const bot = {
            game: { serverViewDistance: viewDistance, gameMode: 'survival' },
            registry,
            entity: { position: new Vec3(8.5, serverHeight(8, 8) + 1, 8.5), eyeHeight: 1.62 },
            world,
        };
        getNearbyBlockTypes(bot);
        assert.match(perceivedStats(bot).indexNote, /^index incomplete, \d+ of \d+ chunks$/);
        await indexPerceivedChunks(bot);
        getNearbyBlockTypes(bot);
        assert.match(perceivedStats(bot).indexNote, /^index complete, \d+ of \d+ chunks$/);
        const before = perceivedBuildStats(bot).builds;
        for (let cz = -viewDistance; cz <= viewDistance; cz++) world.setColumn(viewDistance + 1, cz, makeServerChunk(registry, viewDistance + 1, cz));
        for (let cz = -viewDistance; cz <= viewDistance; cz++) world.unloadColumn(-viewDistance, cz);
        bot.entity.position = new Vec3(16 + 8.5, serverHeight(24, 8) + 1, 8.5);
        await indexPerceivedChunks(bot);
        assert.strictEqual(perceivedBuildStats(bot).builds - before, viewDistance * 2 + 1);
    });
});
