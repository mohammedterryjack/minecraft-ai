/**
 * fix127 (live icefox2000, 14:05-14:15 GMT 16 Nov): "Obtain 1 salmon", "Obtain 1 spider_eye",
 * pufferfish — 4/4 failed. Every mob-acquisition path in the library is a single visibility
 * glance (attackNearest: 24-block list scan; goToNearestEntity: one 64-block scan) that fails
 * in milliseconds when the mob is off-screen. The critic said it exactly: "The bot needs to
 * actively search for spiders (e.g., explore caves, wait for night...) since none were found
 * in the immediate" — but the coder had no primitive to act on that advice. Per mob spawning
 * mechanics (https://minecraft.wiki/w/Mob_spawning) aquatic mobs live in water and land mobs
 * congregate in dark places (caves) and open surface; goToMob probes those habitats and keeps
 * scanning while dwelling there.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { goToMob } from '../src/agent/library/skills.js';
import { setMovementStore } from '../src/utils/movement_model.js';

const registry = Registry('1.20.4');

// Mock world at (0,64,0). findBlock offers candidate blocks to the caller's predicate like
// mineflayer's findBlock does, returning a candidate only when that habitat exists in this world.
function mkBot({ water = false, cave = false, entities = {} } = {}) {
    const bot = Object.assign(new EventEmitter(), {
        registry,
        output: '',
        interrupt_code: false,
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(0, 64, 0), isInWater: false },
        entities,
        modes: { isOn: () => false },
        inventory: { items: () => [] },
        setControlState() {},
        async lookAt() {},
        blockAt() { return { name: 'air', liquid: false }; },
        async waitForTicks(n) { for (let t = 0; t < n; t++) await Promise.resolve(); },
        findBlock({ matching }) {
            if (water && matching({ name: 'water', position: new Vec3(10, 62, 0) })) return { position: new Vec3(10, 62, 0) };
            if (cave && matching({ name: 'air', position: new Vec3(5, 55, 0) })) return { position: new Vec3(5, 55, 0) };
            return null;
        },
        pathfinder: {
            _moves: 0,
            setMovements() {},
            stop() {},
            isMoving() { return false; },
            isMining() { return false; },
            isBuilding() { return false; },
            async getPathTo() { return { status: 'success' }; },
            async goto(goal) {
                bot.pathfinder._moves += 1;
                if (typeof goal.x === 'number') bot.entity.position.set(goal.x, goal.y, goal.z);
                else bot.entity.position.x += 40; // GoalInvert (moveAway): land somewhere new
            },
        },
    });
    return bot;
}
const ent = (name, x) => ({ '7': { name, position: new Vec3(x, 63, 0), id: 7n, alive: true } });

describe('fix127 goToMob: habitat-seeking mob acquisition', () => {
    beforeEach(() => setMovementStore({ swim: { n: 5, max: 2000, cuts: 0 }, walk: { n: 5, max: 5000, cuts: 0 } }));

    it('visible mob -> approaches it, no habitat probe needed', async () => {
        const bot = mkBot({ entities: ent('spider', 5) });
        assert.strictEqual(await goToMob(bot, 'spider'), true);
        assert.doesNotMatch(bot.output, /probing/);
    });

    it('cod not visible: probes water and keeps scanning there until one appears', async () => {
        const bot = mkBot({ water: true });
        const timer = setTimeout(() => Object.assign(bot.entities, ent('cod', 10)), 600);
        const ok = await goToMob(bot, 'cod', { maxProbes: 1, scanMs: 2500 });
        clearTimeout(timer);
        assert.match(bot.output, /probing habitat water/, 'aquatic mob must travel toward water');
        assert.strictEqual(ok, true, `output: ${bot.output}`);
    });

    it('no habitat and no mob: fails naming the probes it tried, not a bare glance failure', async () => {
        const bot = mkBot({});
        const ok = await goToMob(bot, 'spider', { maxProbes: 2, scanMs: 200 });
        assert.strictEqual(ok, false);
        assert.match(bot.output, /FAILED: no spider found after probing habitats/);
        assert.match(bot.output, /cave \(not found\)/);
    });
});
