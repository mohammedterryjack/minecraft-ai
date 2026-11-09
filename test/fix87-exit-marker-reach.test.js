/**
 * fix87 items 2-4 (live icefox2000, 6 Nov).
 *  2. SIGTERM / a socket reconnect left no cause line before the next "MindServer running".
 *  3. a candidate that drops the need marker is rejected and not kept (the throw was a step error; twice was fatal).
 *  4. "no <block> within search range" is a reach need. A log's game-data plan is "collect it", with no missing
 *     ingredient, so the chain used to stop. No wood or surface special case: the block names come from the registry.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { goToNearestBlock } from '../src/agent/library/skills.js';
import { peekPreconditionUnmet, reachNeedForBlocks, markBlockOutOfRange } from '../src/agent/precondition.js';
import { _setVersionForTest as setMcVersion } from '../src/utils/mcdata.js';
import { installExitLogging, onProcessSignal, signalExitCode, exitLoudLine, _setExitForTest } from '../src/process/exit_log.js';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Recipe } = require('prismarine-recipe')(VER);

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
    setMcVersion(VER);
});

describe('fix87: process exit logs its cause', () => {
    it('SIGTERM exits 143 and the line names the signal, the pid, and the heap limit', () => {
        assert.strictEqual(signalExitCode('SIGTERM'), 143);
        assert.strictEqual(signalExitCode('SIGINT'), 130);
        assert.strictEqual(signalExitCode('SIGHUP'), 129);
        assert.throws(() => signalExitCode('SIGKILL'), /no exit code for signal SIGKILL/);
        const line = exitLoudLine('signal SIGTERM; exiting 143');
        assert.match(line, /\[exit\] LOUD: signal SIGTERM; exiting 143 pid=\d+ heapUsed=\d+ heapLimit=\d+\n/);
        let code = null;
        _setExitForTest((c) => { code = c; });
        try {
            onProcessSignal('SIGTERM');
            assert.strictEqual(code, 143);
        } finally {
            _setExitForTest((c) => process.exit(c));
        }
    });
    it('installs signal, exit, and rejection listeners and removes them again', () => {
        const beforeTerm = process.listenerCount('SIGTERM');
        const beforeInt = process.listenerCount('SIGINT');
        const beforeHup = process.listenerCount('SIGHUP');
        const beforeExit = process.listenerCount('exit');
        const beforeRej = process.listenerCount('unhandledRejection');
        const dispose = installExitLogging();
        try {
            assert.strictEqual(process.listenerCount('SIGTERM'), beforeTerm + 1);
            assert.strictEqual(process.listenerCount('SIGINT'), beforeInt + 1);
            assert.strictEqual(process.listenerCount('SIGHUP'), beforeHup + 1);
            assert.strictEqual(process.listenerCount('exit'), beforeExit + 1);
            assert.strictEqual(process.listenerCount('unhandledRejection'), beforeRej + 1);
            assert.strictEqual(installExitLogging(), dispose);
            assert.strictEqual(process.listenerCount('SIGTERM'), beforeTerm + 1);
        } finally {
            dispose();
        }
        assert.strictEqual(process.listenerCount('SIGTERM'), beforeTerm);
        assert.strictEqual(process.listenerCount('SIGINT'), beforeInt);
        assert.strictEqual(process.listenerCount('SIGHUP'), beforeHup);
        assert.strictEqual(process.listenerCount('exit'), beforeExit);
        assert.strictEqual(process.listenerCount('unhandledRejection'), beforeRej);
    });
});

describe('fix87: no block of a registry type within search range is a reach need', () => {
    it('goToNearestBlock reports a reach need for the block it searched, and not for a name that is not a block', async () => {
        const bot = {
            registry,
            output: '',
            entity: { position: { x: 0, y: 64, z: 0 } },
            findBlocks: () => [],
            blockAt: () => null,
        };
        const ok = await goToNearestBlock(bot, 'oak_log', 2, 64);
        assert.strictEqual(ok, false);
        const marked = peekPreconditionUnmet(bot);
        assert.deepStrictEqual(marked.need, { item: 'oak_log', count: 1, reason: 'reach' });
        const other = { registry, output: '' };
        // fix95: a search miss for a name that is not a block is a wrong question: loud, and no reach need is stamped
        assert.throws(() => markBlockOutOfRange(other, ['not_a_real_block'], 1), /none of these is a block in the game data/);
        assert.strictEqual(peekPreconditionUnmet(other), null);
        assert.strictEqual(reachNeedForBlocks(registry.blocksByName, ['not_a_real_block'], 1), null);
        assert.deepStrictEqual(reachNeedForBlocks(registry.blocksByName, ['iron_ore', 'deepslate_iron_ore'], 3), { anyOf: ['iron_ore', 'deepslate_iron_ore'], count: 3, reason: 'reach' });
    });

    function plannerBot() {
        return { version: VER, registry, recipesAll: (id) => Recipe.find(id), inventory: { emptySlotCount: () => 4 } };
    }
    function vWith(bot) {
        const v = Object.create(Voyager.prototype);
        v.agent = { bot, openChat() {} };
        v.skills = [];
        v.npGraph = null;
        v.progress = { subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [], recipeEdges: {}, goalStats: {} };
        v._saveProgress = () => {};
        v._curSub = null;
        v.observe = () => ({ inventory: {}, nearby_blocks: [] });
        return v;
    }

    it('collectLogs precheck of a missing oak_log returns a reach need instead of writing new code', async () => {
        const v = vWith({ ...plannerBot(), findBlock: () => null });
        const rp = await v._replay('Collect 2 oak_log', {}, { name: 'collectLogs', call: 'await collectLogs(bot, 2, "oak_log");' });
        assert.strictEqual(rp.ok, false);
        assert.strictEqual(rp.reason, 'no oak_log within 64 blocks');
        assert.deepStrictEqual(rp.needs.map(({ source, ...n }) => n), [{ item: 'oak_log', count: 2, reason: 'reach' }]);
        assert.strictEqual(rp.needs[0].source, 'no oak_log within 64 blocks');
    });

    it('mineOre precheck names every deepslate variant the game data has', async () => {
        const v = vWith({ ...plannerBot(), findBlock: () => null });
        const rp = await v._replay('Mine 1 iron_ore', {}, { name: 'mineOre', call: 'await mineOre(bot, "iron_ore", 1);' });
        assert.ok(rp.needs[0].anyOf.includes('iron_ore'));
        assert.ok(rp.needs[0].anyOf.includes('deepslate_iron_ore'));
        assert.strictEqual(rp.needs[0].reason, 'reach');
        assert.strictEqual(rp.needs[0].count, 1);
    });

    it('a block that is in range is applicable, and an unknown block is not a reach need', () => {
        const v = vWith({ ...plannerBot(), findBlock: () => ({ name: 'oak_log' }) });
        assert.deepStrictEqual(v._precheck({ name: 'collectLogs', call: 'await collectLogs(bot, 1, "oak_log");' }), { ok: true });
        const unknown = v._precheck({ name: 'collectLogs', call: 'await collectLogs(bot, 1, "not_a_block");' });
        assert.strictEqual(unknown.ok, false);
        assert.strictEqual(Object.hasOwn(unknown, 'need'), false);
    });

    it('Collect oak_log with no source nearby chains to reach oak_log; a nearby log, and a craft, do not', () => {
        const v = vWith(plannerBot());
        const absent = { inventory: {}, nearby_blocks: [] };
        const needs = v._failureNeeds('Collect 1 oak_log', null, null, absent);
        assert.strictEqual(needs[0].reason, 'reach');
        assert.strictEqual(needs[0].item, 'oak_log');
        assert.strictEqual(needs[0].count, 1);
        v._chainNeeds('Collect 1 oak_log', needs, absent);
        assert.strictEqual(v.progress.subgoals[0].task, 'reach oak_log');

        const present = v._failureNeeds('Collect 1 oak_log', null, null, { inventory: {}, nearby_blocks: ['oak_log'] });
        assert.strictEqual(present, null);

        // sticks also drop from leaves. With nothing nearby that collect is cheaper than crafting, so the need is
        // reach those source blocks (game data), not a wood special case. A crafted pickaxe still names its ingredients.
        const sticks = v._failureNeeds('Craft 1 stick', null, null, { inventory: {}, nearby_blocks: [] });
        assert.strictEqual(sticks[0].reason, 'reach');
        assert.ok(sticks[0].anyOf.includes('oak_leaves'));
        assert.ok(!sticks[0].anyOf.includes('oak_log'));
        const pick = v._failureNeeds('Craft 1 iron_pickaxe', null, null, { inventory: {}, nearby_blocks: [] });
        assert.ok(pick.every(n => n.reason === 'ingredients' || n.reason === 'tool'), JSON.stringify(pick));
        assert.ok(pick.some(n => n.item === 'stick'));
    });

    it('raw_iron with a harvest tool held and no ore nearby reaches the source blocks from the game data', () => {
        const v = vWith(plannerBot());
        const state = { inventory: { stone_pickaxe: 1 }, nearby_blocks: [] };
        const src = v._obtainPlanner(state).sources('raw_iron');
        assert.ok(src.includes('iron_ore') && src.includes('deepslate_iron_ore'), src.join(','));
        assert.strictEqual(v._obtainPlanner(state).toolsNeeded('raw_iron', state.inventory), null);
        const needs = v._failureNeeds('Collect 1 raw_iron', null, null, state);
        assert.strictEqual(needs[0].reason, 'reach');
        assert.deepStrictEqual(needs[0].anyOf, src);
    });
});

describe('fix87: a dropped-need candidate does not fail the caller step', () => {
    it('a dedicated trial returns unverified and does not throw', async () => {
        const v = Object.create(Voyager.prototype);
        const incumbent = Voyager.SEEDED_PRIMITIVES.find(p => p.name === 'pickupNearbyItems').code;
        v.skills = [{
            name: 'pickupNearbyItems',
            code: incumbent,
            deps: [],
            effects: [],
            consumes: {},
            candidate: { code: 'async function pickupNearbyItems(bot) { return 0; }', deps: [], task: 'pickup nearby items', effects: [], stats: { success: 0, fail: 0 } },
        }];
        v._graph = () => ({});
        v._saveSkills = () => {};
        v.agent = { bot: { food: 20 } };
        v._foodRaiseSaturated = () => null;
        const rp = await v._replay('pickup nearby items', {}, { name: 'pickupNearbyItems', call: 'await pickupNearbyItems(bot);', dedicatedTrial: true });
        assert.strictEqual(rp.ok, false);
        assert.strictEqual(rp.unverified, true);
        assert.match(rp.reason, /candidate rejected: repair dropped/);
        assert.strictEqual(v.skills[0].candidate, undefined);
        assert.match(v.skills[0].repairHistory[0].evidence, /__mcPreconditionUnmet__/);
    });
});
