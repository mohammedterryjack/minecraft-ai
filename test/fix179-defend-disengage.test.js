/**
 * fix179 (live icefox2000, 23 Nov): "shot by Pillager" x3 — defendSelf's combat loop only
 * exits on enemy death or interrupt, so it chases ranged mobs (Pillager crossbow, https://minecraft.wiki/w/Pillager
 * attacks from range) across any distance until the bot dies. Death hotspots recorded each
 * time. Disengage now uses the same "dying" rule as self_preservation (modes.js): recent
 * damage and (health < 5 or the last hit could finish us) -> stop attacking and retreat.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { defendSelf } from '../src/agent/library/skills.js';

const registry = Registry('1.20.4');

function mkBot({ health, lastDamageTaken, lastDamageAgeMs }) {
    const log_lines = [];
    const bot = Object.assign(new EventEmitter(), {
        registry,
        health,
        food: 20,
        lastDamageTime: Date.now() - lastDamageAgeMs,
        lastDamageTaken,
        interrupt_code: false,
        entity: { position: new Vec3(0, 64, 0) },
        entities: { '7': { name: 'pillager', type: 'mob', position: new Vec3(6, 64, 0), id: 7n, alive: true } },
        modes: { pause() {}, isOn: () => false },
        nearestEntity(pred) {
            let best = null, bestD = Infinity;
            for (const e of Object.values(bot.entities)) {
                const d = bot.entity.position.distanceTo(e.position);
                if (pred(e) && d < bestD) { best = e; bestD = d; }
            }
            return best;
        },
        inventory: { items: () => [] },
        chat() {},
        on() {},
        setControlState() {},
        async lookAt() {},
        async waitForTicks(n) { for (let t = 0; t < n; t++) await Promise.resolve(); },
        pathfinder: {
            retreated: false,
            setMovements() {},
            stop() {},
            isMoving() { return false; },
            isMining() { return false; },
            isBuilding() { return false; },
            async getPathTo() { return { status: 'success' }; },
            async goto(goal) {
                if (typeof goal.x === 'number') bot.entity.position.set(goal.x, goal.y, goal.z);
                else { bot.pathfinder.retreated = true; bot.entity.position.x += 20; }
            },
        },
        pvp: { attacked: [], stop() { bot.pvp.attacked.push('stop'); } },
    });
    bot.on('error', () => {});
    Object.defineProperty(bot, '__log', { value: log_lines });
    return bot;
}

describe('fix179: defendSelf disengages when about to die', () => {
    it('recent lethal damage -> no swing, retreat instead', async () => {
        const bot = mkBot({ health: 3, lastDamageTaken: 4, lastDamageAgeMs: 100 });
        const attacked = await defendSelf(bot, 8);
        assert.equal(attacked, false);
        assert.equal(bot.pvp.attacked.filter((a) => a !== 'stop').length, 0, 'must not attack while dying');
        assert.ok(bot.pathfinder.retreated, 'must retreat (GoalInvert move-away)');
    });
    it('healthy bot still fights', async () => {
        const bot = mkBot({ health: 20, lastDamageTaken: 1, lastDamageAgeMs: 100 });
        // one swing then interrupt to end the loop (enemy stays alive in this world)
        bot.pvp.attack = (e) => { bot.pvp.attacked.push(e.name); bot.interrupt_code = true; };
        await defendSelf(bot, 8);
        assert.ok(bot.pvp.attacked.includes('pillager'), 'healthy bot must swing at the hostile');
    });
    it('old damage with low health does not block fighting (recency rule, same as self_preservation)', async () => {
        const bot = mkBot({ health: 3, lastDamageTaken: 1, lastDamageAgeMs: 10_000 });
        bot.pvp.attack = (e) => { bot.pvp.attacked.push(e.name); bot.interrupt_code = true; };
        await defendSelf(bot, 8);
        assert.ok(bot.pvp.attacked.includes('pillager'), 'healed-over time means the bot may re-engage');
    });
});
