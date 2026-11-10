import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import * as mc from '../../utils/mcdata.js';
import { carriedSlots } from '../../utils/carried.js';
import { itemSourceBlocks } from '../../utils/item_sources.js';


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
        const hint = fn === 'getNearbyBlocks' || fn === 'getNearbyBlockTypes'
            ? `${fn}(bot, distance) takes a radius in blocks, not a list of block names. Named blocks: getNearestBlocks(bot, block_types, distance, count).`
            : 'distance and count are numbers. Block names go in block_types (getNearestBlocks) or the predicate (getNearestBlocksWhere), not in the distance. bot.findBlocks({ matching, maxDistance, count }): matching is a block id, an array of block ids, or a function; maxDistance and count are finite numbers.';
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


// Positions inside the cube of half-extent `distance` (the radius the caller passed). This replaces the old
// count default of 10000, which was not the size of any search.
function positionsWithin(distance) {
    const span = Math.floor(distance) * 2 + 1;
    return span * span * span;
}

// A chunk is 16 blocks on a side (https://minecraft.wiki/w/Chunk). The nearby-block listing is that radius.
// Callers pass it. getNearbyBlocks and getNearbyBlockTypes have no default.
export const NEARBY_BLOCK_RADIUS = 16;

export function getNearbyBlocks(bot, distance) {
    /**
     * Blocks around the bot, every position inside the given radius.
     * @param {Bot} bot - The bot to get nearby blocks for.
     * @param {number} distance - Radius in blocks. A finite number. Not a list of block names.
     * @returns {Block[]} - Blocks within that radius.
     * @example
     * let blocks = world.getNearbyBlocks(bot, 16);
     **/
    requireScanNumber('getNearbyBlocks', 'distance', distance);
    return getNearestBlocks(bot, null, distance, positionsWithin(distance));
}

export function getNearbyBlockTypes(bot, distance) {
    /**
     * Get a list of all nearby block names.
     * @param {Bot} bot - The bot to get nearby blocks for.
     * @param {number} distance - Radius in blocks. A finite number. Not a list of block names.
     * @returns {string[]} - A list of all nearby blocks.
     * @example
     * let blocks = world.getNearbyBlockTypes(bot, 16);
     **/
    requireScanNumber('getNearbyBlockTypes', 'distance', distance);
    let blocks = getNearbyBlocks(bot, distance);
    let found = [];
    for (let i = 0; i < blocks.length; i++) {
        if (!found.includes(blocks[i].name)) {
            found.push(blocks[i].name);
        }
    }
    return found;
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
