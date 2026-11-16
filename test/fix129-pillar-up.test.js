/**
 * fix129 (live icefox2000, 16 Nov 2026): dry-shaft escape. mineflayer-pathfinder 2.4.5 models
 * upward movement only as (a) the diagonal jump-up onto a one-block ledge — getMoveJumpUp
 * requires the diagonal destination block B one above the node (lib/movements.js:331) — or
 * (b) getMoveUp in the same column, which only exists for climbable blocks (ladder/vine,
 * lib/movements.js:553). There is no same-column jump-and-place movement (allow1by1towers,
 * lib/Movements.js:31, still needs the diagonal ledge), so a dry 1-wide shaft is structurally
 * impossible for pathfinding: the bot cannot escape (live: shaft at (-176, 48, 106), stall at
 * (-173, 33, 98) while goals above the shaft were pending).
 * pillarUp() performs the documented player technique with the documented mineflayer APIs —
 * setControlState('jump', true) and placing against the block under the feet while the
 * hitbox has cleared the target cell — one block at a time, bounded only by the target height,
 * and goToGoal uses it as a climb leg (same segment-traversal pattern as fix124b2's swim leg).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { pillarUp, goToGoal } from '../src/agent/library/skills.js';
import { setMovementStore } from '../src/utils/movement_model.js';

const registry = Registry('1.20.4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mini physics mock: real jump arc (v0=0.42, g=0.08/tick -> ~1.25 block jump like the game),
// solid-cell world map, and a /setblock handler that refuses a cell the bot's hitbox still
// intersects — exactly the vanilla rule that makes pillars need jump timing.
function mkShaftBot({ start = [0, 33, 0], blocks = 64, cheat = true, placeable = true } = {}) {
    const world = new Map([[`${start[0]},${start[1] - 1},${start[2]}`, 'stone']]);
    const state = { jump: false };
    const bot = Object.assign(new EventEmitter(), {
        registry,
        output: '',
        interrupt_code: false,
        restrict_to_inventory: false,
        game: { gameMode: 'survival' },
        modes: { isOn: (m) => m === 'cheat' && cheat },
        entity: { position: new Vec3(...start), isInWater: false },
        inventory: {
            items: () => (blocks > 0 && placeable ? [{ name: 'cobblestone', count: blocks }] : []),
            findInventoryItem: (n) => (blocks > 0 && placeable ? { name: n, count: blocks } : null),
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
            const [, x, y, z, n] = m.map((v, i) => (i === 0 ? v : v));
            if (n === 'air') world.delete(`${x},${y},${z}`);
            else if (bot.entity.position.y >= Number(y) + 1) world.set(`${x},${y},${z}`, n); // vanilla: refuse cells the hitbox intersects
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
                await Promise.resolve();
            }
        },
        _vy: 0,
        _onGround: true,
    });
    bot._world = world;
    return bot;
}

describe('fix129 pillarUp: same-column jump-and-place climb', () => {
    it('pillars 3 blocks up a dry shaft to the target height', async () => {
        const bot = mkShaftBot({});
        const res = await pillarUp(bot, 36);
        assert.strictEqual(res.ok, true, `output: ${bot.output}`);
        assert.strictEqual(res.climbed, 3);
        assert.ok(Math.abs(bot.entity.position.y - 36) < 0.01, `y=${bot.entity.position.y}`);
        for (const y of [33, 34, 35]) assert.strictEqual(bot._world.get(`0,${y},0`), 'cobblestone', `no block at y=${y}`);
    });

    it('fails loudly when there is no placeable full block in inventory', async () => {
        const bot = mkShaftBot({ placeable: false });
        const res = await pillarUp(bot, 35);
        assert.strictEqual(res.ok, false);
        assert.match(res.reason, /placeable/);
    });

    it('fails loudly when placement is refused for two game seconds (hitbox never clears)', async () => {
        const bot = mkShaftBot({});
        const y0 = bot.entity.position.y;
        const orig = bot.waitForTicks;
        bot.waitForTicks = async (n) => { // low ceiling: feet never clear the target cell top
            await orig(n);
            if (bot.entity.position.y > y0 + 0.95) bot.entity.position.y = y0 + 0.95;
        };
        const res = await pillarUp(bot, 35);
        assert.strictEqual(res.ok, false);
        assert.match(res.reason, /refused|blocked/);
    });

    it('honours interrupt_code mid-climb', async () => {
        const bot = mkShaftBot({});
        const origChat = bot.chat.bind(bot);
        bot.chat = (m) => { bot.interrupt_code = true; origChat(m); };
        const res = await pillarUp(bot, 500);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.interrupted, true);
    });
});

describe('fix129 goToGoal uses the climb leg for shafts', () => {
    it('a stalled walk toward a goal above the shaft pillars up and finishes', async () => {
        setMovementStore({ walk: { n: 5, max: 200, cuts: 0 }, swim: { n: 5, max: 200, cuts: 0 } });
        const bot = mkShaftBot({ start: [-173, 33, 98] });
        // each goto stalls (walks nowhere) until the learned walk bound (200ms) fires, then
        // succeeds once the bot has been pillared up
        bot.pathfinder = {
            _moves: 0,
            setMovements() {},
            stop() {},
            isMoving() { return bot._inWalk; },
            isMining() { return false; },
            isBuilding() { return false; },
            async getPathTo() { return { status: 'success' }; },
            async goto() {
                bot.pathfinder._moves += 1;
                if (bot.entity.position.y >= 39) return; // once near the goal height, walk succeeds
                bot._inWalk = true;
                bot.emit('physicsTick');
                await sleep(260);
                bot.emit('physicsTick');
                bot._inWalk = false;
            },
        };
        const ok = await goToGoal(bot, { x: -173, y: 40, z: 98 });
        assert.strictEqual(ok, true, `output: ${bot.output}`);
        assert.match(bot.output, /Pillared .* blocks up/);
        assert.ok(bot._world.get('-173,33,98'), 'no pillar block placed');
    });
});
