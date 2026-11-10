/**
 * fix103: a loaded column that enters the view without a chunkColumnLoad must be pending before
 * reindexSectionAt. Fails on e68e668: the block update throws
 * "chunk X,Z is loaded in the view and is neither indexed nor pending".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as world from '../src/agent/library/world.js';
import { buildServerTerrain, makeServerChunk, serverHeight } from './server_terrain.js';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.20.4');
const spongeId = registry.blocksByName.sponge.defaultState;

function makeBot(w, radius, x, z) {
    return {
        game: { serverViewDistance: radius, gameMode: 'survival' },
        registry,
        entity: { position: new Vec3(x, serverHeight(Math.floor(x), Math.floor(z)) + 1, z), eyeHeight: 1.62 },
        world: w,
    };
}

function covered(bot) {
    // e68e668 has no inspector. The block update throws the invariant there before columnRow runs.
    if (typeof world.perceivedViewColumns !== 'function') return null;
    const rows = world.perceivedViewColumns(bot);
    for (const row of rows) {
        assert.ok(row.indexed || row.pending, `chunk ${row.cx},${row.cz} is loaded in the view and is neither indexed nor pending`);
    }
    return rows;
}

function columnRow(bot, cx, cz) {
    const row = covered(bot).find((r) => r.cx === cx && r.cz === cz);
    assert.ok(row, `chunk ${cx},${cz} is not a loaded in-view column`);
    return row;
}

function assertSponge(bot, x, y, z) {
    bot.entity.position = new Vec3(x + 1.5, y, z + 0.5);
    const seen = world.getNearbyBlocks(bot);
    const hit = seen.find((b) => b.name === 'sponge' && b.x === x && b.y === y && b.z === z);
    assert.ok(hit, `updated sponge at ${x},${y},${z} is absent from the index; saw ${seen.filter((b) => b.name === 'sponge').map((b) => `${b.x},${b.y},${b.z}`).join(' ') || 'no sponge'}`);
}

describe('fix103 view transition', () => {
    it('A: a ring loaded outside the square is indexed when the bot steps into it', async () => {
        const R = 1;
        const w = await buildServerTerrain(registry, R, { plants: false });
        const bot = makeBot(w, R, 8.5, 8.5);
        await world.indexPerceivedChunks(bot);
        covered(bot);
        for (let cz = -R; cz <= R; cz++) w.setColumn(R + 1, cz, makeServerChunk(registry, R + 1, cz));
        covered(bot);
        bot.entity.position = new Vec3(16 + 8.5, serverHeight(24, 8) + 1, 8.5);
        const x = (R + 1) * 16 + 3;
        const z = 3;
        const y = serverHeight(x, z) + 1;
        w.setBlockStateId(new Vec3(x, y, z), spongeId);
        const mid = columnRow(bot, R + 1, 0);
        assert.strictEqual(mid.pending, true);
        assert.strictEqual(mid.indexed, false);
        covered(bot);
        await world.indexPerceivedChunks(bot);
        const done = columnRow(bot, R + 1, 0);
        assert.strictEqual(done.indexed, true);
        assert.strictEqual(done.pending, false);
        covered(bot);
        assertSponge(bot, x, y, z);
    });

    it('B: a column dropped by a scan and still loaded is indexed when the bot walks back', async () => {
        const R = 1;
        const w = await buildServerTerrain(registry, R, { plants: false });
        const bot = makeBot(w, R, 8.5, 8.5);
        await world.indexPerceivedChunks(bot);
        covered(bot);
        for (let cz = -R; cz <= R; cz++) w.setColumn(R + 1, cz, makeServerChunk(registry, R + 1, cz));
        covered(bot);
        bot.entity.position = new Vec3(16 + 8.5, serverHeight(24, 8) + 1, 8.5);
        await world.indexPerceivedChunks(bot);
        covered(bot);
        bot.entity.position = new Vec3(8.5, serverHeight(8, 8) + 1, 8.5);
        const x = -16 + 3;
        const z = 3;
        const y = serverHeight(x, z) + 1;
        w.setBlockStateId(new Vec3(x, y, z), spongeId);
        const mid = columnRow(bot, -1, 0);
        assert.strictEqual(mid.pending, true);
        assert.strictEqual(mid.indexed, false);
        covered(bot);
        await world.indexPerceivedChunks(bot);
        const done = columnRow(bot, -1, 0);
        assert.strictEqual(done.indexed, true);
        assert.strictEqual(done.pending, false);
        covered(bot);
        assertSponge(bot, x, y, z);
    });

    it('a radius growing from 1 to 2 indexes the ring that was already loaded', async () => {
        const R = 1;
        const w = await buildServerTerrain(registry, R, { plants: false });
        const bot = makeBot(w, R, 8.5, 8.5);
        await world.indexPerceivedChunks(bot);
        covered(bot);
        for (let cx = -(R + 1); cx <= R + 1; cx++) {
            for (let cz = -(R + 1); cz <= R + 1; cz++) {
                if (Math.abs(cx) <= R && Math.abs(cz) <= R) continue;
                w.setColumn(cx, cz, makeServerChunk(registry, cx, cz));
            }
        }
        covered(bot);
        bot.game.serverViewDistance = R + 1;
        const x = (R + 1) * 16 + 8;
        const z = 8;
        const y = serverHeight(x, z) + 1;
        const chunksBefore = world.perceivedBuildStats(bot).chunks;
        w.setBlockStateId(new Vec3(x, y, z), spongeId);
        const mid = columnRow(bot, R + 1, 0);
        assert.strictEqual(mid.pending, true);
        assert.strictEqual(mid.indexed, false);
        assert.strictEqual(world.perceivedBuildStats(bot).chunks, chunksBefore);
        covered(bot);
        await world.indexPerceivedChunks(bot);
        const done = columnRow(bot, R + 1, 0);
        assert.strictEqual(done.indexed, true);
        assert.strictEqual(done.pending, false);
        covered(bot);
        assertSponge(bot, x, y, z);
    });
});
