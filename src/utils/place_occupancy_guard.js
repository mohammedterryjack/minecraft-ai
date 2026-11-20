// fix149: enforce "a placement destination inside the bot's own hitbox is rejected HERE, with a
// reason" at mineflayer's placement entry point, for every caller.
//
// Root cause (live 20 Nov 2026, 43x): learned placeBlock.js/placeCobblestoneAtBot call
// bot.placeBlock(buildOff, faceVec) with dest = the bot's own feet cell (-174, 47, 109). The
// server rejects placing a colliding block into a cell an entity intersects (it answers the
// block_place packet with no change; https://minecraft.wiki/w/Place), so the only signal is
// mineflayer's timeout-style "Server refused to place cobblestone at (-174, 47, 109): the block
// is still air" — no actionable cause, and PSN keeps re-repairing the learned callee in a loop.
// fix134 established this invariant (world.js occupiedCells / cellOccupiedByBot) but only inside
// library.skills.placeBlock and getAllFreeSpaces; the mineflayer entry stayed open, and the
// learned/repaired skills call it directly. The guard makes the invariant hold at the one
// chokepoint all placement code passes: bot.placeBlock and bot._placeBlockWithOptions
// (mineflayer lib/plugins/place_block.js assigns both).
//
// Exact game rule: only blocks with a colliding bounding box are refused. Registry
// blocksByName[name].boundingBox is 'block' for cubes (cobblestone, chest, slab) and 'empty' for
// non-colliding states (torch, short_grass, stone_pressure_plate) — verified against the bot's
// own 26.1 registry; those may legally occupy a cell with an entity in it (minecraft.wiki/w/Torch:
// "torches can be placed ... while entities are inside"). So this refuses exactly what the server
// would refuse, nothing more.
//
// Occupancy AABB (same math as world.js occupiedCells, restated here to keep utils free of a
// library import — library/world.js imports utils/mcdata.js and importing back would cycle):
// the entity box is [x-w/2, x+w/2] x [y, y+h] x [z-w/2, z+w/2] (mineflayer entity.width/.height,
// player 0.6 x 1.8 https://minecraft.wiki/w/Player#Dimensions); a cell is occupied when the boxes
// intersect on all three axes.
export function installPlaceOccupancyGuard(bot) {
    if (bot.__placeOccupancyGuardInstalled) return;
    if (typeof bot.placeBlock !== 'function' || typeof bot._placeBlockWithOptions !== 'function') {
        throw new Error('[fix149] bot.placeBlock / bot._placeBlockWithOptions not callable at install time');
    }
    const refused = (referenceBlock, faceVector) => {
        // dest exactly as mineflayer computes it: lib/plugins/place_block.js placeBlockWithOptions
        const dest = referenceBlock.position.plus(faceVector);
        const held = bot.heldItem;
        if (!held) return;
        const blockDef = bot.registry.blocksByName[held.name];
        if (!blockDef || blockDef.boundingBox === 'empty') return; // non-colliding: server allows it
        const p = bot.entity.position;
        const hw = bot.entity.width / 2;
        const hit =
            dest.x < p.x + hw && dest.x + 1 > p.x - hw &&
            dest.y < p.y + bot.entity.height && dest.y + 1 > p.y &&
            dest.z < p.z + hw && dest.z + 1 > p.z - hw;
        if (hit) {
            throw new Error(`cannot place ${held.name} at ${dest}: that cell is inside the bot's own hitbox, so the server would refuse it. Move out of the target cell first, or place against a block whose destination face is outside the bot.`);
        }
    };
    const origPlace = bot.placeBlock;
    bot.placeBlock = async function (referenceBlock, faceVector) {
        refused(referenceBlock, faceVector);
        return origPlace.call(this, referenceBlock, faceVector);
    };
    const origOpts = bot._placeBlockWithOptions;
    bot._placeBlockWithOptions = async function (referenceBlock, faceVector, options) {
        refused(referenceBlock, faceVector);
        return origOpts.call(this, referenceBlock, faceVector, options);
    };
    bot.__placeOccupancyGuardInstalled = true;
}
