/**
 * fix130 (live icefox2000, 16 Nov 2026): zero successful kills in the whole mindcraft.log —
 * "Successfully killed" appears 0 times while killMob returns 0 over and over (pig/cow/
 * chicken/sheep). attackEntity(kill=true) waits on `world.getNearbyEntities(bot, 24).includes(entity)`
 * with a silent 1s loop: no log at start or during the wait (nothing to postmortem), no bound
 * (the loop only ends on entity removal or task interrupt — a step burned 532 s this way), and
 * the loop exits as SOON as the mob walks out of the 24-block window — which it counted as a
 * kill ("Successfully killed"), lying by omission. mineflayer-pvp follows the target itself
 * (PVP.js:72 sets GoalFollow, attackRange 3.5) and bot.attack is instant-swing only
 * (mineflayer 4.39 entities.js:843 — range is enforced server-side), so the wait design is ours
 * and must be honest: follow pvp's engagement, verify DEATH via client entity removal
 * (bot.entities[id]), bound the wait in game time, and fail loudly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { attackEntity } from '../src/agent/library/skills.js';

const registry = Registry('1.20.4');

function mkBot({ mob = 'sheep' } = {}) {
    const entity = { id: 7, name: mob, position: new Vec3(2, 33, 0), metadata: [] };
    const bot = Object.assign(new EventEmitter(), {
        registry,
        output: '',
        interrupt_code: false,
        entity: { position: new Vec3(0, 33, 0) },
        entities: { 7: entity },
        inventory: { items: () => [] },
        setControlState() {},
        async lookAt() {},
        nearestEntity: () => null,
        async pathFinderGoTo() {},
        pathfinder: { setMovements() {}, stop() {}, async goto() {}, setGoal() {} },
        pvp: { attacks: 0, stopped: 0, attack() { bot.pvp.attacks++; }, stop() { bot.pvp.stopped++; } },
        async equipItem() { return true; },
        heldItems: [],
        _tick: 0,
        async waitForTicks(n) {
            for (let t = 0; t < n; t++) {
                await new Promise((r) => setTimeout(r, 1));
                bot._tick += 1;
            }
        },
    });
    bot._entity = entity;
    return bot;
}

describe('fix130 attackEntity kill path: observability, honest verification, bounded wait', () => {
    it('logs the engagement and returns true when the client confirms death (entity removed)', async () => {
        const bot = mkBot({});
        setTimeout(() => { delete bot.entities[7]; }, 30);
        assert.strictEqual(await attackEntity(bot, bot._entity, true), true);
        assert.match(bot.output, /Attacking sheep at 2 blocks/);
        assert.match(bot.output, /Successfully killed sheep/);
        assert.ok(bot.pvp.attacks >= 1, 'pvp.attack never called');
    });

    it('fails loudly when the mob is still alive after the bounded wait instead of looping forever', async () => {
        const bot = mkBot({});
        const t0 = Date.now();
        assert.strictEqual(await attackEntity(bot, bot._entity, true), false);
        assert.ok(Date.now() - t0 < 30000, 'wait was not bounded');
        assert.match(bot.output, /FAILED: sheep still alive after 30 game seconds/);
        assert.strictEqual(bot.pvp.stopped >= 1, true, 'pvp never stopped after giving up');
    });

    it('a mob that merely left the window (still in client knowledge) is not counted as killed', async () => {
        const bot = mkBot({});
        // entity stays in bot.entities but 500 blocks away: not a death
        bot._entity.position = new Vec3(500, 33, 0);
        const t0 = Date.now();
        assert.strictEqual(await attackEntity(bot, bot._entity, true), false);
        assert.ok(Date.now() - t0 < 30000);
        assert.doesNotMatch(bot.output, /Successfully killed/);
    });

    it('honours interrupt_code during the wait and stops pvp', async () => {
        const bot = mkBot({});
        bot.waitForTicks = async (n) => { await new Promise((r) => setTimeout(r, 5 * n)); bot.interrupt_code = true; };
        assert.strictEqual(await attackEntity(bot, bot._entity, true), false);
        assert.strictEqual(bot.pvp.stopped >= 1, true);
    });
});
