/**
 * fix124b2 (live iMac 2026-11-16, 11:0x GMT): after fix124's start-of-navigation swim gate
 * deployed, "Smelt 5 raw_iron into 5 iron_ingot" still died with "goToNearestBlock: FAILED:
 * navigation stalled - no swim progress for 2634ms" — the bot started on dry land, walked
 * into the flooded shaft mid-route, and the pathfinder cannot move in liquid at all
 * (node_modules/mineflayer-pathfinder/lib/movements.js:526,546,556). goToGoal now traverses
 * a route in segments: when the learned watchdog kills a walk with the bot in water, swim
 * the water leg toward the goal column (swimTowards) and plan the walk again; landing on a
 * previously-landed cell is an oscillation and fails loudly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { goToGoal } from '../src/agent/library/skills.js';
import { setMovementStore } from '../src/utils/movement_model.js';

const registry = Registry('1.20.4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Geometry: dry start at x=-175, a flooded pool over cells floor(x) in [-169, -167],
// dry goal side at x=-165. The bot starts dry (no gate swim); each goto() teleports it
// into the pool and stalls in one cell until the injected learned swim bound (200 ms) fires.
// swimTowards (real code) then pushes it across the pool to x=-166 and clears isInWater.
const inPool = (x) => Math.floor(x) >= -169 && Math.floor(x) <= -167;
function mkBot({ successOnGoto = 2 }) {
    const held = {};
    const bot = Object.assign(new EventEmitter(), {
        registry,
        output: '',
        interrupt_code: false,
        game: { gameMode: 'survival' },
        entity: { position: new Vec3(-175, 41, 104), isInWater: false },
        inventory: { items: () => [] },
        setControlState(n, v) { held[n] = v; },
        async lookAt() {},
        blockAt(p) {
            return inPool(p.x) ? { name: 'water', liquid: true } : { name: 'air', liquid: false };
        },
        async waitForTicks(n) {
            for (let t = 0; t < n; t++) {
                const p = bot.entity.position;
                if (held.forward && p.x < -166) p.x = Math.min(-166, p.x + 2 / 20);
                bot.entity.isInWater = inPool(p.x);
                await Promise.resolve();
            }
        },
        pathfinder: {
            _moves: 0,
            setMovements() {},
            stop() {},
            isMoving() { return bot._inWalk; },
            isMining() { return false; },
            isBuilding() { return false; },
            async getPathTo() { return { status: 'success' }; },
            async goto() {
                bot.pathfinder._moves += 1;
                if (bot.pathfinder._moves >= successOnGoto && successOnGoto > 0) return;
                bot.entity.position.set(-168.5, 41, 104);
                bot.entity.isInWater = true;
                bot._inWalk = true;
                bot.emit('physicsTick');
                await sleep(260);
                bot.emit('physicsTick');
                bot._inWalk = false;
            },
        },
    });
    bot._inWalk = false;
    return bot;
}

describe('fix124b2: goToGoal traverses water legs by swimming', () => {
    it('a mid-route water stall swims the leg and finishes the walk', async () => {
        setMovementStore({ swim: { n: 5, max: 200, cuts: 0 }, walk: { n: 5, max: 5000, cuts: 0 } });
        const bot = mkBot({});
        const ok = await goToGoal(bot, { x: -165, y: 41, z: 104 });
        assert.strictEqual(ok, true, `output: ${bot.output}`);
        assert.match(bot.output, /Walk stalled in the water .* swimming the water leg/);
        assert.strictEqual(bot.pathfinder._moves, 2, 'the walk was re-planned after the swim leg');
    });

    it('swimming back to the same shore twice fails loudly (oscillation)', async () => {
        setMovementStore({ swim: { n: 5, max: 200, cuts: 0 }, walk: { n: 5, max: 5000, cuts: 0 } });
        const bot = mkBot({ successOnGoto: -1 });
        const ok = await goToGoal(bot, { x: -165, y: 41, z: 104 });
        assert.strictEqual(ok, false);
        assert.match(bot.output, /FAILED: swimming out of the water returned to \(-166,41,104\)/);
    });
});
