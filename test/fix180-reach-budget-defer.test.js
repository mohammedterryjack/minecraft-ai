/**
 * fix180 (live icefox2000, 24 Nov): 24 "reachability thinkTimeout budget" throws since fix132
 * produced 6 full process exits — the same step error twice is fatal (Mo's loud-fail rule).
 * But a target past the think budget is FAR, not unreachable: astar's makeResult
 * (node_modules/mineflayer-pathfinder/lib/astar.js:55-65) attaches the best partial path to the
 * 'timeout' result, and a far target is walkable in segments. The budget error must not poison
 * the fix97 reach contract (success|noPath only) nor kill the step: _judgeTargets drops the
 * block from this step's perception and the next observe() re-judges it from wherever the bot
 * has moved to — fix132's own "retried from a moved position".
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';

const registry = Registry('1.20.4');
const VER = '1.20.4';
let Voyager, world;

before(async () => {
    world = await import('../src/agent/library/world.js');
    const mod = await import('../src/agent/voyager.js');
    mod._setVersionForTest(VER);
    Voyager = mod.Voyager;
});

function budgetBot(statusByName, partialPath) {
    return {
        registry,
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(0, 33, 0), eyeHeight: 1.62 },
        world: {},
        blockAt: () => ({ name: 'stone', shapes: [{}] }),
        async waitForTicks() {},
        pathfinder: {
            thinkTimeout: 5000,
            tickTimeout: 40,
            movements: {},
            * getPathFromTo(movements, start, goal, options) {
                // one partial slice (the budget cannot burn inside one 40 ms slice), then the verdict
                yield { result: { status: 'partial' } };
                const status = statusByName(goal.pos.x);
                yield { result: { status, path: status === 'timeout' ? partialPath : undefined } };
            },
        },
    };
}

describe('fix180 a think-budget timeout is far, not unreachable', () => {
    it('pathToBlock throws ReachabilityBudget carrying the astar partial path', async () => {
        const partial = [{ x: 10, y: 33, z: 0 }, { x: 40, y: 34, z: 20 }];
        const bot = budgetBot((n) => 'timeout', partial);
        await assert.rejects(
            () => world.pathToBlock(bot, new Vec3(200, 33, 0)),
            (err) => err instanceof world.ReachabilityBudget && err.partialPath === partial,
        );
    });

    it('_judgeTargets defers a budgeted block without storing a status', async () => {
        const v = Object.create(Voyager.prototype);
        v.agent = { name: 'icefox2000', bot: budgetBot((x) => (x > 100 ? 'timeout' : 'noPath'), null) };
        const state = {
            nearby_blocks: ['diamond_ore', 'stone'],
            perceived_at: { diamond_ore: new Vec3(200, 33, 0), stone: new Vec3(3, 33, 0) },
        };
        const found = await v._judgeTargets(state, ['diamond_ore', 'stone'], false);
        assert.strictEqual(found, null);
        assert.ok(!Object.hasOwn(state._reach, 'diamond_ore'), 'timeout must not enter state._reach (fix97 contract)');
        assert.strictEqual(state._reach.stone, 'noPath');
        assert.ok(!state.nearby_blocks.includes('diamond_ore'), 'deferred block leaves this step perception');
        assert.ok(!Object.hasOwn(state.perceived_at, 'diamond_ore'));
        assert.ok(state._deferred.has('diamond_ore'), 'fix204: the deferral is recorded for _withChosenSearches');
    });

    it('fix204: _withChosenSearches replans around a deferred block instead of exiting', async () => {
        const v = Object.create(Voyager.prototype);
        v.agent = { name: 'icefox2000', bot: budgetBot((x) => (x > 100 ? 'timeout' : 'noPath'), null) };
        const state = {
            nearby_blocks: ['diamond_ore'],
            perceived_at: { diamond_ore: new Vec3(200, 33, 0) },
        };
        let calls = 0;
        const result = await v._withChosenSearches(state, () => {
            calls++;
            if (calls === 1) {
                // what reachableBlock (voyager.js:5248) does for an unsearched perceived source
                const err = new Error('[fix97] diamond_ore is nearby and has not been searched.');
                err.unsearchedBlock = 'diamond_ore';
                throw err;
            }
            return 'planned-without-it';   // second pass: diamond_ore is out of perception
        });
        assert.strictEqual(result, 'planned-without-it');
        assert.strictEqual(calls, 2, 'the plan ran again without the deferred block');
    });

    it('fix204: a block that is neither searched nor deferred still fails loudly', async () => {
        const v = Object.create(Voyager.prototype);
        v.agent = { name: 'icefox2000', bot: budgetBot(() => 'noPath', null) };
        // perceived_at has no entry for the name, so _judgeTargets cannot judge it: real anomaly.
        const state = { nearby_blocks: ['moss_block'], perceived_at: { moss_block: new Vec3(5, 33, 5) } };
        delete state.perceived_at.moss_block;
        await assert.rejects(
            () => v._withChosenSearches(state, () => {
                const err = new Error('[fix97] moss_block is nearby and has not been searched.');
                err.unsearchedBlock = 'moss_block';
                throw err;
            }),
            /is nearby and was not searched/,
        );
    });

    it('a non-budget reach error still propagates loudly', async () => {
        const v = Object.create(Voyager.prototype);
        const bot = budgetBot((n) => 'weird');
        v.agent = { name: 'icefox2000', bot };
        const state = { nearby_blocks: ['stone'], perceived_at: { stone: new Vec3(3, 33, 0) } };
        await assert.rejects(() => v._judgeTargets(state, ['stone'], false), /getPathFromTo returned weird/);
    });
});
