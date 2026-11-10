import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// The reviewer's layered column: bedrock, deepslate, stone, dirt, grass, scattered ores,
// a cave, and an oak. Seed and the ore list are the ones in reviewer_perf so a fixture
// and that script build the same chunks.
const ORE_NAMES = ['coal_ore', 'iron_ore', 'copper_ore', 'granite', 'diorite', 'andesite', 'gravel', 'dirt', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'deepslate_iron_ore', 'tuff'];

export async function buildLayeredWorld(registry, viewDistance, ores = true) {
    const Chunk = require('prismarine-chunk')(registry);
    const World = require('prismarine-world')(registry);
    const { Vec3 } = require('vec3');
    const world = new World(null, null, 0);
    const S = (name) => registry.blocksByName[name].defaultState;
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let cx = -viewDistance; cx <= viewDistance; cx++) {
        for (let cz = -viewDistance; cz <= viewDistance; cz++) {
            const column = new Chunk({ minY: -64, worldHeight: 384 });
            for (let x = 0; x < 16; x++) {
                for (let z = 0; z < 16; z++) {
                    column.setBlockStateId(new Vec3(x, -64, z), S('bedrock'));
                    for (let y = -63; y < 0; y++) column.setBlockStateId(new Vec3(x, y, z), S('deepslate'));
                    for (let y = 0; y < 59; y++) column.setBlockStateId(new Vec3(x, y, z), S('stone'));
                    for (let y = 59; y < 63; y++) column.setBlockStateId(new Vec3(x, y, z), S('dirt'));
                    column.setBlockStateId(new Vec3(x, 63, z), S('grass_block'));
                }
            }
            if (ores) {
                for (let k = 0; k < 120; k++) {
                    const y = Math.floor(rnd() * 120) - 63;
                    column.setBlockStateId(new Vec3(Math.floor(rnd() * 16), y, Math.floor(rnd() * 16)), S(ORE_NAMES[Math.floor(rnd() * ORE_NAMES.length)]));
                }
                for (let x = 4; x < 8; x++) for (let z = 4; z < 8; z++) for (let y = 20; y < 23; y++) column.setBlockStateId(new Vec3(x, y, z), 0);
            }
            for (let y = 64; y < 69; y++) column.setBlockStateId(new Vec3(8, y, 8), S('oak_log'));
            for (let x = 6; x < 11; x++) for (let z = 6; z < 11; z++) column.setBlockStateId(new Vec3(x, 69, z), S('oak_leaves'));
            await world.setColumn(cx, cz, column);
        }
    }
    return world.sync;
}
