/**
 * fix112: blockUpdate reindexes once per dirty section per turn, not 7x per event.
 * mineflayer fires one blockUpdate per block received (blocks.js updateBlockState -> prismarine-world
 * worldsync.js setBlockStateId -> _emitBlockUpdate); the old per-event handler reindexed up to 7 full
 * 16^3 sections synchronously, so a chunk stream blocked the main thread past the 30 s keep-alive
 * watchdog (kills 2026-11-15T10:31:10Z and 11:48:59Z). Fails on main before fix112: the burst does
 * sectionsBuilt >= 7 per event synchronously.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as world from '../src/agent/library/world.js';
import { buildServerTerrain, serverHeight } from './server_terrain.js';

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

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('fix112 blockUpdate batching', () => {
    it('a burst does not reindex per event; one flush covers the touched sections', async () => {
        const R = 1;
        const w = await buildServerTerrain(registry, R, { plants: false });
        const bot = makeBot(w, R, 8.5, 8.5);
        await world.indexPerceivedChunks(bot);
        const before = world.perceivedBuildStats(bot).sectionsBuilt;

        // 30 block updates inside one column section — each emits blockUpdate synchronously.
        const y0 = serverHeight(2, 2) + 1;
        for (let i = 0; i < 30; i++) {
            w.setBlockStateId(new Vec3(2 + (i % 2), y0, 2 + Math.floor(i / 2)), spongeId);
        }
        const during = world.perceivedBuildStats(bot).sectionsBuilt;
        assert.strictEqual(during, before, 'the event handler must not reindex synchronously per event');

        await tick();
        const after = world.perceivedBuildStats(bot).sectionsBuilt;
        // Pre-fix: 30 events x up to 7 sections = >= 30 rebuilds. Post-fix: the unique sections the
        // burst touches (its own section plus face neighbours) — a small number.
        assert.ok(after > before, 'the scheduled flush must rebuild the touched sections');
        assert.ok(after - before <= 7, `one flush must stay within the touched sections; rebuilt ${after - before}`);
    });

    it('a query flushes dirty sections itself: no await needed to see the last block', async () => {
        const R = 1;
        const w = await buildServerTerrain(registry, R, { plants: false });
        const bot = makeBot(w, R, 8.5, 8.5);
        await world.indexPerceivedChunks(bot);
        const x = 3, z = 4;
        const y = serverHeight(x, z) + 1;
        w.setBlockStateId(new Vec3(x, y, z), spongeId);
        bot.entity.position = new Vec3(x + 1.5, y, z + 0.5);
        const seen = world.getNearbyBlocks(bot);
        const hit = seen.find((b) => b.name === 'sponge' && b.x === x && b.y === y && b.z === z);
        assert.ok(hit, 'the scan must see the block placed this same turn (query-side flush)');
    });

    it('positions that arrive during a flush are taken by the next flush', async () => {
        const R = 1;
        const w = await buildServerTerrain(registry, R, { plants: false });
        const bot = makeBot(w, R, 8.5, 8.5);
        await world.indexPerceivedChunks(bot);
        const x1 = 3, z1 = 4, x2 = 5, z2 = 6;
        const y = serverHeight(x1, z1) + 1;
        const before = world.perceivedBuildStats(bot).sectionsBuilt;
        w.setBlockStateId(new Vec3(x1, y, z1), spongeId);
        w.setBlockStateId(new Vec3(x2, y, z2), spongeId);
        await tick();
        const afterFirst = world.perceivedBuildStats(bot).sectionsBuilt;
        assert.ok(afterFirst > before, 'the scheduled flush must consume both positions in one pass');
        // A block marked after the flush must still reach the index: the listener schedules the next flush.
        const x3 = 7, z3 = 7;
        const y3 = serverHeight(x3, z3) + 1;
        w.setBlockStateId(new Vec3(x3, y3, z3), spongeId);
        await tick();
        const afterSecond = world.perceivedBuildStats(bot).sectionsBuilt;
        assert.ok(afterSecond >= afterFirst, 'a later mark must not break the flush cycle');
        bot.entity.position = new Vec3(x3 + 1.5, y3, z3 + 0.5);
        const seen = world.getNearbyBlocks(bot);
        assert.ok(seen.find((b) => b.name === 'sponge' && b.x === x3 && b.y === y3 && b.z === z3),
            'the sponge marked after the first flush must be indexed by the next one');
    });

    it('a blockUpdate in a not-yet-indexed column keeps the fix103 pending invariant', async () => {
        const R = 1;
        const w = await buildServerTerrain(registry, R, { plants: false });
        const bot = makeBot(w, R, 8.5, 8.5);
        await world.indexPerceivedChunks(bot);
        const { makeServerChunk } = await import('./server_terrain.js');
        for (let cz = -R; cz <= R; cz++) w.setColumn(R + 1, cz, makeServerChunk(registry, R + 1, cz));
        bot.entity.position = new Vec3(16 + 8.5, serverHeight(24, 8) + 1, 8.5);
        const x = (R + 1) * 16 + 3, z = 3;
        const y = serverHeight(x, z) + 1;
        w.setBlockStateId(new Vec3(x, y, z), spongeId);
        const rows = world.perceivedViewColumns(bot);
        for (const row of rows) {
            assert.ok(row.indexed || row.pending, `chunk ${row.cx},${row.cz} neither indexed nor pending`);
        }
        await world.indexPerceivedChunks(bot);
        const seen = world.getNearbyBlocks(bot);
        assert.ok(seen.find((b) => b.name === 'sponge' && b.x === x && b.y === y && b.z === z));
    });
});
