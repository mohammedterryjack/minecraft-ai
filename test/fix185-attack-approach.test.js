/**
 * fix185 (live icefox2000, 25 Nov 2026): hunger tasks died on standing still.
 * "Attacking cod at 31 blocks." → "cod still alive after 30 game seconds (now 29 blocks away)" x4:
 * pvp.attack sets only GoalFollow (PVP.js:72) and pathfinder 2.4.5 refuses liquid nodes
 * (movements.js:526,546,642) — a fish below the surface has no path, so the bot stands at the
 * shore for the whole 30-game-second window without moving an inch. attackEntity must close the
 * distance with the library's own navigation first (goToPosition: stall watchdog, walk/swim
 * segments, honest noPath verdict — movements.js/astar.js exhaustion semantics per fix121), the
 * same approach the non-kill branch of the same function already does, and fail fast when the
 * target column is unreachable instead of burning the window idle.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { attackEntity } from '../src/agent/library/skills.js';

const registry = Registry('1.20.4');

function mkBot({ distance = 2, pathStatus = 'noPath' } = {}) {
    const entity = { id: 7, name: 'cod', position: new Vec3(distance, 33, 0), metadata: [] };
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
        blockAt: () => ({ name: 'air', liquid: false, isEmpty: true }),
        modes: { isOn: () => false },
        pathfinder: {
            pathCalls: 0,
            setMovements() {}, stop() {}, async goto() {}, setGoal() {},
            async getPathTo() { bot.pathfinder.pathCalls++; return { status: pathStatus }; },
        },
        pvp: { attacks: 0, stopped: 0, attack() { bot.pvp.attacks++; }, stop() { bot.pvp.stopped++; } },
        async equipItem() { return true; },
        heldItems: [],
        async waitForTicks(n) { await new Promise((r) => setTimeout(r, n)); },
    });
    bot._entity = entity;
    return bot;
}

describe('fix185 attackEntity approaches a far target before melee', () => {
    it('a target beyond reach navigates first; when the column is unreachable it fails fast without swinging', async () => {
        const bot = mkBot({ distance: 31, pathStatus: 'noPath' });
        const t0 = Date.now();
        assert.strictEqual(await attackEntity(bot, bot._entity, true), false);
        assert.ok(Date.now() - t0 < 5000, 'unreachable target must fail fast, not burn the 30 s window');
        assert.ok(bot.pathfinder.pathCalls >= 1, 'no navigation attempted for a 31-block target');
        assert.strictEqual(bot.pvp.attacks, 0, 'pvp.attack called while target out of reach');
        assert.match(bot.output, /could not reach cod/);
        assert.doesNotMatch(bot.output, /Attacking cod/);
    });

    it('a target in reach attacks immediately without navigation', async () => {
        const bot = mkBot({ distance: 2 });
        setTimeout(() => { delete bot.entities[7]; }, 30);
        assert.strictEqual(await attackEntity(bot, bot._entity, true), true);
        assert.strictEqual(bot.pathfinder.pathCalls, 0, 'navigation attempted for a 2-block target');
        assert.match(bot.output, /Attacking cod at 2 blocks/);
    });
});
