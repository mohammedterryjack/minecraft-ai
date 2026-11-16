/**
 * fix134 (live icefox2000, 16 Nov 2026 ~21:00 GMT): smeltIron demoted after furnace placements
 * refused at (-7,19,39)/(-11,76,66) with "the block is still air", and ensureCraftingTable saw
 * "placeBlock returned true at (-12,20,41) but block is air". ensureFurnace places at
 * getNearestFreeSpace(bot,1,6), and getAllFreeSpaces returns the AIR CELL THE BOT STANDS IN
 * (torso cell: air over solid floor) — it is the nearest one. The server then refuses the
 * placement outright: a block cannot be placed inside an entity ("cannot place a block inside a
 * player/world entity", https://minecraft.wiki/w/Block_placement; the interact packet is rejected,
 * no block change — exactly the fork's 'Server refused ... still air', place_block.js:42).
 * placeBlock's too-close handling made it worse: it walked AWAY from the cell and placed there
 * anyway, and _reachBlock digs the target cell from the inside. It must move to a cell where it
 * can place the target — not away from it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Vec3 from 'vec3';
import Registry from 'prismarine-registry';
import { getAllFreeSpaces, getNearestFreeSpace } from '../src/agent/library/world.js';
import { placeBlock } from '../src/agent/library/skills.js';

const registry = Registry('1.20.4');

function makeWorld(airCells) {
    const solid = (p) => ({ name: 'stone', position: p, diggable: true, drops: [1] });
    const air = (p) => ({ name: 'air', position: p, diggable: true, drops: [] });
    const at = (p) => {
        const k = `${p.x},${p.y},${p.z}`;
        return airCells.has(k) ? air(p) : solid(p);
    };
    const bot = Object.assign(new EventEmitter(), {
        registry,
        game: { gameMode: 'survival' },
        modes: { isOn: () => false, pause() {} },
        restrict_to_inventory: false,
        entity: { position: new Vec3(-7.5, 19, 39.5), width: 0.6, height: 1.8, eyeHeight: 1.62 },
        inventory: { findInventoryItem: (n) => (n === 'furnace' ? { name: 'furnace', count: 1 } : null), items: () => [] },
        blockAt: at,
        findBlocks: ({ matching, maxDistance }) => {
            const out = [];
            for (const k of airCells) {
                const [x, y, z] = k.split(',').map(Number);
                const p = new Vec3(x, y, z);
                if (matching(at(p)) && Math.max(Math.abs(x - -7), Math.abs(y - 19), Math.abs(z - 39)) <= maxDistance) out.push(p);
            }
            return out;
        },
        canSeeBlock: () => true,
        equip: async () => {},
        lookAt: async () => {},
        heldItem: { name: 'furnace' },
        pathfinder: { setMovements() {}, async goto() {} },
        output: '',
        interrupt_code: false,
    });
    return bot;
}

describe('fix134 free-space search excludes cells occupied by the bot', () => {
    it('getAllFreeSpaces skips the feet and torso cells; other air cells remain', () => {
        // Bot at (-7.5,19,39.5): body spans columns x in [-7.8,-7.2] (block column -8), z 39,
        // y 19..20. The torso cell (-8,19,39) is air over solid floor.
        const airCells = new Set(['-8,19,39', '-7,19,39', '-8,19,40']);
        const bot = makeWorld(airCells);
        const spaces = getAllFreeSpaces(bot, 1, 6, 10);
        const has = (p) => spaces.some((s) => s.x === p[0] && s.y === p[1] && s.z === p[2]);
        assert.ok(!has([-8, 19, 39]), `torso cell still offered as free: ${JSON.stringify(spaces.map(String))}`);
        assert.ok(has([-7, 19, 39]), 'neighbour air cell should still be free');
        assert.ok(has([-8, 19, 40]), 'neighbour air cell should still be free');
    });

    it('placeBlock standing in the target cell fails loud without moving away', async () => {
        // The only free space is the cell the bot stands in. placeBlock must NOT pathfind away
        // (the old code did, then placed at the now-empty-behind cell or dug it out).
        const airCells = new Set(['-8,19,39']);
        const bot = makeWorld(airCells);
        let movedTo = null;
        bot.pathfinder.goto = async () => { movedTo = 'moved'; };
        let placedRef = null;
        bot.placeBlock = async (ref, face) => {
            placedRef = { ref: ref.position, face };
            // Server rule: placement into a cell the bot's hitbox occupies is rejected.
            const feet = bot.entity.position;
            const inside = Math.floor(feet.x) === ref.position.x + face.x
                && Math.floor(feet.y) === ref.position.y + face.y
                && Math.floor(feet.z) === ref.position.z + face.z;
            if (inside) throw new Error('Server refused to place furnace: the block is still air');
        };
        const ok = await placeBlock(bot, 'furnace', -8, 19, 39);
        assert.equal(movedTo, null, 'bot must not pathfind away from the target it is standing in');
        assert.equal(placedRef, null, 'no placement attempt into the bot cell');
        assert.equal(ok, false);
        assert.match(bot.output, /bot itself occupies that cell/);
    });

    it('placeBlock at an adjacent cell places while standing beside it (regression)', async () => {
        const airCells = new Set(['-7,19,39', '-8,19,39']);
        const bot = makeWorld(airCells);
        let placed = null;
        bot.placeBlock = async (ref, face) => { placed = ref.position; };
        const ok = await placeBlock(bot, 'furnace', -7, 19, 39);
        assert.ok(placed, 'placement call expected for adjacent free cell');
    });
});
