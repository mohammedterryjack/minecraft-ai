import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Server's review terrain (water, short grass, poppy, a ravine, a buried block, an enclosed cave).
// Height and the ore list are the review fixture. plants and dry are that fixture's environment switches.
const ORES = ['coal_ore', 'iron_ore', 'copper_ore', 'granite', 'diorite', 'andesite', 'gravel', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'deepslate_iron_ore', 'tuff', 'deepslate_diamond_ore'];

export function serverHeight(x, z, dry = false) {
    return (dry ? 70 : 64) + Math.round(4 * Math.sin(x / 11) + 3 * Math.cos(z / 13));
}

function hseed(cx, cz) {
    let s = ((cx * 73856093) ^ (cz * 19349663)) >>> 0;
    s = s % 2147483646 + 1;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function makeServerChunk(registry, cx, cz, { plants = false, dry = false } = {}) {
    const Chunk = require('prismarine-chunk')(registry);
    const { Vec3 } = require('vec3');
    const S = (name) => registry.blocksByName[name].defaultState;
    const column = new Chunk({ minY: -64, worldHeight: 384 });
    const rnd = hseed(cx, cz);
    for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
            const wx = cx * 16 + x, wz = cz * 16 + z, h = serverHeight(wx, wz, dry);
            column.setBlockStateId(new Vec3(x, -64, z), S('bedrock'));
            for (let y = -63; y < 0; y++) column.setBlockStateId(new Vec3(x, y, z), S('deepslate'));
            for (let y = 0; y < h - 4; y++) column.setBlockStateId(new Vec3(x, y, z), S('stone'));
            for (let y = h - 4; y < h; y++) column.setBlockStateId(new Vec3(x, y, z), S('dirt'));
            column.setBlockStateId(new Vec3(x, h, z), S('grass_block'));
            if (h < 61) for (let y = h + 1; y <= 61; y++) column.setBlockStateId(new Vec3(x, y, z), S('water'));
        }
    }
    for (let k = 0; k < 150; k++) {
        const y = Math.floor(rnd() * 120) - 63;
        column.setBlockStateId(new Vec3(Math.floor(rnd() * 16), y, Math.floor(rnd() * 16)), S(ORES[Math.floor(rnd() * ORES.length)]));
    }
    const cy = 10 + Math.floor(rnd() * 30);
    for (let x = 3; x < 10; x++) for (let z = 3; z < 10; z++) for (let y = cy; y < cy + 4; y++) column.setBlockStateId(new Vec3(x, y, z), 0);
    column.setBlockStateId(new Vec3(3, cy, 3), S('emerald_ore'));
    const th = serverHeight(cx * 16 + 12, cz * 16 + 12, dry);
    if (th >= 62) {
        for (let y = th + 1; y < th + 6; y++) column.setBlockStateId(new Vec3(12, y, 12), S('oak_log'));
        for (let x = 10; x < 15; x++) for (let z = 10; z < 15; z++) column.setBlockStateId(new Vec3(x, th + 6, z), S('oak_leaves'));
    }
    if (plants) {
        for (let k = 0; k < 20; k++) {
            const x = Math.floor(rnd() * 16), z = Math.floor(rnd() * 16);
            const hh = serverHeight(cx * 16 + x, cz * 16 + z, dry);
            if (column.getBlockStateId(new Vec3(x, hh + 1, z)) === 0) column.setBlockStateId(new Vec3(x, hh + 1, z), S(k % 2 ? 'short_grass' : 'poppy'));
        }
    }
    return column;
}

export async function buildServerTerrain(registry, viewDistance, { plants = false, dry = false } = {}) {
    const World = require('prismarine-world')(registry);
    const { Vec3 } = require('vec3');
    const world = new World(null, null, 0);
    const S = (name) => registry.blocksByName[name].defaultState;
    for (let cx = -viewDistance; cx <= viewDistance; cx++) {
        for (let cz = -viewDistance; cz <= viewDistance; cz++) {
            await world.setColumn(cx, cz, makeServerChunk(registry, cx, cz, { plants, dry }));
        }
    }
    const sync = world.sync;
    for (let x = 20; x < 23; x++) for (let z = 0; z < 16; z++) for (let y = 40; y < 75; y++) sync.setBlockStateId(new Vec3(x, y, z), 0);
    sync.setBlockStateId(new Vec3(23, 45, 8), S('raw_iron_block'));
    sync.setBlockStateId(new Vec3(-40, 20, -40), S('copper_block'));
    return sync;
}
