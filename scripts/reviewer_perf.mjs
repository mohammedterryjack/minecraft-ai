import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as world from '../src/agent/library/world.js';
import { buildLayeredWorld } from '../test/layered_terrain.js';
const reg = require('minecraft-data')('1.20.4');
const { Vec3 } = require('vec3');
const V = Number(process.argv[2] || 10), ORES = process.argv[3] !== 'flat';
const t0 = Date.now();
const sync = await buildLayeredWorld(reg, V, ORES);
console.log('built', Date.now() - t0, 'ms');
const bot = { world: sync, registry: reg, entity: { position: new Vec3(3.5, 64, 3.5), eyeHeight: 1.62 }, game: { serverViewDistance: V, gameMode: 'survival' } };
if (typeof bot.world.getColumns !== 'function') { console.log('sync world has no getColumns'); process.exit(1); }
const indexed = await world.indexPerceivedChunks(bot);
const perChunk = indexed.chunks ? indexed.ms / indexed.chunks : 0;
const maxChunk = indexed.perChunkMs.reduce((m, t) => t > m ? t : m, 0);
console.log(`index ${indexed.chunks} chunks, ${indexed.ms.toFixed(1)} ms total, ${perChunk.toFixed(2)} ms/chunk, max ${maxChunk.toFixed(2)} ms, cell reads ${indexed.cellReads}, sections ${indexed.sectionsBuilt}`);
const heapAtRest = process.memoryUsage().heapUsed;
for (let r = 0; r < 3; r++) {
    if (typeof global.gc === 'function') global.gc();
    const h0 = process.memoryUsage().heapUsed;
    const t = process.hrtime.bigint();
    const names = world.getNearbyBlockTypes(bot);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const h1 = process.memoryUsage().heapUsed;
    if (typeof global.gc === 'function') global.gc();
    const retained = process.memoryUsage().heapUsed - h0;
    console.log(`run ${r}: ${ms.toFixed(1)} ms, heap +${((h1 - h0) / 1e6).toFixed(1)} MB, retained after gc ${((retained) / 1e6).toFixed(1)} MB`, JSON.stringify(world.perceivedStats(bot)), names.join(','));
}
console.log(`heap at rest ${(heapAtRest / 1e6).toFixed(1)} MB`);
