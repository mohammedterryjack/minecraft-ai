/**
 * fix189 (live icefox2000, 25 Nov 2026): shelterNow walled the bot into a fully sealed 1x2 pocket
 * (4 foot walls, 4 head walls, lid), logged "Wait for day (time > 23500) then break out" and
 * RETURNED — but nothing ever broke out. mineflayer-pathfinder plans routes and never mines
 * (lib/goto.js never calls bot.dig; Movements.canDig only prices moves, lib/movements.js:271), so
 * every later moveAway from inside the pocket failed with "no traversable route away from here"
 * (live at (-36, 77, 118)): unstuck interrupted everything on a 20 s stillness timer and could
 * only fail again. The fix: shelterNow owns the whole protocol — seal, wait until morning, break a
 * foot-level wall cell (the ones it placed itself first), move out, with lid-break + pillarUp
 * (fix129) and any-foot-cell (re-entry into an old pocket) as the remaining routes.
 * The tests drive that protocol against a cheat-mode mock world (/setblock and /tp handled in
 * chat, vanilla hitbox refusal kept for the bot's own column, fix129 jump physics for the climb).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { shelterNow } from '../src/agent/library/skills.js';

const registry = Registry('1.20.4');
const GROUND_Y = 61; // solid up to and including y=GROUND_Y, bot stands at y=62
const START = [10.5, 62, 10.5]; // block-centred like a real player
const B = [10, 62, 10];         // floored cell the bot stands in
const WALLS = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[1,1,0],[-1,1,0],[0,1,1],[0,1,-1],[0,2,0]];
const DOOR = '11,62,10'; // first needed foot-level wall cell (offset +x)

// times: read#1 shelterNow bed check, then two reads per wait-loop condition.
// [14000, 14000, 23501] = "seal at night, morning arrives on the next poll".
function mkShelterBot({ dirt = 9, times = [14000], moveAwayThrows = false, refusedBreaks = new Set(), supports = false } = {}) {
    const overrides = new Map(); // "x,y,z" -> 'dirt' | 'air' | 'stone' (world = stone up to GROUND_Y otherwise)
    if (supports) {
        // a lid cell only builds off an adjacent solid (live log: "Shelter incomplete: 1 gaps left"
        // on flat ground, "Sheltered: walled in" on slopes) — hillside support next to the lid
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) overrides.set(`${B[0] + dx},64,${B[2] + dz}`, 'stone');
    }
    const solid = (x, y, z) => {
        const o = overrides.get(`${x},${y},${z}`);
        if (o !== undefined) return o !== 'air';
        return y <= GROUND_Y;
    };
    const state = { jump: false };
    let timeReads = 0;
    const bot = Object.assign(new EventEmitter(), {
        registry,
        output: '',
        interrupt_code: false,
        restrict_to_inventory: false,
        food: 20, health: 20,
        game: { gameMode: 'survival', minY: -60 },
        modes: { isOn: (m) => m === 'cheat' },
        time: { get timeOfDay() { return times[Math.min(timeReads++, times.length - 1)]; } },
        entity: { position: new Vec3(...START), effects: [], isInWater: false, isInLava: false, eyeHeight: 1.62, height: 1.8, width: 0.6 },
        inventory: {
            slots: (() => { const s = new Array(46).fill(null); if (dirt > 0) s[36] = { name: 'dirt', count: dirt }; return s; })(),
            items: () => (dirt > 0 ? [{ name: 'dirt', count: dirt }] : []),
            findInventoryItem: (n) => (dirt > 0 ? { name: n, count: dirt } : null),
        },
        findBlocks: () => [],           // no beds anywhere
        pathfinder: {
            setMovements() {},
            stop() {},
            async getPathTo() {
                if (moveAwayThrows) throw new Error('pathfinder refused');
                const p = bot.entity.position;
                return { path: [{ x: p.x + 8, y: p.y, z: p.z + 8 }] };
            },
        },
        setControlState(n, v) { state[n] = v; },
        async equip(item) { bot._hand = item?.name ?? 'dirt'; return 0; },
        async placeBlock(block, faceVec) {
            // server-side placement: dest = clicked block + face normal; vanilla refuses a dest
            // inside the player's own hitbox (fix129/fix134 rule kept from the live server)
            const dest = block.position.offset(faceVec.x, faceVec.y, faceVec.z);
            const fx = Math.floor(bot.entity.position.x), fz = Math.floor(bot.entity.position.z);
            // vanilla refuses placement where the player's 1.8-tall box overlaps the dest cell
            if (dest.x === fx && dest.z === fz && bot.entity.position.y < dest.y + 1 && bot.entity.position.y + 1.8 > dest.y) return;
            overrides.set(`${dest.x},${dest.y},${dest.z}`, bot._hand ?? 'dirt');
        },
        async lookAt() {},
        chat(msg) {
            const m = msg.match(/\/setblock (-?\d+) (-?\d+) (-?\d+) (\S+)/);
            if (m) {
                const [, x, y, z, n] = m;
                if (refusedBreaks.has(`${x},${y},${z}`) || (n === 'air' && refusedBreaks.has('*'))) return;
                if (n === 'air') overrides.set(`${x},${y},${z}`, 'air');
                else {
                    // vanilla physics the /setblock server command still enforces:
                    // 1. refuse a cell the player's own hitbox occupies
                    const fx = Math.floor(bot.entity.position.x), fz = Math.floor(bot.entity.position.z);
                    if (Number(x) === fx && Number(z) === fz && bot.entity.position.y < Number(y) + 1) return;
                    // 2. dirt needs an adjacent non-air block to attach to
                    const nb = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
                        .some(([dx, dy, dz]) => solid(Number(x) + dx, Number(y) + dy, Number(z) + dz));
                    if (!nb) return;
                    overrides.set(`${x},${y},${z}`, n);
                }
                return;
            }
            const t = msg.match(/\/tp @s (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/);
            if (t) bot.entity.position = new Vec3(Number(t[1]), Number(t[2]), Number(t[3]));
        },
        blockAt(p) {
            const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
            const o = overrides.get(`${x},${y},${z}`);
            const name = o !== undefined ? o : (y <= GROUND_Y ? 'stone' : 'air');
            const def = registry.blocksByName[name] || registry.blocksByName.stone;
            return {
                name, type: def.id,
                boundingBox: def.boundingBox,
                position: new Vec3(x, y, z),
                diggable: true, liquid: false, digTime: () => 100,
            };
        },
        // line of sight from the eye to a block center; the bot's own cells never block it
        canSeeBlock(block) {
            const eye = bot.entity.position.offset(0.3, bot.entity.eyeHeight, 0.3);
            const dest = block.position.offset(0.5, 0.5, 0.5);
            const ownX = Math.floor(bot.entity.position.x), ownZ = Math.floor(bot.entity.position.z);
            for (let s = 0.1; s < 0.95; s += 0.05) {
                const p = {
                    x: eye.x + (dest.x - eye.x) * s,
                    y: eye.y + (dest.y - eye.y) * s,
                    z: eye.z + (dest.z - eye.z) * s,
                };
                const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z);
                if (cx === Math.floor(dest.x) && cy === Math.floor(dest.y) && cz === Math.floor(dest.z)) break;
                if (cx === ownX && cz === ownZ) continue;
                if (solid(cx, cy, cz)) return false;
            }
            return true;
        },
        // fix129 jump physics (v0=0.42, g=0.08 -> ~1.25 block jump) for the pillarUp climb leg
        async waitForTicks(n) {
            for (let t = 0; t < n; t++) {
                if (state.jump && bot._onGround) { bot._vy = 0.42; bot._onGround = false; }
                let y = bot.entity.position.y + bot._vy;
                bot._vy -= 0.08;
                const fx = Math.floor(bot.entity.position.x), fz = Math.floor(bot.entity.position.z);
                let stand = Number.NEGATIVE_INFINITY;
                for (let cy = Math.floor(y) + 1; cy >= Math.floor(y) - 1; cy--) {
                    if (solid(fx, cy, fz)) { stand = cy + 1; break; }
                }
                if (bot._vy <= 0 && y <= stand) { y = stand; bot._vy = 0; bot._onGround = true; }
                bot.entity.position.y = y;
                await Promise.resolve();
            }
        },
        _vy: 0,
        _onGround: true,
        _world: overrides,
    });
    return bot;
}

// seal a pocket by hand (every wall solid in overrides), leaving the bot inside
function sealByHand(bot) {
    for (const [dx, dy, dz] of WALLS) bot._world.set(`${B[0] + dx},${B[1] + dy},${B[2] + dz}`, 'stone');
}

describe('fix189 shelterNow seals, waits for day, then breaks its own door and walks out', () => {
    it('walls in, breaks a foot-level door in the morning, and the bot is out', async () => {
        const bot = mkShelterBot({ dirt: 9, times: [14000, 14000, 23501], supports: true });
        const ok = await shelterNow(bot);
        assert.strictEqual(ok, true, `output: ${bot.output}`);
        assert.match(bot.output, /Waiting for day, then digging out/);
        assert.strictEqual(bot._world.get(DOOR) ?? 'air', 'air', 'foot-level door must be broken');
        assert.ok(bot.entity.position.distanceTo(new Vec3(...START)) >= 1, 'bot never left the pocket');
        for (const [dx, dy, dz] of WALLS) {
            const k = `${B[0] + dx},${B[1] + dy},${B[2] + dz}`;
            if (k === DOOR) continue;
            assert.strictEqual(bot._world.get(k), 'dirt', `wall ${k} should still be placed`);
        }
    });

    it('interrupted during the wait: it still breaks a door before yielding control', async () => {
        const bot = mkShelterBot({ dirt: 9, times: [14000], supports: true });
        bot.interrupt_code = true;
        const ok = await shelterNow(bot);
        assert.strictEqual(ok, true, `output: ${bot.output}`);
        assert.strictEqual(bot._world.get(DOOR) ?? 'air', 'air', 'door must be broken even when interrupted');
    });

    it('re-entry into an old sealed pocket (nothing placed this run, no blocks): digs a foot wall out', async () => {
        const bot = mkShelterBot({ dirt: 0, times: [23501] });
        sealByHand(bot);
        // digDown(3) inside the pocket then fails the seal path; give it the morning exit instead:
        // needed cells are all solid -> total 0 < 9 -> digs down -> lid (stone) already solid above
        // -> helper runs with no placed cells. With dirt 0 pillarUp cannot climb, so it must break
        // a foot-level wall cell and walk out.
        const ok = await shelterNow(bot);
        assert.strictEqual(ok, true, `output: ${bot.output}`);
        const footOpen = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
            .some(([dx, , dz]) => (bot._world.get(`${B[0] + dx},${B[1]},${B[2] + dz}`) ?? 'air') === 'air');
        assert.ok(footOpen, `no foot-level cell broken: ${JSON.stringify([...bot._world])}`);
    });

    it('fails loudly instead of claiming success when nothing can be broken and moveAway errors', async () => {
        const bot = mkShelterBot({ dirt: 9, times: [14000, 14000, 23501], moveAwayThrows: true, refusedBreaks: new Set(['*']), supports: true });
        const ok = await shelterNow(bot);
        assert.strictEqual(ok, false, `must not claim success while entombed: ${bot.output}`);
        assert.match(bot.output, /could not break out/);
    });
});
