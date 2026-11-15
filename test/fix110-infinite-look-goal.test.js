/**
 * fix110: a shapeless target block makes GoalLookAtBlock unsatisfiable, and the reachability search
 * (which has no thinkTimeout by design, fix97: only 'noPath' means unreachable) then never ends.
 *
 * Root cause (measured live 2026-11-14, 20:21Z stall): the "Craft 1 torch" need probed the perceived
 * torch at (-19,75,58). GoalLookAtBlock.isEnd is true only where world.raycast returns the target block
 * exactly (mineflayer-pathfinder lib/goals.js), prismarine-world raycast intersects a block only with its
 * collision shapes (src/worldsync.js raycast: iter.intersect(block.shapes, position)), and a 1.20.4 torch
 * has no shapes (boundingBox 'empty', https://minecraft.wiki/w/Torch). No node can end that A*, and the
 * open set does not drain while the world is bigger than one slice, so the awaited search ran 4400 s /
 * 1.4M nodes with the open heap still growing, and the voyager step never ended.
 *
 * Fix: lookGoal() selects the goal by the target's raycastability - GoalLookAtBlock only when the target
 * block has shapes; GoalNear (mineflayer-pathfinder goals.js) for a shapeless or missing target, so every
 * search ends in success or noPath.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { buildServerTerrain, serverHeight } from './server_terrain.js';
import { pathToBlock } from '../src/agent/library/world.js';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);
const { Vec3 } = require('vec3');
const pf = require('mineflayer-pathfinder');
const AStar = require('mineflayer-pathfinder/lib/astar.js');
const Move = require('mineflayer-pathfinder/lib/move.js');

const H = (x, z) => serverHeight(x, z, true);
let world;
before(async () => {
    world = await buildServerTerrain(registry, 4, { plants: true, dry: true });
});

// The bot.pathfinder.getPathFromTo the plugin injects (mineflayer-pathfinder index.js:75-107), mirrored
// so the test runs the real A* without a full mineflayer bot.
function makeBot(startPos) {
    const bot = {
        registry,
        game: { gameMode: 'survival', dimension: 'overworld', minY: -64, height: 384 },
        world,
        entity: { eyeHeight: 1.62, position: startPos },
        entities: [],
        inventory: { items: () => [] },
        blockAt: (pos) => world.getBlock(pos),
        waitForTicks: async () => {},
    };
    bot.pathfinder = {
        movements: new pf.Movements(bot),
        tickTimeout: 1,
        thinkTimeout: 5000,
        searchRadius: -1,
        bestHarvestTool() { return null; },
        goals: [],
        * getPathFromTo (movements, startPos2, goal, options = {}) {
            bot.pathfinder.goals.push(goal.constructor.name);
            const p = startPos2.floored();
            const start = new Move(p.x, p.y, p.z, movements.countScaffoldingItems(), 0);
            const ctx = new AStar(start, movements, goal, options.timeout, options.tickTimeout, options.searchRadius);
            let result = ctx.compute();
            yield { result, astarContext: ctx };
            while (result.status === 'partial') {
                result = ctx.compute();
                yield { result, astarContext: ctx };
            }
        },
    };
    return bot;
}

describe('fix110: shapeless targets end their search', () => {
    it('a torch has no collision shapes to raycast (the premise of the stall)', () => {
        const torch = registry.blocksByName.torch;
        const Block = require('prismarine-block')(registry);
        const t = Block.fromStateId(torch.defaultState, 0);
        assert.strictEqual(t.shapes.length, 0, 'torch must be shapeless for this regression to hold');
    });

    it('GoalLookAtBlock on a torch is never satisfied: the A* stays partial and its open set keeps growing', () => {
        const tx = 24, tz = 24;
        const th = H(tx, tz);
        world.setBlockStateId(new Vec3(tx, th + 1, tz), registry.blocksByName.torch.defaultState);
        const bot = makeBot(new Vec3(tx + 10, H(tx + 10, tz) + 1, tz));
        const goal = new pf.goals.GoalLookAtBlock(new Vec3(tx, th + 1, tz), world, { entityHeight: 1.62, reach: 4.5 });
        // isEnd is false at the node standing in the torch cell itself: the raycast hits the block below.
        const onTorch = { x: tx, y: th + 1, z: tz, height: 0,
            distanceTo (v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); } };
        assert.strictEqual(goal.isEnd(onTorch), false, 'the node at the torch must not end GoalLookAtBlock');
        const gen = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, bot.entity.position, goal,
            { timeout: Number.POSITIVE_INFINITY, tickTimeout: 1 });
        let slices = 0; let last = null; let first = null; let everEnded = false;
        while (slices < 400) {
            const step = gen.next();
            if (step.done) break;
            last = step.value.result;
            if (!first) first = last;
            if (last.status !== 'partial') { everEnded = true; break; }
            slices += 1;
        }
        assert.ok(!everEnded, `the unsatisfiable goal ended after ${slices} slices`);
        assert.ok(last.generatedNodes > 500, `expected a real search, generated ${last && last.generatedNodes}`);
        assert.ok(last.generatedNodes > first.generatedNodes, 'the open set must still be growing when the slice budget ends');
    });

    it('pathToBlock on the torch finishes: lookGoal picked GoalNear for the shapeless target', async () => {
        const tx = 24, tz = 24;
        const th = H(tx, tz);
        world.setBlockStateId(new Vec3(tx, th + 1, tz), registry.blocksByName.torch.defaultState);
        const bot = makeBot(new Vec3(tx + 10, H(tx + 10, tz) + 1, tz));
        const result = await pathToBlock(bot, { x: tx, y: th + 1, z: tz });
        assert.deepStrictEqual(bot.pathfinder.goals, ['GoalNear'], 'shapeless target must search with GoalNear');
        assert.strictEqual(result.status, 'success');
    });

    it('pathToBlock on a vanished perceived block finishes: it is not there, reach the position', async () => {
        const tx = 40, tz = 40;
        const th = H(tx, tz);
        // Nothing at the target (perceived block mined away): GoalLookAtBlock could never raycast-hit it.
        assert.strictEqual(world.getBlock(new Vec3(tx, th + 1, tz)).name, 'air');
        const bot = makeBot(new Vec3(tx + 10, H(tx + 10, tz) + 1, tz));
        const result = await pathToBlock(bot, { x: tx, y: th + 1, z: tz });
        assert.deepStrictEqual(bot.pathfinder.goals, ['GoalNear']);
        assert.strictEqual(result.status, 'success');
    });

    it('a solid target keeps the face-visibility goal (GoalLookAtBlock) and finishes', async () => {
        const tx = 56, tz = 56;
        const th = H(tx, tz);
        world.setBlockStateId(new Vec3(tx, th, tz), registry.blocksByName.stone.defaultState);
        const bot = makeBot(new Vec3(tx + 10, H(tx + 10, tz) + 1, tz));
        const result = await pathToBlock(bot, { x: tx, y: th, z: tz });
        assert.deepStrictEqual(bot.pathfinder.goals, ['GoalLookAtBlock'], 'solid target must keep face visibility');
        assert.strictEqual(result.status, 'success');
    });

    it('a bot that cannot read the target block keeps the old goal (the fix97 mocks)', async () => {
        const calls = [];
        const bot = {
            game: { gameMode: 'survival' },
            entity: { eyeHeight: 1.62, position: { x: 0, y: 64, z: 0 } },
            world: {},
            waitForTicks: async () => {},
            pathfinder: {
                movements: {},
                tickTimeout: 40,
                * getPathFromTo (movements, startPos, goal) {
                    calls.push(goal.constructor.name);
                    yield { result: { status: 'success', cost: 1 } };
                },
            },
        };
        const result = await pathToBlock(bot, { x: 30, y: 64, z: 0 });
        assert.deepStrictEqual(calls, ['GoalLookAtBlock']);
        assert.strictEqual(result.status, 'success');
    });
});
