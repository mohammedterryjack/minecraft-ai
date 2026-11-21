// fix154 regression: pillarUp placed at a rising height threshold (y - baseY >= 1.05), where the
// client still moves up ~0.18 blocks/tick. The server refuses a block whose cell intersects the
// player's hitbox (minecraft.wiki/w/Place) using ITS position view; ViaProxy's 26.1->26.3 input
// translation lags that view by a tick or two (server log "standing on air - force-sending blocks
// below", ~950/day on 21 Nov 2026 while the bot looped at (-22, 71, 49) with
// "Server refused ... the block is still air"). Placing at the jump apex (vertical velocity ~0,
// detected as "no longer rising", jump peaks 1.25 blocks per minecraft.wiki/w/Jump) keeps the
// lagged hitbox above the vacated cell. The mock below is the fix129 physics mock plus a 2-tick
// lagged server-side position in the vanilla setblock occupancy rule.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { pillarUp } from '../src/agent/library/skills.js';

const registry = Registry('1.20.4');
const SERVER_LAG_TICKS = 2;

function mkLaggedShaftBot({ start = [0, 33, 0] } = {}) {
    const world = new Map([[`${start[0]},${start[1] - 1},${start[2]}`, 'stone']]);
    const state = { jump: false };
    const bot = Object.assign(new EventEmitter(), {
        registry,
        output: '',
        interrupt_code: false,
        restrict_to_inventory: false,
        game: { gameMode: 'survival' },
        modes: { isOn: (m) => m === 'cheat' },
        entity: { position: new Vec3(...start), isInWater: false },
        inventory: {
            items: () => [{ name: 'cobblestone', count: 64 }],
            findInventoryItem: (n) => ({ name: n, count: 64 }),
        },
        setControlState(n, v) { state[n] = v; },
        async lookAt() {},
        blockAt(p) {
            const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
            const k = `${x},${y},${z}`;
            const name = world.has(k) ? world.get(k) : 'air';
            return { name, position: new Vec3(x, y, z), liquid: false };
        },
        chat(msg) {
            const m = msg.match(/\/setblock (-?\d+) (-?\d+) (-?\d+) (\S+)/);
            if (!m) return;
            const [, x, y, z, n] = m;
            if (n === 'air') world.delete(`${x},${y},${z}`);
            // vanilla rule (minecraft.wiki/w/Place): a cell intersecting the player is refused —
            // but the server applies it with its LAGGED view of the player position.
            else if (bot.serverY >= Number(y) + 1) world.set(`${x},${y},${z}`, n);
        },
        async waitForTicks(n) {
            for (let t = 0; t < n; t++) {
                if (state.jump && bot._onGround) { bot._vy = 0.42; bot._onGround = false; }
                let y = bot.entity.position.y + bot._vy;
                bot._vy -= 0.08;
                const fx = Math.floor(bot.entity.position.x), fz = Math.floor(bot.entity.position.z);
                let stand = Number.NEGATIVE_INFINITY;
                for (let cy = Math.floor(y) + 1; cy >= Math.floor(y) - 1; cy--) {
                    if (world.has(`${fx},${cy},${fz}`)) { stand = cy + 1; break; }
                }
                if (bot._vy <= 0 && y <= stand) { y = stand; bot._vy = 0; bot._onGround = true; }
                bot.entity.position.y = y;
                // the server sees where the client was SERVER_LAG_TICKS ago
                bot._yHist.push(y);
                bot.serverY = bot._yHist.length > SERVER_LAG_TICKS ? bot._yHist[bot._yHist.length - 1 - SERVER_LAG_TICKS] : start[1];
                await Promise.resolve();
            }
        },
        _vy: 0,
        _onGround: true,
        _yHist: [],
        serverY: start[1],
    });
    bot._world = world;
    return bot;
}

describe('fix154 pillarUp places at the jump apex, surviving a lagged server position view', () => {
    it('climbs a dry shaft even though the server sees the player 2 ticks late', async () => {
        const bot = mkLaggedShaftBot({});
        const res = await pillarUp(bot, 36);
        assert.strictEqual(res.ok, true, `output: ${bot.output}`);
        assert.strictEqual(res.climbed, 3);
        assert.ok(Math.abs(bot.entity.position.y - 36) < 0.01, `y=${bot.entity.position.y}`);
        for (const y of [33, 34, 35]) assert.strictEqual(bot._world.get(`0,${y},0`), 'cobblestone', `no block at y=${y}`);
    });

    it('the lag rule really rejects mid-rise placements (the test would fail the old threshold)', async () => {
        // sanity: at y-baseY crossing 1.05 rising, the 2-tick-lagged server position is still
        // inside the feet cell, so the old >=1.05 threshold cannot place (this is what the live
        // server did at (-22, 71, 49)); at the apex it must accept.
        const bot = mkLaggedShaftBot({});
        const base = 33;
        bot.setControlState('jump', true);
        let rejectedAtThreshold = false;
        let acceptedAtApex = false;
        let prevY = base;
        for (let tick = 0; tick < 40; tick++) {
            await bot.waitForTicks(1);
            const y = bot.entity.position.y;
            if (!rejectedAtThreshold && y - base >= 1.05 && bot.serverY < base + 1) {
                bot.chat(`/setblock 0 ${base} 0 cobblestone`);
                if (!bot._world.has(`0,${base},0`)) rejectedAtThreshold = true;
            }
            if (rejectedAtThreshold && !acceptedAtApex && y - base >= 1.0 && y <= prevY) {
                bot.chat(`/setblock 0 ${base} 0 cobblestone`);
                if (bot._world.has(`0,${base},0`)) acceptedAtApex = true;
            }
            prevY = y;
        }
        assert.ok(rejectedAtThreshold, 'mid-rise placement must be rejected by the lagged server (physics changed?)');
        assert.ok(acceptedAtApex, 'apex placement must be accepted by the lagged server');
    });
});
