/**
 * fix124: mineflayer-pathfinder has no movement that operates in liquid — getMoveUp returns
 * immediately when the node block is liquid (node_modules/mineflayer-pathfinder/lib/movements.js:556),
 * getMoveDown/getMoveDropDown refuse liquid targets (:526, :546) and parkour refuses to jump
 * from water (:642). A bot standing in water at the bottom of a flooded shaft therefore has no
 * path out that pathfinder can generate: every escape task dies in the learned stall watchdog
 * ("no swim progress", 2.6 s) and PSN regenerates code that fails identically (live: exitWater
 * loop at (-175, 41, 104), 16 Nov). The game movement for liquid is swimming — hold jump until
 * the head clears the surface (the same control the drowning reflex uses, src/agent/modes.js:68)
 * — after which pathfinder movements exist again.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as skills from '../src/agent/library/skills.js';

// Mock: a vertical water column. `surfaceY` = highest y whose cell is still water.
// Head cell (floor(y+1)) is water while the entity stands below the surface.
// While jump is held and not blocked, the entity rises 2 blocks per second (waitForTicks(20)).
function mkBot({ startY, surfaceY, blocked = false }) {
    const held = {};
    const bot = {
        interrupt_code: false,
        entity: {
            position: {
                y: startY,
                offset: function (dx, dy, dz) { return { x: dx, y: this.y + dy, z: dz }; },
            },
            isInWater: true,
        },
        blockAt(p) {
            if (!Number.isFinite(p.y)) return null;
            return Math.floor(p.y) <= surfaceY
                ? { name: 'water', liquid: true }
                : { name: 'air', liquid: false };
        },
        setControlState(name, value) { held[name] = value; },
        _held: held,
        async waitForTicks(n) {
            for (let t = 0; t < n; t++) {
                if (held.jump && !blocked && bot.entity.position.y < surfaceY) {
                    bot.entity.position.y += 2 / 20; // ~2 blocks per second while swimming up
                }
                await Promise.resolve();
            }
        },
    };
    return bot;
}

// Mock: a flooded horizontal corridor running along x. Water fills every cell with
// floor(x) < bankX; the bank at bankX is dry (solid floor, air above). The entity
// advances 2 blocks per second toward the lookAt target while forward is held, and never
// crosses into the wall when wallX is set.
function mkSwimmer({ startX, startZ = 104, bankX, wallX = null }) {
    const held = {};
    const bot = {
        interrupt_code: false,
        entity: { position: { x: startX, y: 41, z: startZ } },
        setControlState(name, value) { held[name] = value; },
        _held: held,
        _look: null,
        async lookAt(v) { bot._look = v; },
        async waitForTicks(n) {
            for (let t = 0; t < n; t++) {
                if (held.forward) {
                    const p = bot.entity.position;
                    const dir = Math.sign(bot._look.x - p.x) || 0;
                    const next = p.x + dir * 2 / 20;
                    if (wallX === null || (dir > 0 ? next < wallX : next > wallX)) p.x = next;
                }
                // dry once reached, and dry stays dry (banks do not re-flood when the bot bobs)
                if (Math.floor(bot.entity.position.x) >= bankX) bot.entity.isInWater = false;
                await Promise.resolve();
            }
        },
    };
    bot.entity.isInWater = Math.floor(startX) < bankX;
    return bot;
}

describe('fix124: swimTowards', () => {
    it('swims the flooded corridor to the dry bank and releases controls', async () => {
        const bot = mkSwimmer({ startX: -175, bankX: -168 });
        const res = await skills.swimTowards(bot, -168, 104);
        assert.strictEqual(res.reached, true, `reached bank, got ${JSON.stringify(res)}`);
        assert.strictEqual(bot.entity.isInWater, false);
        assert.notStrictEqual(bot._held.forward, true, 'forward released');
        assert.notStrictEqual(bot._held.jump, true, 'jump released');
    });

    it('a wall between bot and bank fails loudly as blocked', async () => {
        const bot = mkSwimmer({ startX: -175, bankX: -168, wallX: -172 });
        const res = await skills.swimTowards(bot, -168, 104);
        assert.strictEqual(res.reached, false);
        assert.strictEqual(res.blocked, true);
        assert.notStrictEqual(bot._held.forward, true, 'forward released on failure');
        assert.notStrictEqual(bot._held.jump, true, 'jump released on failure');
    });
});

describe('fix124: swimToSurface', () => {
    it('surfaces a submerged bot and releases jump', async () => {
        const bot = mkBot({ startY: 41, surfaceY: 44.9 });
        const res = await skills.swimToSurface(bot);
        assert.strictEqual(res.reached, true);
        assert.ok(res.rose >= 3, `expected >=3 blocks risen, got ${res.rose}`);
        assert.strictEqual(bot._held.jump, false, 'jump control released');
    });

    it('a bot with its head already out of the water does not swim', async () => {
        const bot = mkBot({ startY: 44, surfaceY: 44 }); // feet in water, head cell is air
        const res = await skills.swimToSurface(bot);
        assert.strictEqual(res.reached, true);
        assert.strictEqual(res.rose, 0);
        assert.notStrictEqual(bot._held.jump, true, 'jump never held');
    });

    it('a column blocked by a solid ceiling fails loudly, jump released', async () => {
        const bot = mkBot({ startY: 41, surfaceY: 50, blocked: true });
        const res = await skills.swimToSurface(bot);
        assert.strictEqual(res.reached, false);
        assert.strictEqual(res.blocked, true);
        assert.strictEqual(bot._held.jump, false, 'jump control released on failure');
    });

    it('an interrupt stops the swim and releases jump', async () => {
        const bot = mkBot({ startY: 41, surfaceY: 44.9 });
        const origWait = bot.waitForTicks.bind(bot);
        bot.waitForTicks = async (n) => { bot.interrupt_code = true; await origWait(n); };
        const res = await skills.swimToSurface(bot);
        assert.strictEqual(res.reached, false);
        assert.strictEqual(res.interrupted, true);
        assert.strictEqual(bot._held.jump, false, 'jump control released on interrupt');
    });
});
