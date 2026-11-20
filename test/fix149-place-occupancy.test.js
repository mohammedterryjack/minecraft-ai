// fix149: the placement guard at bot.placeBlock/_placeBlockWithOptions must refuse exactly the
// placements the server refuses — a colliding block whose destination cell intersects the bot's
// hitbox — and pass everything else (non-colliding blocks like torches, destinations outside the box).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { installPlaceOccupancyGuard } from '../src/utils/place_occupancy_guard.js';

const reg = minecraftData('26.1');

function makeBot(pos) {
    const calls = [];
    const bot = {
        entity: { position: pos, width: 0.6, height: 1.8 }, // player box, minecraft.wiki/w/Player#Dimensions
        heldItem: null,
        registry: reg,
        placeBlock: async (ref, face) => { calls.push([ref.position, face]); return 'placed'; },
        _placeBlockWithOptions: async (ref, face, opts) => { calls.push([ref.position, face]); return 'placed-opts'; },
        calls,
    };
    installPlaceOccupancyGuard(bot);
    return bot;
}

const cobble = { name: 'cobblestone' };
const torch = { name: 'torch' };

test("colliding block into the bot's own feet cell is refused with a reason", async () => {
    const bot = makeBot(new Vec3(-173.5, 47, 109.5)); // floor(-173.5) = -174: bot inside cell (-174,47,109)
    bot.heldItem = cobble;
    const ref = { position: new Vec3(-174, 46, 109) }; // block below
    await assert.rejects(() => bot.placeBlock(ref, new Vec3(0, 1, 0)), /inside the bot's own hitbox/);
    await assert.rejects(() => bot._placeBlockWithOptions(ref, new Vec3(0, 1, 0), {}), /inside the bot's own hitbox/);
    assert.equal(bot.calls.length, 0);
});

test('head cell is refused too (hitbox spans y..y+1.8)', async () => {
    const bot = makeBot(new Vec3(-173.5, 47, 109.5));
    bot.heldItem = cobble;
    // standing at y=47: torso cell 48 reached by placing sideways at that height
    const ref = { position: new Vec3(-175, 48, 109) };
    await assert.rejects(() => bot.placeBlock(ref, new Vec3(1, 0, 0)), /hitbox/);
});

test('box edges: half-block straddle occupies two cells', async () => {
    // bot centred exactly on a cell boundary occupies cells -175 and -174 (floor math on negatives)
    const bot = makeBot(new Vec3(-174.0, 47, 109.0));
    bot.heldItem = cobble;
    await assert.rejects(() => bot.placeBlock({ position: new Vec3(-174, 46, 109) }, new Vec3(0, 1, 0)), /hitbox/);
    await assert.rejects(() => bot.placeBlock({ position: new Vec3(-176, 47, 109) }, new Vec3(1, 0, 0)), /hitbox/); // dest cell (-175,47,109)
    await bot.placeBlock({ position: new Vec3(-177, 47, 109) }, new Vec3(1, 0, 0)); // dest -176: outside
    assert.equal(bot.calls.length, 1);
});

test('non-colliding blocks pass through (torch in own cell is legal)', async () => {
    const bot = makeBot(new Vec3(-174.5, 47, 109.5));
    bot.heldItem = torch;
    const res = await bot.placeBlock({ position: new Vec3(-174, 46, 109) }, new Vec3(0, 1, 0));
    assert.equal(res, 'placed');
    assert.equal(bot.calls.length, 1);
});

test('free destination cell passes through', async () => {
    const bot = makeBot(new Vec3(-174.5, 47, 109.5));
    bot.heldItem = cobble;
    const res = await bot.placeBlock({ position: new Vec3(-178, 46, 109) }, new Vec3(0, 1, 0));
    assert.equal(res, 'placed');
});

test('empty hand passes through (mineflayer reports its own error)', async () => {
    const bot = makeBot(new Vec3(-174.5, 47, 109.5));
    bot.heldItem = null;
    const res = await bot.placeBlock({ position: new Vec3(-174, 46, 109) }, new Vec3(0, 1, 0));
    assert.equal(res, 'placed');
});

test('install is idempotent', () => {
    const bot = makeBot(new Vec3(0, 64, 0));
    const wrapped = bot.placeBlock;
    installPlaceOccupancyGuard(bot);
    assert.equal(bot.placeBlock, wrapped);
});
