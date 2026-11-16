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

describe('fix124: swimToSurface', () => {
    it('surfaces a submerged bot and releases jump', async () => {
        const bot = mkBot({ startY: 41, surfaceY: 44.9 });
        const res = await skills.swimToSurface(bot);
        assert.strictEqual(res.surfaced, true);
        assert.ok(res.rose >= 3, `expected >=3 blocks risen, got ${res.rose}`);
        assert.strictEqual(bot._held.jump, false, 'jump control released');
    });

    it('a bot with its head already out of the water does not swim', async () => {
        const bot = mkBot({ startY: 44, surfaceY: 44 }); // feet in water, head cell is air
        const res = await skills.swimToSurface(bot);
        assert.strictEqual(res.surfaced, true);
        assert.strictEqual(res.rose, 0);
        assert.notStrictEqual(bot._held.jump, true, 'jump never held');
    });

    it('a column blocked by a solid ceiling fails loudly, jump released', async () => {
        const bot = mkBot({ startY: 41, surfaceY: 50, blocked: true });
        const res = await skills.swimToSurface(bot);
        assert.strictEqual(res.surfaced, false);
        assert.strictEqual(res.blocked, true);
        assert.strictEqual(bot._held.jump, false, 'jump control released on failure');
    });

    it('an interrupt stops the swim and releases jump', async () => {
        const bot = mkBot({ startY: 41, surfaceY: 44.9 });
        const origWait = bot.waitForTicks.bind(bot);
        bot.waitForTicks = async (n) => { bot.interrupt_code = true; await origWait(n); };
        const res = await skills.swimToSurface(bot);
        assert.strictEqual(res.surfaced, false);
        assert.strictEqual(res.interrupted, true);
        assert.strictEqual(bot._held.jump, false, 'jump control released on interrupt');
    });
});
