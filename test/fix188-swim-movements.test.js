/**
 * fix188 (live icefox2000, 25 Nov 2026): "Kill 3 cod" and other water tasks die with
 * "[pathfinder] walk ended but goal not satisfied" / noPath, and the log records
 * "Died [drowning] @-174,40,103". Measured gaps in mineflayer-pathfinder 2.4.5 (probes against
 * the installed lib): (1) there is NO upward move through liquid — getMoveDown bails from liquid
 * ("// dont go underwater", lib/movements.js:546), getMoveUp is climbable blocks only (:553),
 * getMoveDropDown refuses water landings (:526), getMoveParkourForward refuses to jump from
 * water (:642) — so a bot that sinks to the bottom of a >=2-deep pond cannot even plan to the
 * surface (bottom->surface: noPath) unless a one-block shelf touches its feet; (2) getMoveForward
 * does accept water nodes (lib/movements.js:391, cost += liquidCost :428) but never checks the
 * HEAD cell, so crossing >=2-deep water plans a fully submerged route — the bot walks in with its
 * head under water and drowns. Upstream fixed this only after 2.4.5: PR #394 "Plan upward swimming
 * and shore exits" (merged 0eb15c1, getMoveWaterExit) and PR #375 (surface getMoveSwim), neither
 * in a release. SwimMovements ports #394 and adds drowning-safe surface swimming (water-to-water
 * moves that require an air head cell). The 2.4.5 executor already drives in-water travel
 * (index.js: bot.entity.isInWater -> jump propulsion).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import pf from 'mineflayer-pathfinder';
import Move from 'mineflayer-pathfinder/lib/move.js';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import { SwimMovements } from '../src/agent/library/skills.js';

const registry = Registry('1.20.4');
const WATER = registry.blocksByName.water.id;
const AIR = registry.blocksByName.air.id;
const STONE = registry.blocksByName.stone.id;

// grid: Map "x,y,z" -> 'water' | 'solid'; everything else air.
function mkBot(grid) {
    const bot = {
        registry,
        game: { minY: -60 },
        pathfinder: { bestHarvestTool: () => null },
        entity: { position: { x: 0, y: 62, z: 0 }, effects: [], isInLava: false },
        blockAt(pos) {
            const t = grid.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
            const type = t === 'water' ? WATER : t === 'solid' ? STONE : AIR;
            const bb = registry.blocksArray.find((b) => b.id === type).boundingBox;
            return {
                type,
                name: registry.blocksArray.find((b) => b.id === type).name,
                boundingBox: bb,
                shapes: bb === 'empty' ? [] : [[0, 0, 0, 1, 1, 1]],
                minY: 0,
                digTime: () => 100,
                _properties: {},
                position: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)),
            };
        },
    };
    return bot;
}

// Lake: land x in {0,1} (floor top y=61, stand y=62); water x in 2..6 (floor y<=60,
// water y=61, air above); far shore x>=7 solid up to y=61 (bot exits via #394 shore step).
function lake({ depth = 1 } = {}) {
    const grid = new Map();
    for (let x = -1; x <= 8; x++) {
        for (let z = -1; z <= 1; z++) {
            for (let y = 55; y <= 59; y++) grid.set(`${x},${y},${z}`, 'solid');
            if (x <= 1 || x >= 7) grid.set(`${x},60,${z}`, 'solid');
            if (x >= 7) grid.set(`${x},61,${z}`, 'solid');
            if (x >= 2 && x <= 6) {
                grid.set(`${x},60,${z}`, 'solid');
                for (let w = 0; w < depth; w++) grid.set(`${x},${61 + w},${z}`, 'water');
            }
        }
    }
    return grid;
}

// Deep pond for the upward-swim tests: floor top y=58, water y=59..63 (5 deep) x in 2..6,
// banks x<=1 / x>=7 solid up to y=63 (flush with the surface, no one-block shelf).
function deepPond() {
    const grid = new Map();
    for (let x = -1; x <= 8; x++) {
        for (let z = -1; z <= 1; z++) {
            for (let y = 50; y <= 58; y++) grid.set(`${x},${y},${z}`, 'solid');
            if (x <= 1 || x >= 7) grid.set(`${x},63,${z}`, 'solid');
            if (x >= 2 && x <= 6) {
                for (let w = 59; w <= 63; w++) grid.set(`${x},${w},${z}`, 'water');
            }
        }
    }
    return grid;
}

function movementsFor(bot, cls) {
    const m = new cls(bot);
    m.allowEntityDetection = false;
    return m;
}

function solve(movements, start, goalXYZ, radius) {
    const startNode = new Move(start[0], start[1], start[2], 0, 0);
    const goal = new pf.goals.GoalNear(goalXYZ[0], goalXYZ[1], goalXYZ[2], radius);
    const astar = new AStar(startNode, movements, goal, 5000, 4000);
    return astar.compute();
}

describe('fix188 SwimMovements: pathfinding can reach (and leave) water', () => {
    it('upstream 2.4.5 gap: vanilla cannot swim UP — a bot sunk in a deep pond has no path to the surface', () => {
        // Measured against the installed 2.4.5: bottom (4,59) -> surface (4,63) in a 5-deep pond
        // is noPath — no generator produces an upward move through liquid (getMoveDown bails on
        // liquid lib/movements.js:546; getMoveUp is climbable-only :553).
        const bot = mkBot(deepPond());
        const res = solve(movementsFor(bot, pf.Movements), [4, 59, 0], [4, 63, 0], 0);
        assert.notStrictEqual(res.status, 'success', 'vanilla unexpectedly planned an upward swim');
        // Same geometry: SwimMovements swims up, head never under water.
        const grid = deepPond();
        const swim = solve(movementsFor(bot, SwimMovements), [4, 59, 0], [4, 63, 0], 0);
        assert.strictEqual(swim.status, 'success', 'SwimMovements failed to plan the surface swim');
        const top = swim.path[swim.path.length - 1];
        assert.notStrictEqual(grid.get(`${top.x},${top.y + 1},0`), 'water',
            'escape route ends with the head still under water');
    });

    it('SwimMovements crosses the lake surface to the fish', () => {
        const bot = mkBot(lake());
        const grid = lake();
        const res = solve(movementsFor(bot, SwimMovements), [0, 62, 0], [5, 61.5, 0], 1);
        assert.strictEqual(res.status, 'success');
        assert.ok(res.path.length > 1, 'empty path');
        const last = res.path[res.path.length - 1];
        assert.ok(Math.abs(last.x - 5) <= 1 && last.y === 61, `ended at ${last.x},${last.y}`);
        for (const n of res.path) {
            // drowning-safe: no path node may have its head cell inside water
            assert.notStrictEqual(grid.get(`${n.x},${n.y + 1},0`), 'water',
                `path node ${n.x},${n.y} submerges the head`);
        }
    });

    it('submerged bot swims up and climbs out onto the shore (#394 port)', () => {
        const bot = mkBot(lake({ depth: 2 }));
        const res = solve(movementsFor(bot, SwimMovements), [4, 61, 0], [7, 62, 0], 1);
        assert.strictEqual(res.status, 'success');
        const last = res.path[res.path.length - 1];
        assert.ok(last.x >= 6 && last.y >= 62, `ended at ${last.x},${last.y}`);
        for (const n of res.path) {
            // pure swimming escape: no scaffolding/placement cheat (the bot has no blocks to spare)
            assert.ok(!n.toPlace || n.toPlace.length === 0, `path placed blocks at ${n.x},${n.y}`);
        }
    });

    it('land nodes still never gain a move INTO water (only the drop-in path enters)', () => {
        const bot = mkBot(lake());
        const m = movementsFor(bot, SwimMovements);
        const start = new Move(0, 62, 0, 0, 0);
        const moves = m.getNeighbors(start);
        for (const mv of moves) {
            if (gridWater(lake(), mv)) assert.strictEqual(mv.y, 61, // only one-level drop onto surface
                `land node got dive move to ${mv.x},${mv.y}`);
        }
    });
});

function gridWater(grid, mv) {
    return grid.get(`${mv.x},${mv.y},${mv.z}`) === 'water';
}
