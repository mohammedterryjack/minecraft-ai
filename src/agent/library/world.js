import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { createRequire } from 'module';
import * as mc from '../../utils/mcdata.js';
import { carriedSlots } from '../../utils/carried.js';
import { itemSourceBlocks } from '../../utils/item_sources.js';

const require = createRequire(import.meta.url);
// A chunk is 16 blocks on a side (prismarine-chunk; https://minecraft.wiki/w/Chunk).
const { CHUNK_WIDTH, BLOCK_SECTION_VOLUME, SECTION_WIDTH, SECTION_HEIGHT } = require('prismarine-chunk/src/pc/common/constants.js');


// fix42: getAllFreeSpaces returns all valid positions (for retry logic when placeBlock fails at one cell)
export function getAllFreeSpaces(bot, size=1, distance=8, maxCount=10) {
    /**
     * Get all empty spaces with solid blocks beneath them of the given size, sorted by distance.
     * @param {Bot} bot - The bot to get the free spaces for.
     * @param {number} size - The (size x size) of the space to find, default 1.
     * @param {number} distance - The maximum distance to search, default 8.
     * @param {number} maxCount - Maximum number of positions to return, default 10.
     * @returns {Vec3[]} - Array of positions, closest first.
     **/
    let empty_pos = bot.findBlocks({
        matching: (block) => block && block.name === 'air',
        maxDistance: distance,
        count: 1000
    });
    const results = [];
    for (let i = 0; i < empty_pos.length && results.length < maxCount; i++) {
        let empty = true;
        for (let x = 0; x < size; x++) {
            for (let z = 0; z < size; z++) {
                let top = bot.blockAt(empty_pos[i].offset(x, 0, z));
                let bottom = bot.blockAt(empty_pos[i].offset(x, -1, z));
                if (!top || top.name !== 'air' || !bottom || bottom.drops.length === 0 || !bottom.diggable) {
                    empty = false;
                    break;
                }
            }
            if (!empty) break;
        }
        if (empty) results.push(empty_pos[i]);
    }
    return results;
}

export function getNearestFreeSpace(bot, size=1, distance=8) {
    /**
     * Get the nearest empty space with solid blocks beneath it of the given size.
     * @param {Bot} bot - The bot to get the nearest free space for.
     * @param {number} size - The (size x size) of the space to find, default 1.
     * @param {number} distance - The maximum distance to search, default 8.
     * @returns {Vec3} - The south west corner position of the nearest free space.
     * @example
     * let position = world.getNearestFreeSpace(bot, 1, 8);
     **/
    const spaces = getAllFreeSpaces(bot, size, distance, 1);
    return spaces.length ? spaces[0] : undefined;
}


/**
 * fix65: label for a block whose chunk the client has not loaded. Not a block name: the block there is UNKNOWN, not air.
 * Callers that report surroundings print it; callers that act on a block must check for null themselves.
 */
export const UNLOADED = 'unloaded (unknown, not air)';

// fix67: two lookups, each saying which frame its argument is in, so nothing is inferred. fix65's getBlockAtPosition took
// three numbers that could be read either way and guessed "absolute" when they lay nearer the bot than the origin; a real
// far offset or an absolute position near the world origin was then read in the wrong frame.
function _requireVec3(fn, arg, what, args) {
    if (args.length !== 2 || !(arg instanceof Vec3)) {
        throw new Error(`${fn}(bot, ${what}) takes exactly one Vec3 after bot, e.g. ${fn}(bot, new Vec3(0, -1, 0)); got ${args.length - 1} argument(s): ${[...args].slice(1).map(a => JSON.stringify(a)).join(', ')}`);
    }
}

export function getBlockAtOffset(bot, offset) {
    /**
     * Get the block at an offset RELATIVE to the bot's feet.
     * @param {Bot} bot - The bot to get the block for.
     * @param {Vec3} offset - The offset from the bot's feet, e.g. new Vec3(0, -1, 0) for the block below.
     * @returns {Block|null} - The block, or null when its chunk is not loaded (unknown: NOT air).
     * @example
     * let blockBelow = getBlockAtOffset(bot, new Vec3(0, -1, 0));
     * let blockAbove = getBlockAtOffset(bot, new Vec3(0, 2, 0)); since minecraft position is at the feet
     **/
    _requireVec3('getBlockAtOffset', offset, 'offset', arguments);
    return bot.blockAt(bot.entity.position.plus(offset));
}

export function getBlockAtAbsolute(bot, position) {
    /**
     * Get the block at an ABSOLUTE world position.
     * @param {Bot} bot - The bot to get the block for.
     * @param {Vec3} position - The world position, e.g. new Vec3(-124, 33, 57) or block.position.
     * @returns {Block|null} - The block, or null when its chunk is not loaded (unknown: NOT air).
     * @example
     * let ore = getBlockAtAbsolute(bot, new Vec3(-124, 33, 57));
     **/
    _requireVec3('getBlockAtAbsolute', position, 'position', arguments);
    return bot.blockAt(position);
}

/** fix65: name of the block at a relative offset for reports, or UNLOADED; never a guessed name. */
function _reportBlockAt(bot, offset) {
    const b = getBlockAtOffset(bot, offset);
    return b ? b.name : UNLOADED;
}

export function getSurroundingBlocks(bot) {
    /**
     * Get the surrounding blocks from the bot's environment.
     * @param {Bot} bot - The bot to get the block for.
     * @returns {string[]} - A list of block results as strings (UNLOADED where the chunk is not loaded).
     * @example
     **/
    // Create a list of block position results that can be unpacked.
    let res = [];
    res.push(`Block Below: ${_reportBlockAt(bot, new Vec3(0, -1, 0))}`);
    res.push(`Block at Legs: ${_reportBlockAt(bot, new Vec3(0, 0, 0))}`);
    res.push(`Block at Head: ${_reportBlockAt(bot, new Vec3(0, 1, 0))}`);

    return res;
}

/** fix65: exported for full_state.js, which reports the same three cells */
export function reportBlockAtOffset(bot, offset) {
    return _reportBlockAt(bot, offset);
}


export function getFirstBlockAboveHead(bot, ignore_types=null, distance=32) {
     /**
     * Searches a column from the bot's position for the first solid block above its head
     * @param {Bot} bot - The bot to get the block for.
     * @param {string[]} ignore_types - The names of the blocks to ignore.
     * @param {number} distance - The maximum distance to search, default 32.
     * @returns {string} - The first block above head, 'none', or UNLOADED with its height when the column is not loaded there.
     * @example
     * let firstBlockAboveHead = world.getFirstBlockAboveHead(bot, null, 32);
     **/
    // if ignore_types is not a list, make it a list.
    let ignore_blocks = []; 
    if (ignore_types === null) ignore_blocks = ['air', 'cave_air'];
    else {
        if (!Array.isArray(ignore_types))
            ignore_types = [ignore_types];
        for(let ignore_type of ignore_types) {
            if (mc.getBlockId(ignore_type)) ignore_blocks.push(ignore_type);
        }
    }
    // The block above, stops when it finds a solid block (fix65: or at the first unloaded cell, which is unknown, not air)
    for (let i = 0; i < distance; i++) {
        const block = bot.blockAt(bot.entity.position.offset(0, i+2, 0));
        if (!block) return `${UNLOADED} (${i} blocks up)`;
        if (ignore_blocks.includes(block.name)) continue;
        return `${block.name} (${i} blocks up)`;
    }
    return 'none';
}


// fix97: the coder saw `getNearestBlocks(bot, block_types=null, distance=8, count=10000)` and mineIronOres called
// getNearestBlocks(bot, null, ['iron_ore', 'deepslate_iron_ore']). null selects every block id (1057 in 1.20.4) and the
// name list became maxDistance. describeApiArg prints array lengths, so the watchdog recorded
// findBlocks({matching:[1057], maxDistance:[2], count:10000}). count 10000 was this default, not mineflayer's.
function shownScanArg(v) {
    if (v === undefined) return 'undefined';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}
function requireScanNumber(fn, name, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        const hint = 'distance and count are numbers. Block names go in block_types (getNearestBlocks) or the predicate (getNearestBlocksWhere), not in the distance. bot.findBlocks({ matching, maxDistance, count }): matching is a block id, an array of block ids, or a function; maxDistance and count are finite numbers.';
        throw new Error(`${fn}: ${name} must be a finite number, got ${shownScanArg(value)}. ${hint}`);
    }
}

export function getNearestBlocks(bot, block_types, distance, count) {
    /**
     * Get a list of the nearest blocks of the given types.
     * @param {Bot} bot - The bot to get the nearest block for.
     * @param {string|string[]|null} block_types - Block names. null lists every block id. Not the distance.
     * @param {number} distance - Maximum distance in blocks. A finite number, required.
     * @param {number} count - Maximum number of blocks to return. A finite number, required.
     * @returns {Block[]} - The nearest blocks of the given type.
     * @example
     * let woodBlocks = world.getNearestBlocks(bot, ['oak_log', 'birch_log'], 16, 1);
     **/
    requireScanNumber('getNearestBlocks', 'distance', distance);
    requireScanNumber('getNearestBlocks', 'count', count);
    // if blocktypes is not a list, make it a list
    let block_ids = [];
    if (block_types === null) {
        block_ids = mc.getAllBlockIds(['air']);
    }
    else {
        if (!Array.isArray(block_types))
            block_types = [block_types];
        for(let block_type of block_types) {
            // fix95: a name that is not a block (an item such as wheat_seeds) matched nothing, so the search returned
            //        nothing without any I/O and code that retried it spun the event loop until the watchdog killed the
            //        process. It is a wrong question, not an empty world: fail loudly and name the blocks that yield it.
            if (typeof block_type !== 'string' || block_type.length === 0) throw new Error(`getNearestBlocks: a block name is a non-empty string, got ${typeof block_type === 'function' ? 'a function (use getNearestBlocksWhere for a predicate)' : JSON.stringify(block_type)}`);
            const id = mc.getBlockId(block_type);
            if (id === null) {
                const sources = itemSourceBlocks(bot.registry, block_type);
                throw new Error(`getNearestBlocks: ${JSON.stringify(block_type)} is not a block in the game data; ` +
                    (sources.length ? `the blocks that drop it are ${sources.join(', ')}; search for those` : 'no block drops it; obtain it another way (craft, smelt, or a mob drop)'));
            }
            block_ids.push(id);
        }
    }
    return getNearestBlocksWhere(bot, block_ids, distance, count);  
}

export function getNearestBlocksWhere(bot, predicate, distance, count) {
    /**
     * Get a list of the nearest blocks that satisfy the given predicate.
     * @param {Bot} bot - The bot to get the nearest blocks for.
     * @param {function|number[]} predicate - A predicate, or block ids passed through as matching.
     * @param {number} distance - Maximum distance in blocks. A finite number, required.
     * @param {number} count - Maximum number of blocks to return. A finite number, required.
     * @returns {Block[]} - The nearest blocks that satisfy the given predicate.
     * @example
     * let waterBlocks = world.getNearestBlocksWhere(bot, block => block.name === 'water', 16, 10);
     **/
    requireScanNumber('getNearestBlocksWhere', 'distance', distance);
    requireScanNumber('getNearestBlocksWhere', 'count', count);
    let positions = bot.findBlocks({matching: predicate, maxDistance: distance, count: count});
    // fix51: filter out null blocks (chunk unloaded or invalid position)
    let blocks = positions.map(position => bot.blockAt(position)).filter(b => b !== null);
    return blocks;
}


export function getNearestBlock(bot, block_type, distance=16) {
     /**
     * Get the nearest block of the given type.
     * @param {Bot} bot - The bot to get the nearest block for.
     * @param {string} block_type - The name of the block to search for.
     * @param {number} distance - The maximum distance to search, default 16.
     * @returns {Block} - The nearest block of the given type.
     * @example
     * let coalBlock = world.getNearestBlock(bot, 'coal_ore', 16);
     **/
    let blocks = getNearestBlocks(bot, block_type, distance, 1);
    if (blocks.length > 0) {
        return blocks[0];
    }
    return null;
}


export function getNearbyEntities(bot, maxDistance=16) {
    let entities = [];
    for (const entity of Object.values(bot.entities)) {
        const distance = entity.position.distanceTo(bot.entity.position);
        if (distance > maxDistance) continue;
        entities.push({ entity: entity, distance: distance });
    }
    entities.sort((a, b) => a.distance - b.distance);
    let res = [];
    for (let i = 0; i < entities.length; i++) {
        res.push(entities[i].entity);
    }
    return res;
}

export function getNearestEntityWhere(bot, predicate, maxDistance=16) {
    return bot.nearestEntity(entity => predicate(entity) && bot.entity.position.distanceTo(entity.position) < maxDistance);
}


export function getNearbyPlayers(bot, maxDistance) {
    if (maxDistance == null) maxDistance = 16;
    let players = [];
    for (const entity of Object.values(bot.entities)) {
        const distance = entity.position.distanceTo(bot.entity.position);
        if (distance > maxDistance) continue;
        if (entity.type == 'player' && entity.username != bot.username) {
            players.push({ entity: entity, distance: distance });
        } 
    }
    players.sort((a, b) => a.distance - b.distance);
    let res = [];
    for (let i = 0; i < players.length; i++) {
        res.push(players[i].entity);
    }
    return res;
}

// Helper function to get villager profession from metadata
export function getVillagerProfession(entity) {
    // Villager profession mapping based on metadata
    const professions = {
        0: 'Unemployed',
        1: 'Armorer',
        2: 'Butcher', 
        3: 'Cartographer',
        4: 'Cleric',
        5: 'Farmer',
        6: 'Fisherman',
        7: 'Fletcher',
        8: 'Leatherworker',
        9: 'Librarian',
        10: 'Mason',
        11: 'Nitwit',
        12: 'Shepherd',
        13: 'Toolsmith',
        14: 'Weaponsmith'
    };
    
    if (entity.metadata && entity.metadata[18]) {
        // Check if metadata[18] is an object with villagerProfession property
        if (typeof entity.metadata[18] === 'object' && entity.metadata[18].villagerProfession !== undefined) {
            const professionId = entity.metadata[18].villagerProfession;
            const level = entity.metadata[18].level || 1;
            const professionName = professions[professionId] || 'Unknown';
            return `${professionName} L${level}`;
        }
        // Fallback for direct profession ID
        else if (typeof entity.metadata[18] === 'number') {
            const professionId = entity.metadata[18];
            return professions[professionId] || 'Unknown';
        }
    }
    
    // If we can't determine profession but it's an adult villager
    if (entity.metadata && entity.metadata[16] !== 1) { // Not a baby
        return 'Adult';
    }
    
    return 'Unknown';
}


export function getInventoryCounts(bot) {
    /**
     * Get an object representing the bot's inventory.
     * @param {Bot} bot - The bot to get the inventory for.
     * @returns {object} - An object with item names as keys and counts as values.
     * @example
     * let inventory = world.getInventoryCounts(bot);
     * let oakLogCount = inventory['oak_log'];
     * let hasWoodenPickaxe = inventory['wooden_pickaxe'] > 0;
     **/
    let inventory = {};
    // skip slots 0-4 (crafting result + 2x2 grid): items there are not usable inventory and made failed crafts look successful
    // fix70: the carried slots are defined once (utils/carried.js) and shared with consume/equip
    for (const slot of carriedSlots(bot)) {
        if (slot != null && slot.name) {
            if (inventory[slot.name] == null) {
                inventory[slot.name] = 0;
            }
            inventory[slot.name] += slot.count;
        }
    }
    return inventory;
}

// fix84: how many more of itemName the stackable window can accept. Empty slots and partial stacks of that
// item count; both use the item's minecraft-data stackSize. Armour and off-hand are outside this window
// (inventoryStart..inventoryEnd, the same range emptySlotCount uses).
export function roomForItem(bot, itemName) {
    if (!bot || !bot.inventory || !Array.isArray(bot.inventory.slots)) throw new Error('[fix84] roomForItem: bot.inventory.slots required');
    const start = bot.inventory.inventoryStart, end = bot.inventory.inventoryEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) throw new Error(`[fix84] roomForItem: inventory window range required, got ${JSON.stringify(start)}..${JSON.stringify(end)}`);
    const reg = bot.registry;
    if (!reg || !reg.itemsByName) throw new Error('[fix84] roomForItem: bot.registry required');
    const it = reg.itemsByName[itemName];
    if (!it) throw new Error(`[fix84] roomForItem: ${JSON.stringify(itemName)} is not an item`);
    if (!Number.isInteger(it.stackSize) || it.stackSize < 1) throw new Error(`[fix84] roomForItem: ${itemName} has no stackSize in the game data`);
    let room = 0;
    for (let i = start; i < end; i++) {
        const s = bot.inventory.slots[i];
        if (s == null) { room += it.stackSize; continue; }
        if (s.name !== itemName) continue;
        if (!Number.isInteger(s.count)) throw new Error(`[fix84] roomForItem: slot ${i} count is not an integer`);
        if (s.count > it.stackSize) throw new Error(`[fix84] roomForItem: slot ${i} holds ${s.count} ${itemName}, above stackSize ${it.stackSize}`);
        if (s.count < it.stackSize) room += it.stackSize - s.count;
    }
    return room;
}


// fix86: the dependency walk of a craft (ingredients, and, when the caller says so, the tool a mined ingredient needs).
// A cycle throws by name. The live craftItem('torch') trial recursed torch -> coal -> a pickaxe -> … until
// RangeError: Maximum call stack size exceeded, because this walk had no path.
export function walkCraftNeeds(item, ingredientsOf, path = []) {
    if (typeof item !== 'string' || item === '') throw new Error('[fix86] walkCraftNeeds: item name required');
    if (typeof ingredientsOf !== 'function') throw new Error('[fix86] walkCraftNeeds: ingredientsOf(item) required');
    if (!Array.isArray(path)) throw new Error('[fix86] walkCraftNeeds: path must be the items already being expanded');
    if (path.includes(item)) throw new Error(`[fix86] recipe cycle: ${[...path, item].join(' -> ')}`);
    const ings = ingredientsOf(item);
    if (!Array.isArray(ings)) throw new Error(`[fix86] walkCraftNeeds: ingredients of ${item} are not a list`);
    const next = [...path, item];
    for (const ing of ings) {
        if (typeof ing !== 'string' || ing === '') throw new Error(`[fix86] walkCraftNeeds: ingredient of ${item} is not a name`);
        walkCraftNeeds(ing, ingredientsOf, next);
    }
    return next;
}

export function getCraftableItems(bot) {
    /**
     * Get a list of all items that can be crafted with the bot's current inventory.
     * @param {Bot} bot - The bot to get the craftable items for.
     * @returns {string[]} - A list of all items that can be crafted.
     * @example
     * let craftableItems = world.getCraftableItems(bot);
     **/
    let table = getNearestBlock(bot, 'crafting_table');
    if (!table) {
        for (const item of bot.inventory.items()) {
            if (item != null && item.name === 'crafting_table') {
                table = item;
                break;
            }
        }
    }
    let res = [];
    for (const item of mc.getAllItems()) {
        let recipes = bot.recipesFor(item.id, null, 1, table);
        if (recipes.length > 0)
            res.push(item.name);
    }
    return res;
}


export function getPosition(bot) {
    /**
     * Get your position in the world (Note that y is vertical).
     * @param {Bot} bot - The bot to get the position for.
     * @returns {Vec3} - An object with x, y, and x attributes representing the position of the bot.
     * @example
     * let position = world.getPosition(bot);
     * let x = position.x;
     **/
    return bot.entity.position;
}


export function getNearbyEntityTypes(bot) {
    /**
     * Get a list of all nearby mob types.
     * @param {Bot} bot - The bot to get nearby mobs for.
     * @returns {string[]} - A list of all nearby mobs.
     * @example
     * let mobs = world.getNearbyEntityTypes(bot);
     **/
    let mobs = getNearbyEntities(bot, 16);
    let found = [];
    for (let i = 0; i < mobs.length; i++) {
        if (!found.includes(mobs[i].name)) {
            found.push(mobs[i].name);
        }
    }
    return found;
}

export function isEntityType(name) {
    /**
     * Check if a given name is a valid entity type.
     * @param {string} name - The name of the entity type to check.
     * @returns {boolean} - True if the name is a valid entity type, false otherwise.
     */
    return mc.getEntityId(name) !== null;
}

export function getNearbyPlayerNames(bot) {
    /**
     * Get a list of all nearby player names.
     * @param {Bot} bot - The bot to get nearby players for.
     * @returns {string[]} - A list of all nearby players.
     * @example
     * let players = world.getNearbyPlayerNames(bot);
     **/
    let players = getNearbyPlayers(bot, 64);
    let found = [];
    for (let i = 0; i < players.length; i++) {
        if (!found.includes(players[i].username) && players[i].username != bot.username) {
            found.push(players[i].username);
        }
    }
    return found;
}


// The client only holds the chunks inside the server's view distance. Login (play) sends that radius as
// viewDistance, a varint after maxPlayers (minecraft-data pc/1.20.3 protocol.json packet_login; Minecraft 1.20.4
// uses protocol 1.20.3). Set Center Chunk (packet_update_view_position: chunkX, chunkZ) moves the center, and
// Update View Distance (packet_update_view_distance: viewDistance) replaces the radius.
// https://wiki.vg/Protocol#Login_.28play.29
// https://wiki.vg/Protocol#Set_Center_Chunk
// https://wiki.vg/Protocol#Update_View_Distance
// https://minecraft.wiki/w/Render_distance
// bot.settings.viewDistance is the client's request, not the radius the server granted.
// This radius is which chunks the server sends. It is not how far a block counts as nearby.
function serverChunkRadius(bot) {
    const game = bot && bot.game;
    if (!game || typeof game !== 'object') {
        throw new Error('nearbyBlockRadius: bot.game is missing. The server sends viewDistance in the login play packet (https://wiki.vg/Protocol#Login_.28play.29).');
    }
    const view = game.serverViewDistance;
    if (!Number.isInteger(view) || view <= 0) {
        throw new Error(`nearbyBlockRadius: server viewDistance is ${JSON.stringify(view)}. The client holds the chunks within the view distance from login (play) and update_view_distance (https://wiki.vg/Protocol#Update_View_Distance, https://minecraft.wiki/w/Render_distance). bot.settings.viewDistance is the client request, not the distance the server granted.`);
    }
    return view;
}

// Block radius of the chunks the server has granted. Not the nearby-block query.
export function nearbyBlockRadius(bot) {
    return serverChunkRadius(bot) * CHUNK_WIDTH;
}

// simulation-distance in server.properties, in blocks. Login (play) sends it as simulationDistance
// and packet simulation_distance replaces it. Entities are ticked inside this radius.
// https://minecraft.wiki/w/Simulation_distance
// https://wiki.vg/Protocol#Login_.28play.29
function serverSimulationChunks(bot) {
    const game = bot && bot.game;
    if (!game || typeof game !== 'object') {
        throw new Error('simulationBlockRadius: bot.game is missing. The server sends simulationDistance in the login play packet (https://wiki.vg/Protocol#Login_.28play.29).');
    }
    const sim = game.simulationDistance;
    if (!Number.isInteger(sim) || sim <= 0) {
        throw new Error(`simulationBlockRadius: server simulationDistance is ${JSON.stringify(sim)}. The client is told the simulation radius by login (play) and simulation_distance (https://wiki.vg/Protocol#Login_.28play.29, https://minecraft.wiki/w/Simulation_distance).`);
    }
    return sim;
}

export function simulationBlockRadius(bot) {
    return serverSimulationChunks(bot) * CHUNK_WIDTH;
}

// Java Edition block interaction range, from the eyes to a block.
// https://minecraft.wiki/w/Player#Reach — "Default interaction range": Java Edition block is 4.5 in
// other game modes and 5 in Creative. The login packet does not carry this number (1.20.4); it is the
// range for bot.game.gameMode. This is game.reach. It is not a search radius and not what "nearby" means.
const JAVA_BLOCK_REACH = Object.freeze({ survival: 4.5, adventure: 4.5, spectator: 4.5, creative: 5 });

export function gameReach(bot) {
    const game = bot && bot.game;
    if (!game || typeof game !== 'object') {
        throw new Error('game.reach: bot.game is missing. The block interaction range depends on gameMode (https://minecraft.wiki/w/Player#Reach).');
    }
    const mode = game.gameMode;
    if (!Object.hasOwn(JAVA_BLOCK_REACH, mode)) {
        throw new Error(`game.reach: gameMode ${JSON.stringify(mode)} is not a Java Edition mode. Block reach is 4.5 except Creative, which is 5 (https://minecraft.wiki/w/Player#Reach).`);
    }
    return JAVA_BLOCK_REACH[mode];
}

function eyeOf(bot) {
    const pos = bot && bot.entity && bot.entity.position;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        throw new Error('nearby blocks: bot.entity.position is missing.');
    }
    const eyeHeight = bot.entity.eyeHeight;
    if (typeof eyeHeight !== 'number' || !Number.isFinite(eyeHeight)) {
        throw new Error('nearby blocks: bot.entity.eyeHeight is missing. Sight and block reach are measured from the eye (https://minecraft.wiki/w/Player#Reach).');
    }
    return { x: pos.x, y: pos.y + eyeHeight, z: pos.z };
}

// Closest point of the unit cube [pos, pos+1) to the eye. The wiki measures block reach from the eyes to the block.
function closestOnBlock(eye, pos) {
    const px = eye.x < pos.x ? pos.x : eye.x >= pos.x + 1 ? pos.x + 1 : eye.x;
    const py = eye.y < pos.y ? pos.y : eye.y >= pos.y + 1 ? pos.y + 1 : eye.y;
    const pz = eye.z < pos.z ? pos.z : eye.z >= pos.z + 1 ? pos.z + 1 : eye.z;
    return { x: px, y: py, z: pz };
}

export function withinInteractionRange(bot, pos) {
    /**
     * True when the block cube is inside game.reach of the bot's eye. Dig, place, and use require this.
     * @param {Bot} bot - The bot. game.reach is the Java Edition block interaction range for bot.game.gameMode.
     * @param {Vec3} pos - Integer block position.
     * @returns {boolean}
     * @example
     * let ok = world.withinInteractionRange(bot, block.position);
     **/
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        throw new Error('withinInteractionRange: block position is missing.');
    }
    const eye = eyeOf(bot);
    const p = closestOnBlock(eye, pos);
    return dist2(eye.x, eye.y, eye.z, p.x, p.y, p.z) <= gameReach(bot) * gameReach(bot);
}

// One pathfinder search for one chosen block. The cost is the A* result, never membership of the perceived set.
// mineflayer-pathfinder index.js getPathTo (lines 64-71) takes only the first yield of getPathFromTo.
// lib/astar.js compute() returns 'partial' when that slice exceeds tickTimeout (index.js:41) and 'timeout'
// when the whole search exceeds thinkTimeout (index.js:40, astar.js:73). 'noPath' is the open set exhausted
// (astar.js:121). partial means the search is not finished yet. It is not reachable and it is not unreachable.
// pathToBlock keeps stepping getPathFromTo, one tickTimeout slice then a yield, until the status is success
// or noPath. Callers only see those two. A partial that arrives as a finished answer is a search that stopped
// early: that throws, and nothing records it as a reach result.
function lookGoal(bot, position) {
    if (!bot || !bot.pathfinder || !bot.pathfinder.movements) {
        throw new Error('reachability: bot.pathfinder.movements is missing. The search is the A* with the bot\'s Movements (mineflayer-pathfinder index.js).');
    }
    const movements = bot.pathfinder.movements;
    if (!movements) throw new Error('reachability: bot.pathfinder.movements is missing. The search is the A* with the bot\'s Movements.');
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
        throw new Error('reachability: the target position is not finite.');
    }
    const eyeHeight = bot.entity && bot.entity.eyeHeight;
    if (typeof eyeHeight !== 'number' || !Number.isFinite(eyeHeight)) {
        throw new Error('reachability: bot.entity.eyeHeight is missing.');
    }
    if (!bot.world) throw new Error('reachability: bot.world is missing. GoalLookAtBlock raycasts through the world.');
    const goal = new pf.goals.GoalLookAtBlock(new Vec3(position.x, position.y, position.z), bot.world, { entityHeight: eyeHeight, reach: gameReach(bot) });
    return { movements, goal };
}

function finishedPath(result, where) {
    if (!result || typeof result.status !== 'string') throw new Error(`reachability: ${where} returned ${JSON.stringify(result && result.status)}.`);
    if (result.status === 'partial' || result.status === 'timeout') {
        throw new Error(`reachability: ${where} returned ${result.status}. That search is not finished and is not unreachable (mineflayer-pathfinder index.js:64-71 takes one tickTimeout slice; lib/astar.js:70 returns partial, line 73 returns timeout).`);
    }
    return result;
}

// The pathfinder's own ordering for "nearest block to look at" (mineflayer-pathfinder lib/goals.js GoalLookAtBlock.heuristic).
export function lookHeuristic(bot, position) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
        throw new Error('reachability: the target position is not finite.');
    }
    const pos = bot && bot.entity && bot.entity.position;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        throw new Error('reachability: bot.entity.position is missing. GoalLookAtBlock.heuristic measures from it (mineflayer-pathfinder lib/goals.js).');
    }
    const eyeHeight = bot.entity.eyeHeight;
    if (typeof eyeHeight !== 'number' || !Number.isFinite(eyeHeight)) {
        throw new Error('reachability: bot.entity.eyeHeight is missing.');
    }
    const goal = new pf.goals.GoalLookAtBlock(new Vec3(position.x, position.y, position.z), bot.world, { entityHeight: eyeHeight, reach: gameReach(bot) });
    return goal.heuristic(pos);
}

async function yieldSearchTurn(bot) {
    if (!bot || typeof bot.waitForTicks !== 'function') {
        throw new Error('reachability: bot.waitForTicks is missing. A partial search waits one tick (mineflayer bot.waitForTicks).');
    }
    await bot.waitForTicks(1);
}

function openSearch(bot, position) {
    if (!bot || !bot.pathfinder || typeof bot.pathfinder.getPathFromTo !== 'function') {
        throw new Error('reachability: bot.pathfinder.getPathFromTo steps the search across ticks (mineflayer-pathfinder index.js:75). It is missing.');
    }
    const tick = bot.pathfinder.tickTimeout;
    if (typeof tick !== 'number' || !(tick > 0)) {
        throw new Error('reachability: bot.pathfinder.tickTimeout is missing (mineflayer-pathfinder index.js:41 is the per-tick budget). A search is not stopped by a made-up budget.');
    }
    if (!bot.entity || !bot.entity.position) {
        throw new Error('reachability: bot.entity.position is missing. getPathFromTo starts there (mineflayer-pathfinder index.js:69).');
    }
    const { movements, goal } = lookGoal(bot, position);
    // thinkTimeout (index.js:40, default 5000) is a machine-speed cap. The loaded columns bound the open set.
    return bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout: Number.POSITIVE_INFINITY, tickTimeout: tick });
}

function yieldResult(step) {
    const result = step.value && step.value.result;
    if (!result || typeof result.status !== 'string') {
        throw new Error(`reachability: getPathFromTo yielded ${JSON.stringify(result && result.status)}.`);
    }
    return result;
}

function returnedResult(step) {
    const finished = step.value && step.value.result;
    if (finished && (finished.status === 'partial' || finished.status === 'timeout')) {
        throw new Error(`reachability: getPathFromTo returned ${finished.status}. A partial result is not unreachable (mineflayer-pathfinder lib/astar.js compute).`);
    }
    if (finished && (finished.status === 'success' || finished.status === 'noPath')) return finished;
    throw new Error('reachability: getPathFromTo ended without a result (mineflayer-pathfinder index.js:75).');
}

function rejectUnfinished(result) {
    if (result.status === 'timeout') {
        throw new Error('reachability: the search stopped on thinkTimeout (mineflayer-pathfinder index.js:40, lib/astar.js:73). The loaded world bounds the search. A timer does not.');
    }
    throw new Error(`reachability: getPathFromTo returned ${result.status}. Expected success, noPath, or partial (mineflayer-pathfinder lib/astar.js compute).`);
}

// The first slice when it is already success or noPath. null means the slice is partial: pathToBlock
// continues that search across ticks. A partial slice is not success and not noPath.
export function pathToBlockReady(bot, position) {
    const gen = openSearch(bot, position);
    const step = gen.next();
    if (step.done) return returnedResult(step);
    const result = yieldResult(step);
    if (result.status === 'success' || result.status === 'noPath') return result;
    if (result.status === 'partial') return null;
    rejectUnfinished(result);
}

export async function pathToBlock(bot, position) {
    /**
     * Path cost to one block, searched until the pathfinder finds it or exhausts the loaded world.
     * @param {Bot} bot - The bot. bot.pathfinder.movements is the Movements the A* uses.
     * @param {Vec3} position - The chosen block.
     * @returns {object} - status success or noPath, and the path cost.
     * @example
     * let path = await world.pathToBlock(bot, block.position);
     **/
    const gen = openSearch(bot, position);
    let step = gen.next();
    while (!step.done) {
        const result = yieldResult(step);
        if (result.status === 'success' || result.status === 'noPath') return result;
        // Not yet known. The next gen.next() is another tickTimeout slice (index.js:41); it does not run
        // until the event loop has had a turn, so the search never blocks for more than one slice.
        if (result.status === 'partial') {
            await yieldSearchTurn(bot);
            step = gen.next();
            continue;
        }
        rejectUnfinished(result);
    }
    return returnedResult(step);
}

function dist2(ax, ay, az, bx, by, bz) {
    const dx = ax - bx, dy = ay - by, dz = az - bz;
    return dx * dx + dy * dy + dz * dz;
}

// Inverse of prismarine-chunk PaletteChunkSection getBlockIndex: (y << 8) | (z << 4) | x.
function localCell(index) {
    const mask = SECTION_WIDTH - 1;
    return { x: index & mask, z: (index >> 4) & mask, y: (index >> 8) & mask };
}

// PaletteContainer.get returns palette[data.get(index)], the cell's current state. IndirectPaletteContainer.set
// pushes onto the palette and never removes an entry, so the palette still names a block after it is gone.
// The palette only decides that the section stores blocks. The cell read is the state that is present.
function cellStateId(section, index, where) {
    const data = section.data;
    if (data && typeof data.get === 'function') {
        const id = data.get(index);
        if (typeof id !== 'number') throw new Error(`nearby blocks: ${where} cell ${index} is not a state id`);
        return id;
    }
    if (data && typeof data.value === 'number') return data.value;
    throw new Error(`nearby blocks: ${where} has no block storage. A palette without cell reads is not the blocks present (prismarine-chunk PaletteContainer).`);
}

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACE_COUNT = FACES.length;
// One section face is 16×16 cells. ChunkOcclusionDataBuilder.build (yarn 1.20.4,
// net.minecraft.client.render.chunk) fills every face pair when fewer blocks than that are closed:
// a separator needs a whole face. The section is cubic, so every face has CHUNK_WIDTH * SECTION_HEIGHT cells.
const FACE_AREA = CHUNK_WIDTH * SECTION_HEIGHT;
const ALL_FACES = (1 << FACE_COUNT) - 1;
const perceivedIndex = new WeakMap();
const perceivedStat = new WeakMap();

// Six exit masks, one per entry face. A JS shift is 32 bits, and 6×6 pairs do not fit in one.
// ChunkOcclusionData.isVisibleThrough(from, to). from < 0 is the section the eye is inside.
function closedConn() {
    return [0, 0, 0, 0, 0, 0];
}

function openConn() {
    return [ALL_FACES, ALL_FACES, ALL_FACES, ALL_FACES, ALL_FACES, ALL_FACES];
}

function connClosed(conn) {
    for (let face = 0; face < FACE_COUNT; face++) if (conn[face] !== 0) return false;
    return true;
}

function connects(conn, from, to) {
    if (from < 0) return true;
    return (conn[from] & (1 << to)) !== 0;
}

// WorldRenderer.setupTerrain queues a neighbour only on the side of this section the camera has not already
// passed, so the walk moves away from the eye (Checchi, https://tomcc.github.io/2014/08/31/visibility-1.html).
function facesAway(eye, originX, originY, originZ, face) {
    const [fx, fy, fz] = FACES[face];
    if (fx > 0) return eye.x < originX + CHUNK_WIDTH;
    if (fx < 0) return eye.x >= originX;
    if (fy > 0) return eye.y < originY + SECTION_HEIGHT;
    if (fy < 0) return eye.y >= originY;
    if (fz > 0) return eye.z < originZ + CHUNK_WIDTH;
    return eye.z >= originZ;
}

function faceLooksAtEye(eye, cell, face) {
    const [fx, fy, fz] = FACES[face];
    if (fx > 0) return eye.x > cell.x + 1;
    if (fx < 0) return eye.x < cell.x;
    if (fy > 0) return eye.y > cell.y + 1;
    if (fy < 0) return eye.y < cell.y;
    if (fz > 0) return eye.z > cell.z + 1;
    return eye.z < cell.z;
}

// A full opaque cube hides the face against it. Air and every other non-full or transparent block does not.
// prismarine-block: boundingBox 'block' is a full cube; transparent blocks (glass, leaves) do not occlude.
// State 0 is air: its shapes are empty, and World.raycast does not stop on it (prismarine-world docs/API.md).
function nonOccluding(registry, stateId, cache) {
    if (stateId === 0) return true;
    const cached = cache.get(stateId);
    if (cached !== undefined) return cached;
    const block = registry.blocksByStateId[stateId];
    if (!block) throw new Error(`nearby blocks: state id ${stateId} is not in the registry`);
    const open = block.boundingBox !== 'block' || block.transparent === true;
    cache.set(stateId, open);
    return open;
}

function paletteIds(section, where) {
    if (Array.isArray(section.palette) && section.palette.length > 0) return section.palette;
    const data = section.data;
    if (data && Array.isArray(data.palette) && data.palette.length > 0) return data.palette;
    if (data && typeof data.value === 'number') return [data.value];
    throw new Error(`nearby blocks: ${where} has no palette. The palette selects the section; the cells confirm it (prismarine-chunk PaletteContainer).`);
}

function columnIndex(bot) {
    if (!bot.world || typeof bot.world.getColumns !== 'function') {
        throw new Error('nearby blocks: bot.world.getColumns is missing. Block states are read from loaded chunk sections (prismarine-chunk), not from findBlocks.');
    }
    const index = new Map();
    for (const col of bot.world.getColumns()) {
        if (!col || !Number.isInteger(Number(col.chunkX)) || !Number.isInteger(Number(col.chunkZ)) || !col.column) {
            throw new Error(`nearby blocks: a loaded column has no chunk coordinates (${JSON.stringify(col && { chunkX: col.chunkX, chunkZ: col.chunkZ })}).`);
        }
        index.set(`${Number(col.chunkX)},${Number(col.chunkZ)}`, col);
    }
    return index;
}

// State id at a world block, or null when that chunk is outside the view square. A hole inside the view throws.
// A face looking out of the square is not exposed, and the chunk beyond it is not read.
function stateAt(index, x, y, z, view) {
    const cx = Math.floor(x / CHUNK_WIDTH), cz = Math.floor(z / CHUNK_WIDTH);
    if (Math.abs(cx - view.stoodX) > view.radius || Math.abs(cz - view.stoodZ) > view.radius) return null;
    const col = index.get(`${cx},${cz}`);
    if (!col) throw new Error(`nearby blocks: chunk ${cx},${cz} is inside the view and is not loaded. A missing column is not an empty block list.`);
    const column = col.column;
    if (!Number.isInteger(column.minY) || !Array.isArray(column.sections)) {
        throw new Error(`nearby blocks: chunk ${cx},${cz} has no minY or sections.`);
    }
    const si = (y - column.minY) >> 4;
    if (si < 0 || si >= column.sections.length) return null;
    const section = column.sections[si];
    const originY = column.minY + si * SECTION_HEIGHT;
    if (!section) throw new Error(`nearby blocks: chunk ${cx},${cz} section ${si} (y ${originY}) is not loaded. A missing section is not an empty block list.`);
    const lx = x - cx * CHUNK_WIDTH, ly = y - originY, lz = z - cz * CHUNK_WIDTH;
    const cell = (ly << 8) | (lz << 4) | lx;
    return cellStateId(section, cell, `chunk ${cx},${cz} section ${si}`);
}

// Perceived blocks are the exposed faces the eye can reach through the section visibility graph.
// Checchi, "The Advanced Cave Culling Algorithm" (https://tomcc.github.io/2014/08/31/visibility-1.html):
// flood-fill the non-opaque cells of a 16³ section once and record which of its 6 faces connect.
// ChunkOcclusionDataBuilder / ChunkOcclusionData (yarn 1.20.4, net.minecraft.client.render.chunk) is that graph.
// observe() BFS-es sections from the eye, steps through a connected face pair, and only away from the eye,
// inside the loaded view square (https://minecraft.wiki/w/Render_distance). A buried cave section is never a
// candidate. The graph is built when the chunk loads, one column per turn, and rebuilt for a section on
// blockUpdate. mineflayer forwards chunkColumnLoad, chunkColumnUnload, and blockUpdate from the world
// (mineflayer lib/plugins/blocks.js forwardedEvents; prismarine-world worldsync.js).
function viewContext(bot) {
    const eye = eyeOf(bot);
    const registry = bot.registry;
    if (!registry || !registry.blocksByStateId) throw new Error('nearby blocks: bot.registry.blocksByStateId is missing');
    const radius = serverChunkRadius(bot);
    const stoodX = Math.floor(eye.x / CHUNK_WIDTH);
    const stoodZ = Math.floor(eye.z / CHUNK_WIDTH);
    return { eye, registry, radius, stoodX, stoodZ, columns: columnIndex(bot), view: { stoodX, stoodZ, radius } };
}

function standingKey(ctx) {
    return `${ctx.stoodX},${ctx.stoodZ}`;
}

function missingStanding(ctx) {
    return new Error(`nearby blocks: the chunk the bot is standing in (${ctx.stoodX},${ctx.stoodZ}) is not loaded.`);
}

function inView(ctx, cx, cz) {
    return Math.abs(cx - ctx.stoodX) <= ctx.radius && Math.abs(cz - ctx.stoodZ) <= ctx.radius;
}

function sectionWhere(cx, cz, column, si) {
    const originY = column.minY + si * SECTION_HEIGHT;
    return { originY, where: `chunk ${cx},${cz} section ${si} (y ${originY})` };
}

function sectionInfo(column, si, where, registry, open) {
    const section = column.sections[si];
    if (!section) throw new Error(`nearby blocks: ${where} is not loaded. A missing section is not an empty block list.`);
    const ids = paletteIds(section, where);
    if (ids.every(id => id === 0)) return { kind: 'air', section };
    if (ids.length === 1 && !nonOccluding(registry, ids[0], open)) return { kind: 'solid', section, id: ids[0] };
    if (ids.every(id => nonOccluding(registry, id, open))) return { kind: 'clear', section };
    return { kind: 'mixed', section };
}

function neighborSection(ctx, x, y, z, idx) {
    const cx = Math.floor(x / CHUNK_WIDTH), cz = Math.floor(z / CHUNK_WIDTH);
    if (!inView(ctx, cx, cz)) return { kind: 'hidden' };
    const key = `${cx},${cz}`;
    const col = ctx.columns.get(key);
    if (!col) return { kind: 'hidden' };
    const column = col.column;
    if (!Number.isInteger(column.minY) || !Array.isArray(column.sections)) {
        throw new Error(`nearby blocks: chunk ${cx},${cz} has no minY or sections.`);
    }
    const si = (y - column.minY) >> 4;
    if (si < 0 || si >= column.sections.length) return { kind: 'hidden' };
    const { originY, where } = sectionWhere(cx, cz, column, si);
    const info = sectionInfo(column, si, where, ctx.registry, idx.open);
    return { ...info, where, originY, minX: cx * CHUNK_WIDTH, minZ: cz * CHUNK_WIDTH };
}

function readIndexedCell(ctx, x, y, z, idx) {
    idx.cellReads += 1;
    return stateAt(ctx.columns, x, y, z, ctx.view);
}

function faceOpen(ctx, idx, x, y, z, fx, fy, fz, ownCells) {
    const nx = x + fx, ny = y + fy, nz = z + fz;
    if (ownCells) {
        const lx = nx - ownCells.minX, ly = ny - ownCells.originY, lz = nz - ownCells.minZ;
        if (lx >= 0 && lx < CHUNK_WIDTH && ly >= 0 && ly < SECTION_HEIGHT && lz >= 0 && lz < CHUNK_WIDTH) {
            const id = ownCells.ids[(ly << 8) | (lz << 4) | lx];
            return nonOccluding(ctx.registry, id, idx.open);
        }
    }
    const info = neighborSection(ctx, nx, ny, nz, idx);
    if (info.kind === 'hidden') return false;
    if (info.kind === 'air' || info.kind === 'clear') return true;
    if (info.kind === 'solid') return false;
    const id = readIndexedCell(ctx, nx, ny, nz, idx);
    return nonOccluding(ctx.registry, id, idx.open);
}

function facePositions(minX, originY, minZ, face) {
    const [fx, fy, fz] = FACES[face];
    const out = [];
    if (fx !== 0) {
        const x = minX + (fx > 0 ? CHUNK_WIDTH - 1 : 0);
        for (let y = 0; y < SECTION_HEIGHT; y++) for (let z = 0; z < CHUNK_WIDTH; z++) out.push([x, originY + y, minZ + z]);
    } else if (fy !== 0) {
        const y = originY + (fy > 0 ? SECTION_HEIGHT - 1 : 0);
        for (let x = 0; x < CHUNK_WIDTH; x++) for (let z = 0; z < CHUNK_WIDTH; z++) out.push([minX + x, y, minZ + z]);
    } else {
        const z = minZ + (fz > 0 ? CHUNK_WIDTH - 1 : 0);
        for (let x = 0; x < CHUNK_WIDTH; x++) for (let y = 0; y < SECTION_HEIGHT; y++) out.push([minX + x, originY + y, z]);
    }
    return out;
}

function putCell(sec, x, y, z, id, bit) {
    if (id === 0) return;
    const pack = `${x},${y},${z}`;
    const prev = sec.cells.get(pack);
    if (prev) { prev.mask |= bit; return; }
    sec.cells.set(pack, { x, y, z, id, mask: bit });
    sec.states.add(id);
}

function emptySection(conn) {
    return { conn, reach: null, cells: new Map(), states: new Set() };
}

// Face bits of one flood, and the cells in it. Started only from a section face, matching
// ChunkOcclusionDataBuilder's edge points: an interior pocket touches no face and stores 0.
function floodOpen(open, start, visited, queue) {
    let qh = 0;
    let qt = 0;
    queue[qt++] = start;
    visited[start] = 1;
    let faces = 0;
    const cells = [];
    while (qh < qt) {
        const cur = queue[qh++];
        cells.push(cur);
        const x = cur & 15;
        const z = (cur >> 4) & 15;
        const y = cur >> 8;
        if (x === 0) faces |= 1 << 1;
        if (x === CHUNK_WIDTH - 1) faces |= 1 << 0;
        if (y === 0) faces |= 1 << 3;
        if (y === SECTION_HEIGHT - 1) faces |= 1 << 2;
        if (z === 0) faces |= 1 << 5;
        if (z === CHUNK_WIDTH - 1) faces |= 1 << 4;
        for (let face = 0; face < FACE_COUNT; face++) {
            const [fx, fy, fz] = FACES[face];
            const nx = x + fx, ny = y + fy, nz = z + fz;
            if (nx < 0 || ny < 0 || nz < 0 || nx >= CHUNK_WIDTH || ny >= SECTION_HEIGHT || nz >= CHUNK_WIDTH) continue;
            const ni = (ny << 8) | (nz << 4) | nx;
            if (!open[ni] || visited[ni]) continue;
            visited[ni] = 1;
            queue[qt++] = ni;
        }
    }
    return { faces, cells };
}

function connectFaceBits(conn, faces) {
    for (let a = 0; a < FACE_COUNT; a++) {
        if ((faces & (1 << a)) === 0) continue;
        for (let b = 0; b < FACE_COUNT; b++) if (faces & (1 << b)) conn[a] |= 1 << b;
    }
}

// The face-connectivity set of one section, plus a per-cell mask of the faces that cell's air can reach.
function visibilityGraph(ids, registry, openCache) {
    let opaque = 0;
    const open = new Uint8Array(BLOCK_SECTION_VOLUME);
    for (let i = 0; i < BLOCK_SECTION_VOLUME; i++) {
        const isOpen = nonOccluding(registry, ids[i], openCache);
        open[i] = isOpen ? 1 : 0;
        if (!isOpen) opaque += 1;
    }
    if (opaque === 0 || opaque < FACE_AREA) return { conn: openConn(), reach: null };
    if (opaque === BLOCK_SECTION_VOLUME) return { conn: closedConn(), reach: null };
    const reach = new Uint8Array(BLOCK_SECTION_VOLUME);
    const visited = new Uint8Array(BLOCK_SECTION_VOLUME);
    const queue = new Int32Array(BLOCK_SECTION_VOLUME);
    const conn = closedConn();
    const start = (i) => {
        if (!open[i] || visited[i]) return;
        const flooded = floodOpen(open, i, visited, queue);
        connectFaceBits(conn, flooded.faces);
        for (const cell of flooded.cells) reach[cell] = flooded.faces;
    };
    for (let y = 0; y < SECTION_HEIGHT; y += SECTION_HEIGHT - 1) {
        for (let z = 0; z < CHUNK_WIDTH; z++) for (let x = 0; x < CHUNK_WIDTH; x++) start((y << 8) | (z << 4) | x);
    }
    for (let z = 0; z < CHUNK_WIDTH; z += CHUNK_WIDTH - 1) {
        for (let y = 0; y < SECTION_HEIGHT; y++) for (let x = 0; x < CHUNK_WIDTH; x++) start((y << 8) | (z << 4) | x);
    }
    for (let x = 0; x < CHUNK_WIDTH; x += CHUNK_WIDTH - 1) {
        for (let y = 0; y < SECTION_HEIGHT; y++) for (let z = 0; z < CHUNK_WIDTH; z++) start((y << 8) | (z << 4) | x);
    }
    return { conn, reach };
}

function indexSection(idx, ctx, cx, cz, si, column) {
    const { originY, where } = sectionWhere(cx, cz, column, si);
    const info = sectionInfo(column, si, where, ctx.registry, idx.open);
    idx.sectionsBuilt += 1;
    const minX = cx * CHUNK_WIDTH, minZ = cz * CHUNK_WIDTH;
    if (info.kind === 'air') {
        idx.sectionsSkipped += 1;
        return emptySection(openConn());
    }
    const sec = emptySection(closedConn());
    if (info.kind === 'solid' || info.kind === 'clear') {
        sec.conn = info.kind === 'clear' ? openConn() : closedConn();
        let opened = false;
        for (let face = 0; face < FACE_COUNT; face++) {
            const [fx, fy, fz] = FACES[face];
            const probe = neighborSection(ctx, minX + (fx > 0 ? CHUNK_WIDTH - 1 : 0) + fx, originY + (fy > 0 ? SECTION_HEIGHT - 1 : 0) + fy, minZ + (fz > 0 ? CHUNK_WIDTH - 1 : 0) + fz, idx);
            if (probe.kind === 'solid' || probe.kind === 'hidden') continue;
            const positions = facePositions(minX, originY, minZ, face);
            if (info.kind === 'solid' && (probe.kind === 'air' || probe.kind === 'clear')) {
                opened = true;
                for (const [x, y, z] of positions) putCell(sec, x, y, z, info.id, 1 << face);
                continue;
            }
            for (const [x, y, z] of positions) {
                if (info.kind === 'solid' && !faceOpen(ctx, idx, x, y, z, fx, fy, fz, null)) continue;
                if (info.kind === 'clear') {
                    const id = readIndexedCell(ctx, x, y, z, idx);
                    if (id === 0 || !faceOpen(ctx, idx, x, y, z, fx, fy, fz, null)) continue;
                    opened = true;
                    putCell(sec, x, y, z, id, 1 << face);
                    continue;
                }
                opened = true;
                putCell(sec, x, y, z, info.id, 1 << face);
            }
        }
        if (!opened) idx.sectionsSkipped += 1;
        return sec;
    }
    const ids = new Int32Array(BLOCK_SECTION_VOLUME);
    for (let i = 0; i < BLOCK_SECTION_VOLUME; i++) {
        idx.cellReads += 1;
        ids[i] = cellStateId(info.section, i, where);
    }
    const graph = visibilityGraph(ids, ctx.registry, idx.open);
    sec.conn = graph.conn;
    sec.reach = graph.reach;
    const own = { ids, minX, originY, minZ };
    let opened = false;
    for (let i = 0; i < BLOCK_SECTION_VOLUME; i++) {
        const id = ids[i];
        if (id === 0) continue;
        const local = localCell(i);
        const x = minX + local.x, y = originY + local.y, z = minZ + local.z;
        for (let face = 0; face < FACE_COUNT; face++) {
            const [fx, fy, fz] = FACES[face];
            if (!faceOpen(ctx, idx, x, y, z, fx, fy, fz, own)) continue;
            opened = true;
            putCell(sec, x, y, z, id, 1 << face);
        }
    }
    if (!opened) idx.sectionsSkipped += 1;
    return sec;
}

function bumpVis(idx) {
    idx.visGen += 1;
    idx.vis = null;
}

function buildColumn(idx, ctx, cx, cz) {
    const selfKey = `${cx},${cz}`;
    const col = ctx.columns.get(selfKey);
    if (!col || !col.column || !Number.isInteger(col.column.minY) || !Array.isArray(col.column.sections)) {
        throw new Error(`nearby blocks: chunk ${cx},${cz} is queued in the view and is not loaded. A missing column is not an empty block list.`);
    }
    const column = col.column;
    const started = performance.now();
    const sections = new Array(column.sections.length);
    for (let si = 0; si < column.sections.length; si++) sections[si] = indexSection(idx, ctx, cx, cz, si, column);
    const ms = performance.now() - started;
    idx.columns.set(selfKey, { sections, ms });
    idx.builds += 1;
    idx.buildMs += ms;
    bumpVis(idx);
}

function enqueueColumn(idx, ctx, cx, cz) {
    const key = `${cx},${cz}`;
    if (!inView(ctx, cx, cz) || !ctx.columns.has(key)) return;
    if (idx.columns.has(key) || idx.pending.has(key)) return;
    idx.pending.add(key);
    idx.queue.push({ cx, cz });
}

function enqueueView(idx, ctx) {
    for (let dz = -ctx.radius; dz <= ctx.radius; dz++) {
        for (let dx = -ctx.radius; dx <= ctx.radius; dx++) enqueueColumn(idx, ctx, ctx.stoodX + dx, ctx.stoodZ + dz);
    }
}

function indexReport(idx) {
    const perChunkMs = [];
    let ms = 0;
    for (const rec of idx.columns.values()) {
        perChunkMs.push(rec.ms);
        ms += rec.ms;
    }
    return {
        chunks: idx.columns.size,
        ms,
        cellReads: idx.cellReads,
        sectionsBuilt: idx.sectionsBuilt,
        sectionsSkipped: idx.sectionsSkipped,
        perChunkMs,
        builds: idx.builds,
        buildMs: idx.buildMs,
    };
}

function scheduleIndex(bot, idx) {
    if (idx.pumping) return;
    if (!idx.queue.length) {
        if (idx.drain.length === 0) return;
        const waiting = idx.drain.splice(0);
        const report = indexReport(idx);
        for (const w of waiting) w.resolve(report);
        return;
    }
    idx.pumping = true;
    const step = () => {
        if (!idx.queue.length) {
            idx.pumping = false;
            const waiting = idx.drain.splice(0);
            const report = indexReport(idx);
            for (const w of waiting) w.resolve(report);
            return;
        }
        const job = idx.queue.shift();
        const key = `${job.cx},${job.cz}`;
        idx.pending.delete(key);
        try {
            buildColumn(idx, viewContext(bot), job.cx, job.cz);
        } catch (err) {
            // Taken off pending before the build. Put it back and leave every other queued column pending.
            // Clearing the queue left loaded in-view columns neither indexed nor pending (the reindexSectionAt invariant).
            if (!idx.columns.has(key)) {
                idx.pending.add(key);
                idx.queue.unshift(job);
            }
            idx.pumping = false;
            const waiting = idx.drain.splice(0);
            if (waiting.length === 0) throw err;
            for (const w of waiting) w.reject(err);
            return;
        }
        setImmediate(step);
    };
    setImmediate(step);
}

function chunkCorner(corner, event) {
    if (!corner || !Number.isFinite(corner.x) || !Number.isFinite(corner.z)) {
        throw new Error(`nearby blocks: ${event} has no column corner (prismarine-world worldsync.js).`);
    }
    return { cx: Math.floor(corner.x / CHUNK_WIDTH), cz: Math.floor(corner.z / CHUNK_WIDTH) };
}

function dropColumn(idx, key) {
    const had = idx.columns.delete(key);
    idx.pending.delete(key);
    idx.queue = idx.queue.filter(job => `${job.cx},${job.cz}` !== key);
    if (had) bumpVis(idx);
}

function clearFace(sec, bit) {
    for (const [pack, cell] of sec.cells) {
        if ((cell.mask & bit) === 0) continue;
        cell.mask &= ~bit;
        if (cell.mask === 0) sec.cells.delete(pack);
    }
    sec.states.clear();
    for (const cell of sec.cells.values()) sec.states.add(cell.id);
}

// The shared face of an already-indexed neighbour. Loading opens it; unloading closes it.
// This does not build the neighbour column.
function refreshBoundary(idx, ctx, cx, cz, face) {
    const key = `${cx},${cz}`;
    const rec = idx.columns.get(key);
    if (!rec) return;
    const col = ctx.columns.get(key);
    if (!col || !col.column || !Number.isInteger(col.column.minY) || !Array.isArray(col.column.sections)) return;
    const column = col.column;
    const bit = 1 << face;
    const [fx, fy, fz] = FACES[face];
    let changed = false;
    for (let si = 0; si < rec.sections.length; si++) {
        const sec = rec.sections[si];
        if (!sec) continue;
        const before = sec.cells.size;
        clearFace(sec, bit);
        if (sec.cells.size !== before) changed = true;
        const { originY, where } = sectionWhere(cx, cz, column, si);
        const info = sectionInfo(column, si, where, ctx.registry, idx.open);
        if (info.kind === 'air') continue;
        const minX = cx * CHUNK_WIDTH, minZ = cz * CHUNK_WIDTH;
        for (const [x, y, z] of facePositions(minX, originY, minZ, face)) {
            const id = info.kind === 'solid' ? info.id : readIndexedCell(ctx, x, y, z, idx);
            if (id === 0 || id === null) continue;
            if (!faceOpen(ctx, idx, x, y, z, fx, fy, fz, null)) continue;
            const pack = `${x},${y},${z}`;
            const prev = sec.cells.get(pack);
            if (!prev || (prev.mask & bit) === 0) changed = true;
            putCell(sec, x, y, z, id, bit);
        }
    }
    if (changed) bumpVis(idx);
}

function patchNeighborFaces(idx, ctx, cx, cz) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const face = dx === 1 ? 0 : dx === -1 ? 1 : dz === 1 ? 4 : 5;
        refreshBoundary(idx, ctx, cx + dx, cz + dz, face ^ 1);
    }
}

function dropOutsideView(idx, ctx) {
    if (idx.viewX === ctx.stoodX && idx.viewZ === ctx.stoodZ && idx.viewR === ctx.radius) return;
    const gone = [];
    for (const key of idx.columns.keys()) {
        const [cx, cz] = key.split(',').map(Number);
        if (!inView(ctx, cx, cz)) gone.push({ cx, cz, key });
    }
    idx.queue = idx.queue.filter(job => inView(ctx, job.cx, job.cz));
    for (const key of [...idx.pending]) {
        const [cx, cz] = key.split(',').map(Number);
        if (!inView(ctx, cx, cz)) idx.pending.delete(key);
    }
    for (const g of gone) dropColumn(idx, g.key);
    for (const g of gone) patchNeighborFaces(idx, ctx, g.cx, g.cz);
    idx.viewX = ctx.stoodX;
    idx.viewZ = ctx.stoodZ;
    idx.viewR = ctx.radius;
}

// A loaded column enters the square when the bot crosses a chunk border or the radius grows. There is no
// load event: vanilla already sent the ring just past the view edge, and a scan's dropOutsideView drops a
// column that stays loaded. Re-sync on every event that builds a view context. dropOutsideView returns
// immediately when the stood chunk and the radius are unchanged.
function syncView(bot, idx, ctx) {
    dropOutsideView(idx, ctx);
    enqueueView(idx, ctx);
    scheduleIndex(bot, idx);
}

function onColumnLoad(bot, idx, corner) {
    const { cx, cz } = chunkCorner(corner, 'chunkColumnLoad');
    const ctx = viewContext(bot);
    dropColumn(idx, `${cx},${cz}`);
    syncView(bot, idx, ctx);
    patchNeighborFaces(idx, ctx, cx, cz);
}

function onColumnUnload(bot, idx, corner) {
    const { cx, cz } = chunkCorner(corner, 'chunkColumnUnload');
    const ctx = viewContext(bot);
    dropColumn(idx, `${cx},${cz}`);
    syncView(bot, idx, ctx);
    patchNeighborFaces(idx, ctx, cx, cz);
}

function reindexSectionAt(idx, ctx, x, y, z, done) {
    const cx = Math.floor(x / CHUNK_WIDTH), cz = Math.floor(z / CHUNK_WIDTH);
    if (!inView(ctx, cx, cz)) return;
    const key = `${cx},${cz}`;
    const col = ctx.columns.get(key);
    const built = idx.columns.get(key);
    if (!col) return;
    if (!built) {
        if (idx.pending.has(key)) return;
        throw new Error(`nearby blocks: chunk ${cx},${cz} is loaded in the view and is neither indexed nor pending.`);
    }
    const column = col.column;
    if (!Number.isInteger(column.minY) || !Array.isArray(column.sections)) {
        throw new Error(`nearby blocks: chunk ${cx},${cz} has no minY or sections.`);
    }
    const si = (y - column.minY) >> 4;
    if (si < 0 || si >= column.sections.length) return;
    const token = `${key}:${si}`;
    if (done.has(token)) return;
    done.add(token);
    built.sections[si] = indexSection(idx, ctx, cx, cz, si, column);
}

function onBlockUpdate(bot, idx, oldBlock, newBlock) {
    const pos = (newBlock && newBlock.position) || (oldBlock && oldBlock.position);
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        throw new Error('nearby blocks: blockUpdate has no position (prismarine-world worldsync.js _emitBlockUpdate).');
    }
    const ctx = viewContext(bot);
    syncView(bot, idx, ctx);
    const done = new Set();
    reindexSectionAt(idx, ctx, pos.x, pos.y, pos.z, done);
    for (const [fx, fy, fz] of FACES) reindexSectionAt(idx, ctx, pos.x + fx, pos.y + fy, pos.z + fz, done);
    // Visibility was confirmed from the last eye cell through these sections. A cell change there can open or
    // close a ray. A change outside that set cannot: the walk never entered it.
    if (idx.reachedKeys) {
        for (const token of done) if (idx.reachedKeys.has(token)) { bumpVis(idx); break; }
    }
}

function ensureIndex(bot) {
    let idx = perceivedIndex.get(bot);
    if (idx) return idx;
    if (!bot.world || typeof bot.world.on !== 'function') {
        throw new Error('nearby blocks: bot.world.on is missing. chunkColumnLoad, chunkColumnUnload, and blockUpdate are forwarded on the world (mineflayer lib/plugins/blocks.js forwardedEvents).');
    }
    idx = {
        columns: new Map(), queue: [], pending: new Set(), drain: [], pumping: false,
        cellReads: 0, sectionsBuilt: 0, sectionsSkipped: 0, builds: 0, buildMs: 0, open: new Map(),
        visGen: 0, vis: null, reachedKeys: new Set(),
    };
    perceivedIndex.set(bot, idx);
    bot.world.on('chunkColumnLoad', corner => onColumnLoad(bot, idx, corner));
    bot.world.on('chunkColumnUnload', corner => onColumnUnload(bot, idx, corner));
    bot.world.on('blockUpdate', (oldBlock, newBlock) => onBlockUpdate(bot, idx, oldBlock, newBlock));
    return idx;
}

export function indexPerceivedChunks(bot) {
    /**
     * Index exposed faces of loaded chunks in the server view. One chunk yields to the event loop before the next.
     * @param {Bot} bot - The bot.
     * @returns {Promise<object>} - chunks built, total build ms, cell reads, and per-chunk ms.
     * @example
     * let built = await world.indexPerceivedChunks(bot);
     **/
    const idx = ensureIndex(bot);
    const ctx = viewContext(bot);
    if (!ctx.columns.has(standingKey(ctx))) return Promise.reject(missingStanding(ctx));
    syncView(bot, idx, ctx);
    if (!idx.queue.length && !idx.pumping) return Promise.resolve(indexReport(idx));
    return new Promise((resolve, reject) => {
        idx.drain.push({ resolve, reject });
        scheduleIndex(bot, idx);
    });
}

export function perceivedBuildStats(bot) {
    /**
     * Cost of the exposed-face index. This is the one-time build, not a step.
     * @param {Bot} bot - The bot.
     * @returns {object} - chunks, ms, cellReads, sectionsBuilt, perChunkMs.
     * @example
     * let cost = world.perceivedBuildStats(bot);
     **/
    const idx = perceivedIndex.get(bot);
    if (!idx) throw new Error('perceivedBuildStats: the exposed index has not been built for this bot');
    return indexReport(idx);
}

export function perceivedViewColumns(bot) {
    const idx = perceivedIndex.get(bot);
    if (!idx) throw new Error('perceivedViewColumns: the exposed index has not been built for this bot');
    const ctx = viewContext(bot);
    const rows = [];
    for (const key of ctx.columns.keys()) {
        const parts = key.split(',');
        const cx = Number(parts[0]);
        const cz = Number(parts[1]);
        if (!inView(ctx, cx, cz)) continue;
        rows.push({ cx, cz, indexed: idx.columns.has(key), pending: idx.pending.has(key) });
    }
    return rows;
}

function componentFaces(sec, localIndex) {
    if (sec.reach) return sec.reach[localIndex];
    if (connClosed(sec.conn)) return 0;
    return ALL_FACES;
}

function reachedSections(ctx, idx) {
    const stoodKey = standingKey(ctx);
    const stood = ctx.columns.get(stoodKey);
    const built = idx.columns.get(stoodKey);
    if (!stood || !built) throw missingStanding(ctx);
    const column = stood.column;
    const si = (Math.floor(ctx.eye.y) - column.minY) >> 4;
    if (!Number.isInteger(column.minY) || si < 0 || si >= column.sections.length || !built.sections[si]) {
        throw new Error(`nearby blocks: the eye at y ${ctx.eye.y} is outside the indexed sections of chunk ${ctx.stoodX},${ctx.stoodZ}.`);
    }
    const originX = ctx.stoodX * CHUNK_WIDTH;
    const originY = column.minY + si * SECTION_HEIGHT;
    const originZ = ctx.stoodZ * CHUNK_WIDTH;
    const lx = Math.floor(ctx.eye.x) - originX;
    const ly = Math.floor(ctx.eye.y) - originY;
    const lz = Math.floor(ctx.eye.z) - originZ;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= CHUNK_WIDTH || ly >= SECTION_HEIGHT || lz >= CHUNK_WIDTH) {
        throw new Error(`nearby blocks: the eye (${ctx.eye.x}, ${ctx.eye.y}, ${ctx.eye.z}) is not inside its section.`);
    }
    const exits = componentFaces(built.sections[si], (ly << 8) | (lz << 4) | lx);
    const queue = [{ cx: ctx.stoodX, cz: ctx.stoodZ, si, entry: -1, exits }];
    const seen = new Set([built.sections[si]]);
    const reached = [];
    for (let q = 0; q < queue.length; q++) {
        const cur = queue[q];
        const key = `${cur.cx},${cur.cz}`;
        const rec = idx.columns.get(key);
        const col = ctx.columns.get(key);
        const sec = rec && rec.sections[cur.si];
        if (!sec || !col) continue;
        const secOriginY = col.column.minY + cur.si * SECTION_HEIGHT;
        const secOriginX = cur.cx * CHUNK_WIDTH;
        const secOriginZ = cur.cz * CHUNK_WIDTH;
        reached.push({ sec, originX: secOriginX, originY: secOriginY, originZ: secOriginZ, cx: cur.cx, cz: cur.cz, si: cur.si });
        for (let face = 0; face < FACE_COUNT; face++) {
            if (cur.entry < 0) {
                if ((cur.exits & (1 << face)) === 0) continue;
            } else if (!connects(sec.conn, cur.entry, face)) continue;
            if (!facesAway(ctx.eye, secOriginX, secOriginY, secOriginZ, face)) continue;
            const [fx, fy, fz] = FACES[face];
            const ncx = cur.cx + fx;
            const ncz = cur.cz + fz;
            const nsi = cur.si + fy;
            if (fx !== 0 || fz !== 0) {
                if (!inView(ctx, ncx, ncz)) continue;
            }
            const nkey = `${ncx},${ncz}`;
            const ncol = ctx.columns.get(nkey);
            const nbuilt = idx.columns.get(nkey);
            if (!ncol || !nbuilt || !Array.isArray(ncol.column.sections)) continue;
            if (nsi < 0 || nsi >= ncol.column.sections.length || !nbuilt.sections[nsi]) continue;
            const nsec = nbuilt.sections[nsi];
            if (seen.has(nsec)) continue;
            seen.add(nsec);
            queue.push({ cx: ncx, cz: ncz, si: nsi, entry: face ^ 1, exits: 0 });
        }
    }
    return reached;
}

// A column that is not loaded is not on this ray. stateAt still throws when a loaded in-view column is asked
// for and missing; the caller only asks stateAt once the column is in the loaded set.
function rayState(ctx, x, y, z) {
    const cx = Math.floor(x / CHUNK_WIDTH), cz = Math.floor(z / CHUNK_WIDTH);
    if (Math.abs(cx - ctx.view.stoodX) > ctx.view.radius || Math.abs(cz - ctx.view.stoodZ) > ctx.view.radius) return null;
    if (!ctx.columns.has(`${cx},${cz}`)) return null;
    return stateAt(ctx.columns, x, y, z, ctx.view);
}

// Amanatides & Woo, "A Fast Voxel Traversal Algorithm for Ray Tracing" (Eurographics 1987,
// http://www.cse.yorku.ca/~amana/research/grid.pdf). The ray is parameterized so t = 1 is the face center.
// The target cell is a hit even when that cell does not occlude. The first other occluding cell is a miss.
function ddaHit(ctx, idx, eye, cell, point) {
    let x = Math.floor(eye.x), y = Math.floor(eye.y), z = Math.floor(eye.z);
    let steps = 0;
    if (x === cell.x && y === cell.y && z === cell.z) return { hit: true, steps };
    const dx = point.x - eye.x, dy = point.y - eye.y, dz = point.z - eye.z;
    const stepX = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
    const stepY = dy === 0 ? 0 : (dy > 0 ? 1 : -1);
    const stepZ = dz === 0 ? 0 : (dz > 0 ? 1 : -1);
    const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dz);
    let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? (Math.floor(eye.x) + 1 - eye.x) / dx : (Math.floor(eye.x) - eye.x) / dx);
    let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? (Math.floor(eye.y) + 1 - eye.y) / dy : (Math.floor(eye.y) - eye.y) / dy);
    let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? (Math.floor(eye.z) + 1 - eye.z) / dz : (Math.floor(eye.z) - eye.z) / dz);
    while (true) {
        if (x === cell.x && y === cell.y && z === cell.z) return { hit: true, steps };
        const id = rayState(ctx, x, y, z);
        if (id === null || !nonOccluding(ctx.registry, id, idx.open)) return { hit: false, steps };
        const xFirst = tMaxX <= tMaxY && tMaxX <= tMaxZ;
        const yFirst = !xFirst && tMaxY <= tMaxZ;
        const tNext = xFirst ? tMaxX : yFirst ? tMaxY : tMaxZ;
        // t = 1 is the face center, which lies on the target cell's face (Amanatides & Woo). Accumulated
        // boundary times can land a fraction past 1 while the walk is still in the air cell beside that face.
        // The cell across the boundary is the target, so that face counts.
        if (tNext > 1) {
            const nx = x + (xFirst ? stepX : 0);
            const ny = y + (yFirst ? stepY : 0);
            const nz = z + (!xFirst && !yFirst ? stepZ : 0);
            return { hit: nx === cell.x && ny === cell.y && nz === cell.z, steps };
        }
        if (xFirst) { x += stepX; tMaxX += tDeltaX; }
        else if (yFirst) { y += stepY; tMaxY += tDeltaY; }
        else { z += stepZ; tMaxZ += tDeltaZ; }
        steps += 1;
    }
}

// The walk is a function of the eye's block and the states in the sections the visibility BFS can enter.
// A move inside that block does not change the origin cell, so the key is the cell, not the point inside it.
// visGen changes when a reached section is reindexed or the indexed columns change, which is the other half:
// the same cell after a dig is a different walk. Either half alone is wrong.
function visKey(ctx, idx) {
    const eye = ctx.eye;
    return `${Math.floor(eye.x)},${Math.floor(eye.y)},${Math.floor(eye.z)},${idx.visGen}`;
}

function confirmVisible(ctx, idx, onlyName) {
    const key = visKey(ctx, idx);
    if (idx.vis && idx.vis.key === key) {
        if (onlyName) {
            const hit = idx.vis.found.find(b => b.name === onlyName);
            return { position: hit ? { x: hit.x, y: hit.y, z: hit.z } : null, raycasts: 0, ddaRays: 0, ddaSteps: 0, candidates: 0, sectionsReached: idx.vis.sectionsReached };
        }
        return { found: idx.vis.found, raycasts: 0, ddaRays: 0, ddaSteps: 0, candidates: 0, sectionsReached: idx.vis.sectionsReached };
    }
    const eye = ctx.eye;
    const confirmed = new Set();
    const found = [];
    let candidates = 0;
    let ddaRays = 0;
    let ddaSteps = 0;
    const wants = (id) => {
        const block = ctx.registry.blocksByStateId[id];
        if (!block || typeof block.name !== 'string') throw new Error(`nearby blocks: state id ${id} is not in the registry`);
        if (onlyName) return block.name === onlyName;
        return !confirmed.has(id);
    };
    const reached = reachedSections(ctx, idx);
    const reachedKeys = new Set();
    for (const node of reached) reachedKeys.add(`${node.cx},${node.cz}:${node.si}`);
    idx.reachedKeys = reachedKeys;
    const halfX = CHUNK_WIDTH / 2;
    const halfY = SECTION_HEIGHT / 2;
    reached.sort((a, b) => dist2(eye.x, eye.y, eye.z, a.originX + halfX, a.originY + halfY, a.originZ + halfX)
        - dist2(eye.x, eye.y, eye.z, b.originX + halfX, b.originY + halfY, b.originZ + halfX));
    let foundAt = null;
    for (const node of reached) {
        if (foundAt) break;
        const sec = node.sec;
        let pending = false;
        for (const id of sec.states) if (wants(id)) pending = true;
        if (!pending) continue;
        const facing = [];
        for (const cell of sec.cells.values()) {
            if (!wants(cell.id)) continue;
            for (let face = 0; face < FACE_COUNT; face++) {
                if ((cell.mask & (1 << face)) === 0) continue;
                if (!faceLooksAtEye(eye, cell, face)) continue;
                const [fx, fy, fz] = FACES[face];
                const point = { x: cell.x + 0.5 + fx * 0.5, y: cell.y + 0.5 + fy * 0.5, z: cell.z + 0.5 + fz * 0.5 };
                facing.push({ cell, point, d: dist2(eye.x, eye.y, eye.z, point.x, point.y, point.z) });
            }
        }
        facing.sort((a, b) => a.d - b.d);
        candidates += facing.length;
        for (const item of facing) {
            if (!wants(item.cell.id)) continue;
            if (!(item.d > 0)) continue;
            ddaRays += 1;
            const walk = ddaHit(ctx, idx, eye, item.cell, item.point);
            ddaSteps += walk.steps;
            if (!walk.hit) continue;
            const cell = item.cell;
            if (onlyName) { foundAt = { x: cell.x, y: cell.y, z: cell.z }; break; }
            confirmed.add(cell.id);
            const block = ctx.registry.blocksByStateId[cell.id];
            found.push({ name: block.name, metadata: block.metadata, x: cell.x, y: cell.y, z: cell.z });
        }
    }
    if (!onlyName) idx.vis = { key, found, candidates, sectionsReached: reached.length };
    if (onlyName) return { position: foundAt, raycasts: 0, ddaRays, ddaSteps, candidates, sectionsReached: reached.length };
    return { found, raycasts: 0, ddaRays, ddaSteps, candidates, sectionsReached: reached.length };
}

function indexNote(idx, ctx) {
    let loaded = 0;
    let indexed = 0;
    for (const key of ctx.columns.keys()) {
        const [cx, cz] = key.split(',').map(Number);
        if (!inView(ctx, cx, cz)) continue;
        loaded += 1;
        if (idx.columns.has(key)) indexed += 1;
    }
    const phrase = indexed === loaded ? 'index complete' : 'index incomplete';
    return `${phrase}, ${indexed} of ${loaded} chunks`;
}

function perceivedBlocks(bot) {
    const ctx = viewContext(bot);
    if (!ctx.columns.has(standingKey(ctx))) throw missingStanding(ctx);
    const idx = ensureIndex(bot);
    dropOutsideView(idx, ctx);
    if (!idx.columns.has(standingKey(ctx))) buildColumn(idx, ctx, ctx.stoodX, ctx.stoodZ);
    syncView(bot, idx, ctx);
    const seen = confirmVisible(ctx, idx, null);
    perceivedStat.set(bot, {
        cellReads: 0, candidates: seen.candidates, raycasts: seen.raycasts, ddaRays: seen.ddaRays, ddaSteps: seen.ddaSteps,
        sectionsRead: 0, sectionsSkipped: 0, sectionsReached: seen.sectionsReached, indexNote: indexNote(idx, ctx),
    });
    return seen.found;
}

export async function perceivedPosition(bot, name) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('perceivedPosition: a block name is required.');
    await indexPerceivedChunks(bot);
    const ctx = viewContext(bot);
    const idx = perceivedIndex.get(bot);
    if (!idx || !idx.columns.has(standingKey(ctx))) throw missingStanding(ctx);
    const seen = confirmVisible(ctx, idx, name);
    return seen.position;
}

export function perceivedStats(bot) {
    const stats = perceivedStat.get(bot);
    if (!stats) throw new Error('perceivedStats: no scan has run for this bot');
    return stats;
}

export function getNearbyBlocks(bot) {
    /**
     * One confirmed visible instance of each block state the bot can see.
     * Loaded, inside the server view distance, a face open to a non-occluding block, and a voxel walk of block states hits it.
     * @param {Bot} bot - The bot. The scan does not take a radius.
     * @returns {Block[]} - name, metadata, and the block position of that instance.
     * @example
     * let blocks = world.getNearbyBlocks(bot);
     **/
    return perceivedBlocks(bot);
}

export function getNearbyBlockTypes(bot) {
    /**
     * Block names the bot can see. Same scan as getNearbyBlocks. It does not take a radius.
     * @param {Bot} bot - The bot.
     * @returns {string[]} - One name per confirmed visible state.
     * @example
     * let blocks = world.getNearbyBlockTypes(bot);
     **/
    const names = [];
    for (const block of perceivedBlocks(bot)) if (!names.includes(block.name)) names.push(block.name);
    return names;
}

export async function isClearPath(bot, target) {
    /**
     * Check if there is a path to the target that requires no digging or placing blocks.
     * @param {Bot} bot - The bot to get the path for.
     * @param {Entity} target - The target to path to.
     * @returns {boolean} - True if there is a clear path, false otherwise.
     */
    let movements = new pf.Movements(bot)
    movements.canDig = false;
    movements.canPlaceOn = false;
    movements.canOpenDoors = false;
    let goal = new pf.goals.GoalNear(target.position.x, target.position.y, target.position.z, 1);
    let path = await bot.pathfinder.getPathTo(movements, goal, 100);
    return path.status === 'success';
}

export function shouldPlaceTorch(bot) {
    if (!bot.modes.isOn('torch_placing') || bot.interrupt_code) return false;
    const pos = getPosition(bot);
    // TODO: check light level instead of nearby torches, block.light is broken
    let nearest_torch = getNearestBlock(bot, 'torch', 6);
    if (!nearest_torch)
        nearest_torch = getNearestBlock(bot, 'wall_torch', 6);
    if (!nearest_torch) {
        const block = bot.blockAt(pos);
        let has_torch = bot.inventory.findInventoryItem('torch');
        return has_torch && block?.name === 'air';
    }
    return false;
}

export function getBiomeName(bot) {
    /**
     * Get the name of the biome the bot is in.
     * @param {Bot} bot - The bot to get the biome for.
     * @returns {string} - The name of the biome.
     * @example
     * let biome = world.getBiomeName(bot);
     **/
    const biomeId = bot.world.getBiome(bot.entity.position);
    const biome = mc.getAllBiomes()[biomeId]; return biome ? biome.name : `unknown_biome_${biomeId}`;
}
