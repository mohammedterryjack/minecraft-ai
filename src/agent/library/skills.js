import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";
import { watchPathing } from "../../utils/movement_model.js";
import { findCarried } from "../../utils/carried.js";
import { markPreconditionUnmet, markBlockOutOfRange } from "../precondition.js";
import { emptySlotsToFit, stackableCounts } from "../slot_room.js";
import { itemSourceBlocks } from "../../utils/item_sources.js";

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

// fix46: Minecraft standard max vitals - single source shared by observe() and log()
// Vanilla Minecraft uses 20 for both health and food max; mods may differ
export const VITALS_MAX = { health: 20, food: 20 };
let _vitalsMaxWarned = false;

// fix46: get vitals max, log loudly once if bot reports different values
export function getVitalsMax(bot) {
    const botHealthMax = bot.game?.maxHealth;
    const botFoodMax = bot.game?.maxFood;
    if (!_vitalsMaxWarned && (botHealthMax && botHealthMax !== VITALS_MAX.health || botFoodMax && botFoodMax !== VITALS_MAX.food)) {
        console.log(`[fix46] LOUD: bot reports non-standard vitals max (health=${botHealthMax}, food=${botFoodMax}) vs standard (${VITALS_MAX.health}, ${VITALS_MAX.food})`);
        _vitalsMaxWarned = true;
    }
    return VITALS_MAX;
}

// fix46: log vitals (food and health) on every log line for recovery tracking
// Uses shared VITALS_MAX constant (same source as observe())
export function log(bot, message) {
    let vitals = '';
    if (typeof bot.food === 'number' && typeof bot.health === 'number') {
        const max = getVitalsMax(bot);
        vitals = ` [food ${bot.food}/${max.food} health ${Math.round(bot.health)}/${max.health}]`;
    }
    bot.output += message + vitals + '\n';
}

// fix44: close any non-inventory window before equip/consume operations
// Open crafting_table / furnace / chest windows block equip() and consume()
async function ensureInventoryWindowClosed(bot) {
    const win = bot.currentWindow;
    if (win && win.type !== 'minecraft:inventory' && win.type !== 'minecraft:crafting') {
        try {
            await bot.closeWindow(win);
            await new Promise(r => setTimeout(r, 100));
        } catch (e) {
            console.log(`[fix44] closeWindow failed (non-fatal): ${e.message}`);
        }
    }
}

// fix44: simple async mutex for serializing equip/consume/clickWindow operations
// Prevents interleaving that causes Window.acceptClick invalid operation errors
let _invMutexQueue = Promise.resolve();
async function withInventoryMutex(bot, label, fn) {
    let release;
    const prev = _invMutexQueue;
    _invMutexQueue = new Promise(r => release = r);
    try {
        await prev;
    } catch (e) { /* previous error doesn't block us */ }
    try {
        return await fn();
    } finally {
        release();
    }
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => b.attackDamage - a.attackDamage);
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

export async function craftRecipe(bot, itemName, num=1) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if (mc.getItemCraftingRecipes(itemName).length == 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null); 
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // fix42: Try to place crafting table with retry on multiple cells (no same-cell reuse)
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                const freeSpaces = world.getAllFreeSpaces(bot, 1, 6, 5);
                if (!freeSpaces.length) {
                    log(bot, `FAILED: no free space within 6 blocks to place crafting_table`);
                    return false;
                }
                let placed = false;
                const tried = [];
                for (const pos of freeSpaces) {
                    tried.push(`(${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)})`);
                    const ok = await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                    // fix42: verify block state directly (fail loud if place returns true but block is not there)
                    await new Promise(r => setTimeout(r, 150));
                    const check = bot.blockAt(pos.floored ? pos.floored() : pos);
                    if (ok && check && check.name === 'crafting_table') {
                        placed = true;
                        break;
                    }
                    if (!ok) console.log(`[craftRecipe] placeBlock failed at ${tried[tried.length - 1]}, trying next cell...`);
                    else console.log(`[craftRecipe] placeBlock returned true at ${tried[tried.length - 1]} but block is ${check?.name || 'null'}, trying next cell...`);
                }
                if (!placed) {
                    log(bot, `FAILED: could not place crafting_table at any of ${tried.length} free space(s) tried: ${tried.join(', ')}`);
                    return false;
                }
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
                }
            }
            else {
                log(bot, `Crafting ${itemName} requires a crafting table.`)
                return false;
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${Object.entries(mc.getItemCraftingRecipes(itemName)[0][0]).map(([key, value]) => `${key}: ${value}`).join(', ')}.`);
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    if (craftingTable && !(await goToReachBlock(bot, craftingTable))) {
        if (placedTable) await collectBlock(bot, 'crafting_table', 1);
        return false;
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    const slotsNeeded = emptySlotsToFit(bot.registry, stackableCounts(bot), itemName, 1);
    if (slotsNeeded > 0 && Array.isArray(bot.__capacityPlan) && bot.__capacityPlan.length > 0) {
        console.log(`[craftRecipe] ${itemName} needs ${slotsNeeded} empty slot(s); applying the capacity plan`);
        const freed = await _freeInventory(bot, slotsNeeded, bot.__capacityPlan);
        if (freed === false) {
            const still = emptySlotsToFit(bot.registry, stackableCounts(bot), itemName, 1);
            if (still > 0) {
                log(bot, `FAILED: Cannot craft ${itemName}: the capacity plan did not free a slot.`);
                return false;
            }
        }
    }
    const beforeCount = world.getInventoryCounts(bot)[itemName] || 0;
    let craftErr = null;
    await Promise.race([bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable),
        new Promise((_, rej) => setTimeout(() => rej(new Error('bot.craft timed out after 15s (no server slot update)')), 15000))]).catch(e => { craftErr = e; });
    if (craftErr) {
        // fix69: close the window the failed craft left open (the timeout branch leaves bot.craft's table window open;
        // its own error path closes it). With no window open there is nothing to close: the player inventory is not a
        // window to close, and closing it (the old `|| bot.inventory`) emitted a spurious windowClose and, before
        // stateId versions, a click at slot -999 that drops the cursor item. mineflayer's closeWindow throws only on a
        // null window, which the check rules out, so it is not wrapped.
        if (bot.currentWindow) {
            console.log(`[craftRecipe] closing ${bot.currentWindow.type} (id ${bot.currentWindow.id}) left open by the failed craft: ${craftErr.message}`);
            await bot.closeWindow(bot.currentWindow);
        } else {
            console.log(`[craftRecipe] no window open after the failed craft (${craftErr.message}); nothing to close`);
        }
        await new Promise(r => setTimeout(r, 1000));   // let the server resend inventory, then trust only that
        const nowCount = world.getInventoryCounts(bot)[itemName] || 0;
        if (nowCount <= beforeCount) { log(bot, `Crafting ${itemName} FAILED: ${craftErr.message}`); return false; }
        log(bot, `bot.craft reported "${craftErr.message}" but the server inventory shows ${nowCount} ${itemName} (was ${beforeCount}); counting as crafted.`);
    }
    if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    if (placedTable) {
        await collectBlock(bot, 'crafting_table', 1);
    }

    // fix27: no auto-equip after crafting; equipping armour is learned

    return true;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // fix42: Try to place furnace with retry on multiple cells (consistent with craftRecipe)
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            const freeSpaces = world.getAllFreeSpaces(bot, 1, furnaceRange, 5);
            if (!freeSpaces.length) {
                log(bot, `FAILED: no free space within ${furnaceRange} blocks to place furnace`);
                return false;
            }
            let placed = false;
            const tried = [];
            for (const pos of freeSpaces) {
                tried.push(`(${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)})`);
                const ok = await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
                await new Promise(r => setTimeout(r, 150));
                const check = bot.blockAt(pos.floored ? pos.floored() : pos);
                if (ok && check && check.name === 'furnace') {
                    placed = true;
                    placedFurnace = true;
                    break;
                }
                if (!ok) console.log(`[smeltItem] placeBlock failed at ${tried[tried.length - 1]}, trying next cell...`);
            }
            if (!placed) {
                log(bot, `FAILED: could not place furnace at any of ${tried.length} free space(s) tried: ${tried.join(', ')}`);
                return false;
            }
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`)
        return false;
    }
    if (!(await goToReachBlock(bot, furnaceBlock))) return false;
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`)
    }
    // put the items in the furnace
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (!(await goToReachBlock(bot, furnaceBlock))) return false;

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        await bot.attack(entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
    while (enemy) {
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await bot.pathfinder.goto(inverted_goal, true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}




// fix92: toss the caller's whole-slot plan. slotsNeeded is how many empty slots must be gained.
// Success is emptySlotCount increasing by at least that many. An item-count drop that frees no slot returns false.
export async function _freeInventory(bot, slotsNeeded, plan) {
    if (!Number.isInteger(slotsNeeded) || slotsNeeded < 1) throw new Error('[_freeInventory] slotsNeeded must be a positive integer, got ' + JSON.stringify(slotsNeeded));
    if (!Array.isArray(plan) || plan.length < 1) throw new Error('[_freeInventory] plan must list removals, got ' + JSON.stringify(plan));
    const before = bot.inventory.emptySlotCount();
    if (!Number.isInteger(before) || before < 0) throw new Error('[_freeInventory] emptySlotCount is not a non-negative integer');
    for (const row of plan) {
        if (bot.interrupt_code) return false;
        if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('[_freeInventory] removal is not an object: ' + JSON.stringify(row));
        if (typeof row.item !== 'string' || !Number.isInteger(row.remove) || row.remove < 1) throw new Error('[_freeInventory] removal needs item and a positive remove: ' + JSON.stringify(row));
        if (!Number.isInteger(row.keep) || row.keep < 0) throw new Error('[_freeInventory] removal keep is not a non-negative integer: ' + JSON.stringify(row));
        const regItem = bot.registry.itemsByName[row.item];
        if (!regItem) throw new Error('[_freeInventory] ' + row.item + ' is not an item in the game data');
        const stacks = [];
        for (const x of bot.inventory.items()) if (x.name === row.item) stacks.push(x);
        let held = 0;
        for (const x of stacks) held += x.count;
        if (held < row.remove + row.keep) throw new Error('[_freeInventory] stale plan for ' + row.item + '; held ' + held + ', remove ' + row.remove + ', keep ' + row.keep);
        await bot.toss(stacks[0].type, null, row.remove);
    }
    const after = bot.inventory.emptySlotCount();
    if (!Number.isInteger(after) || after < 0) throw new Error('[_freeInventory] emptySlotCount after the toss is not a non-negative integer');
    const actual = after - before;
    console.log('[slot] verified empty_before=' + before + ' empty_after=' + after + ' actual_freed=' + actual);
    if (actual < slotsNeeded) return false;
    return actual;
}

// fix84: the item a broken block adds to the inventory, from the game data. null when the block drops nothing.
function _blockDropName(bot, block) {
    if (!bot.registry || !bot.registry.blocksByName || !bot.registry.blocksByName[block.name]) throw new Error(`collectBlock: ${block.name} is not a block in the game data`);
    const drops = bot.registry.blocksByName[block.name].drops;
    if (!Array.isArray(drops)) throw new Error(`collectBlock: ${block.name} has no drops list in the game data`);
    if (drops.length === 0) return null;
    const dropId = drops[0];
    const id = typeof dropId === 'number' ? dropId : dropId.drop.id;
    const item = bot.registry.items[id];
    if (!item) throw new Error(`collectBlock: drop ${JSON.stringify(dropId)} of ${block.name} is not an item`);
    return item.name;
}

function _survivalMovements(bot, {dig = true} = {}) {
    const m = new pf.Movements(bot);
    m.canDig = dig;
    m.canOpenDoors = true;
    m.allowParkour = true;
    m.allowSprinting = true;
    m.allow1by1towers = true;
    m.dontCreateFlow = true;
    const reg = bot.registry;
    m.scafoldingBlocks = ['dirt','cobblestone','cobbled_deepslate','netherrack','andesite','diorite','granite','tuff','birch_planks','oak_planks','spruce_planks']
        .map(n => reg.itemsByName[n]?.id).filter(id => id != null);
    return m;
}

// fix60: a block is usable when a ray from the bot's eye reaches one of its faces within game.reach
// (https://minecraft.wiki/w/Player#Reach). The eye height is the bot's own. The walk goal is GoalLookAtBlock
// with that reach, so the path ends where the same check passes.
function _faceInReach(world, eye, pos, reach) {
    for (const [dx, dy, dz] of [[0.5, 0, 0], [-0.5, 0, 0], [0, 0.5, 0], [0, -0.5, 0], [0, 0, 0.5], [0, 0, -0.5]]) {
        const face = pos.offset(0.5 + dx, 0.5 + dy, 0.5 + dz);
        if (eye.distanceTo(face) > reach) continue;
        const hit = world.raycast(eye, face.minus(eye).normalize(), reach);
        if (hit && hit.position.equals(pos)) return true;
    }
    return false;
}
class GoalSeeAndReachBlock extends pf.goals.GoalLookAtBlock {
    isEnd(node) { return _faceInReach(this.world, new Vec3(node.x + 0.5, node.y + this.entityHeight, node.z + 0.5), this.pos, this.reach); }
}
function _lookAtGoal(bot, block) {
    return new GoalSeeAndReachBlock(block.position, bot.world, { entityHeight: bot.entity.eyeHeight, reach: world.gameReach(bot) });
}
function outOfReach(bot, pos) {
    return !world.withinInteractionRange(bot, pos);
}
export function canReachBlock(bot, block) {
    /**
     * True when the bot can see and reach a face of the block from where it stands (game reach, real eye position).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Block} block, the block to check.
     * @returns {boolean}
     **/
    return _faceInReach(bot.world, bot.entity.position.offset(0, bot.entity.eyeHeight, 0), block.position, _lookAtGoal(bot, block).reach);
}
export async function goToReachBlock(bot, block) {
    /**
     * Walk to a spot from which the bot can see and reach the block (to open, use, craft at, or place against it).
     * Fails loudly (FAILED line, returns false) when no such spot is reachable.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Block} block, the block to reach.
     * @returns {Promise<boolean>} true when the block is in sight and reach.
     * @example
     * await skills.goToReachBlock(bot, world.getNearestBlock(bot, 'crafting_table', 16));
     **/
    if (!block) { log(bot, `FAILED: goToReachBlock: no block given`); return false; }
    if (canReachBlock(bot, block)) return true;
    const reached = await goToGoal(bot, _lookAtGoal(bot, block));
    if (reached && canReachBlock(bot, block)) return true;
    const pos = bot.entity.position;
    log(bot, `FAILED: no reachable spot with line of sight to ${block.name} at ${block.position} (bot at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}; path ${reached ? 'ended without sight' : 'not found'})`);
    return false;
}

async function _reachBlock(bot, block) {
    return goToReachBlock(bot, block);
}

export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (typeof blockType !== 'string' || !blockType) {
        throw new Error(`collectBlock: blockType must be a block name string like "oak_log", got ${blockType}. Check the variable is defined (e.g. a world.getNearestBlock result may be null).`);
    }
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    // fix95: an item name that is not a block (wheat_seeds, apple) is collected from the blocks whose loot yields it
    //        (game data). Before, it matched no block and returned false with no I/O, so a retry loop spun the event loop.
    let blocktypes = Object.hasOwn(bot.registry.blocksByName, blockType) ? [blockType] : itemSourceBlocks(bot.registry, blockType);
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    if (blocktypes.length === 0) throw new Error(`collectBlock: ${JSON.stringify(blockType)} is not a block in the game data and no block drops it; obtain it another way (craft, smelt, or a mob drop)`);
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    const movements = new pf.Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    for (let i=0; i<num; i++) {
        let blocks = world.getNearestBlocksWhere(bot, block => {
            // fix86: the same palette probe as the seeded collectBlock. position is null until the block is placed.
            if (block.position === null) return blocktypes.includes(block.name);
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }
            
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 1);

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
        const dropName = _blockDropName(bot, block);
        await equipToolForBlock(bot, block);   // fix62: cheapest tool that works (mineflayer-tool equipForBlock sorts by dig time = top tier)
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
        // fix84: a full inventory is a structured slot need (the same marker as a missing chest), not a toss-in-place
        if (dropName !== null && world.roomForItem(bot, dropName) < 1) {
            markPreconditionUnmet(bot, { need: { item: dropName, count: num - collected, reason: 'slot' } });
            log(bot, `PREREQUISITE FAILED: no free slot for ${dropName}.`);
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await bot.dig(block);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                const before = world.getInventoryCounts(bot);
                bot.collectBlock.movements = _survivalMovements(bot);
                await bot.collectBlock.collect(block);
                await pickupNearbyItems(bot);
                const after = world.getInventoryCounts(bot);
                success = Object.keys(after).some(k => (after[k] || 0) > (before[k] || 0));
                if (!success) log(bot, `Broke ${block.name} but no drop reached the inventory.`);
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                if (dropName === null) throw new Error(`collectBlock: inventory refused ${block.name}, which drops nothing`);
                markPreconditionUnmet(bot, { need: { item: dropName, count: num - collected, reason: 'slot' } });
                log(bot, `PREREQUISITE FAILED: no free slot for ${dropName}.`);
                return false;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = () => bot.nearestEntity(entity => entity.name === 'item' && entity.isValid && bot.entity.position.distanceTo(entity.position) < distance);
    let nearestItem = getNearestItem();
    let pickedUp = 0;
    while (nearestItem) {
        // fix84: the drop names its item; no room is a slot need, the same marker collectBlock uses
        if (typeof nearestItem.getDroppedItem !== 'function') throw new Error('pickupNearbyItems: dropped item entity has no getDroppedItem()');
        const dropped = nearestItem.getDroppedItem();
        if (dropped === null || typeof dropped !== 'object' || typeof dropped.name !== 'string' || !Number.isInteger(dropped.count) || dropped.count < 1) throw new Error(`pickupNearbyItems: dropped entity has no item: ${JSON.stringify(dropped)}`);
        if (world.roomForItem(bot, dropped.name) < 1) {
            markPreconditionUnmet(bot, { need: { item: dropped.name, count: dropped.count, reason: 'slot' } });
            log(bot, `PREREQUISITE FAILED: no free slot for ${dropped.count} ${dropped.name}.`);
            return false;
        }
        // fix97: follow the live entity (GoalFollow). Progress is playerCollect, the entity going invalid, or an
        // inventory gain. A path that leaves the same entity on the ground is no progress: stop, do not sleep and retry.
        let collected = false;
        const onCollect = (_who, entity) => { if (entity === nearestItem) collected = true; };
        bot.on('playerCollect', onCollect);
        if (typeof nearestItem.width !== 'number') throw new Error('pickupNearbyItems: dropped item has no width');
        const followRange = nearestItem.width;
        let reached;
        try {
            bot.pathfinder.setMovements(_survivalMovements(bot, {dig: false}));
            reached = await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, followRange));
        } finally {
            bot.removeListener('playerCollect', onCollect);
        }
        if (!reached && bot.interrupt_code) {
            log(bot, `Picked up ${pickedUp} items before being interrupted.`);
            return false;
        }
        if (!nearestItem.isValid || collected) {
            pickedUp++;
            nearestItem = getNearestItem();
            continue;
        }
        log(bot, `No progress: dropped item is still on the ground and the inventory did not gain it.`);
        return false;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


export async function breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (outOfReach(bot, block.position)) {
            let pos = block.position;
            let movements = new pf.Movements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await equipToolForBlock(bot, block);   // fix62: cheapest tool that works (mineflayer-tool equipForBlock sorts by dig time = top tier)
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        await bot.dig(block, true);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        // fix51: door/bed multi-block placement must be inside braces (was missing, caused command spam)
        if (blockType.includes('door')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        }
        if (blockType.includes('bed')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        }
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        try { await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); } catch (e) { console.log('[creative] setInventorySlot not confirmed (ViaProxy):', e.message); await new Promise(r => setTimeout(r, 300)); } // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await bot.pathfinder.goto(inverted_goal);
    }
    if (outOfReach(bot, targetBlock.position)) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 3));
    }
    if (!bot.canSeeBlock(targetBlock) || outOfReach(bot, targetBlock.position)) await _reachBlock(bot, targetBlock);

    // fix42: place block with direct state verification (fail loud with clear reason)
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            // fix42: direct state verification (don't rely solely on blockUpdate timeout)
            await new Promise(resolve => setTimeout(resolve, 300));
            const check = bot.blockAt(target_dest);
            if (check && check.name === blockType) {
                log(bot, `Placed ${blockType} at ${target_dest}.`);
                return true;
            }
            // block not where expected - log clearly (fail loud)
            log(bot, `FAILED: placeBlock returned but ${blockType} not at ${target_dest} (found ${check?.name || 'null'})`);
            return false;
        }
    } catch (err) {
        // fix42: include error details in the failure message
        const errMsg = String(err?.message || err).slice(0, 100);
        log(bot, `FAILED to place ${blockType} at ${target_dest}: ${errMsg}`);
        return false;
    }
}

// fix62: per-block tool choice: the CHEAPEST inventory item that works on this block, from game data + live inventory (no tier list).
//   works       - block.harvestTools has it (required to get the drop) or, when nothing is required, its material speeds the dig up
//   capability  - how many registry blocks the item is required for (harvestTools), then how many it speeds up; a more capable
//                 tool spent on this block wears capability the block does not need (iron_pickaxe on iron_ore when stone also harvests it)
//   wear cost   - its recipe ingredients weighted by inventory scarcity 1/(1+have), per point of max durability (uncraftable: Infinity)
//   remaining   - durability left (item.durabilityUsed); among equals the more worn one is used up first
// Nothing works and nothing is required: the hand is emptied so an unrelated tool is not worn. Uses only bot + log so the seeded
// primitive is this exact source (Voyager.SEEDED_PRIMITIVES equipToolForBlock).
export async function equipToolForBlock(bot, block) {
    if (block === undefined || block === null) throw new Error('equipToolForBlock: block argument required');
    const reg = bot.registry;
    const speedsUp = (b, id) => !!(reg.materials[b.material] && reg.materials[b.material][id]);
    const works = id => block.harvestTools ? !!block.harvestTools[id] : speedsUp(block, id);
    const items = bot.inventory.items();
    const cands = items.filter(it => works(it.type));
    if (!cands.length) {
        if (block.harvestTools) { log(bot, `FAILED: no inventory tool can harvest ${block.name}`); return null; }
        if (bot.heldItem && reg.items[bot.heldItem.type].maxDurability) await bot.unequip('hand');
        return null;
    }
    const have = {};
    for (const it of items) have[it.type] = (have[it.type] || 0) + it.count;
    const harvests = id => reg.blocksArray.filter(b => b.harvestTools && b.harvestTools[id]).length;
    const speeds = id => reg.blocksArray.filter(b => speedsUp(b, id)).length;
    const ingredientId = x => (x !== null && typeof x === 'object') ? x.id : x;
    const replaceCost = id => {
        const rs = reg.recipes[id];
        if (!rs) return Infinity;
        return Math.min(...rs.map(r => (r.inShape ? r.inShape.flat() : r.ingredients).map(ingredientId).filter(x => x !== null)
            .reduce((sum, x) => sum + 1 / (1 + (have[x] || 0)), 0) / r.result.count));
    };
    const scored = cands.map(it => {
        const max = reg.items[it.type].maxDurability;
        if (!max) throw new Error(`equipToolForBlock: ${it.name} works on ${block.name} but has no maxDurability in the registry`);
        return { it, key: [harvests(it.type), speeds(it.type), replaceCost(it.type) / max, max - it.durabilityUsed] };
    });
    scored.sort((a, b) => { for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i]; return 0; });
    await bot.equip(scored[0].it, 'hand');
    return scored[0].it.name;
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    // fix44: serialize inventory operations and close non-inventory windows
    return await withInventoryMutex(bot, 'equip', async () => {
        try {
            // Close any open crafting/furnace/chest window first
            await ensureInventoryWindowClosed(bot);
            
            if (itemName === 'hand') {
                await bot.unequip('hand');
                log(bot, `Unequipped hand.`);
                return true;
            }
            // fix70: the carried slots getInventoryCounts counts (not the 2x2 crafting grid, which it does not count)
            let item = findCarried(bot, itemName);
            if (!item) {
                if (bot.game.gameMode === "creative") {
                    try { await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1)); } catch (e) { console.log('[creative] setInventorySlot not confirmed (ViaProxy):', e.message); await new Promise(r => setTimeout(r, 300)); }
                    item = bot.inventory.findInventoryItem(itemName);
                }
                else {
                    log(bot, `You do not have any ${itemName} to equip.`);
                    return false;
                }
            }
            if (itemName.includes('leggings')) {
                await bot.equip(item, 'legs');
            }
            else if (itemName.includes('boots')) {
                await bot.equip(item, 'feet');
            }
            else if (itemName.includes('helmet')) {
                await bot.equip(item, 'head');
            }
            else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
                await bot.equip(item, 'torso');
            }
            else if (itemName.includes('shield')) {
                await bot.equip(item, 'off-hand');
            }
            else {
                await bot.equip(item, 'hand');
            }
            log(bot, `Equipped ${itemName}.`);
            return true;
        } finally {
            // fix44: ensure window cleanup on all paths (success, throw, timeout, interrupt)
            // fix69: the state check is the handling: a window is open and it is not the player inventory. mineflayer's
            // closeWindow throws only on a null window (excluded here) and writes nothing once the socket is gone, so
            // the swallowing catch hid nothing but a bug, and in a finally it would also have masked the real error.
            if (bot.currentWindow && bot.currentWindow.type !== 'minecraft:inventory') {
                await bot.closeWindow(bot.currentWindow);
            }
        }
    });
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    while (true) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    await _reachBlock(bot, chest);
    if (outOfReach(bot, chest.position)) {
        log(bot, `Could not reach the chest at ${chest.position} (path blocked or too far). Move closer first.`);
        return false;
    }
    let chestContainer;
    try { chestContainer = await bot.openContainer(chest); }
    catch (e) { log(bot, `Could not open the chest at ${chest.position}: ${e.message}`); return false; }
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await _reachBlock(bot, chest);
    if (outOfReach(bot, chest.position)) {
        log(bot, `Could not reach the chest at ${chest.position} (path blocked or too far). Move closer first.`);
        return false;
    }
    let chestContainer;
    try { chestContainer = await bot.openContainer(chest); }
    catch (e) { log(bot, `Could not open the chest at ${chest.position}: ${e.message}`); return false; }
    
    // Find all matching items in the chest
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await _reachBlock(bot, chest);
    if (outOfReach(bot, chest.position)) {
        log(bot, `Could not reach the chest at ${chest.position} (path blocked or too far). Move closer first.`);
        return false;
    }
    let chestContainer;
    try { chestContainer = await bot.openContainer(chest); }
    catch (e) { log(bot, `Could not open the chest at ${chest.position}: ${e.message}`); return false; }
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    // fix70: look the item up in every slot getInventoryCounts counts (off-hand and armour included); findInventoryItem
    // searched 9-44 only, so the off-hand stack of 50 cooked_mutton (put there by the auto-eat plugin) was "not had"
    let item, name;
    if (itemName) {
        item = findCarried(bot, itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    
    // fix44: serialize inventory operations and close non-inventory windows
    return await withInventoryMutex(bot, 'consume', async () => {
        const CONSUME_TIMEOUT = 3000;
        const foodBefore = bot.food;
        let consumeErr = null;
        let timedOut = false;
        
        try {
            // Close any open crafting/furnace/chest window first
            await ensureInventoryWindowClosed(bot);
            
            // Verify item is still available after potential window close
            item = findCarried(bot, itemName);
            if (!item) {
                log(bot, `FAILED to consume ${itemName}: item no longer in inventory after closing window.`);
                return false;
            }
            
            // Equip the food item
            await bot.equip(item, 'hand');
            
            // Verify heldItem matches intended food before activating consume
            const held = bot.heldItem;
            if (!held || held.name !== item.name) {
                log(bot, `FAILED to consume ${itemName}: held item is ${held?.name || 'empty'}, not ${item.name}. Window state: ${bot.currentWindow?.type || 'none'}`);
                return false;
            }
            
            // Consume with timeout
            await Promise.race([
                bot.consume(),
                new Promise((_, rej) => setTimeout(() => { timedOut = true; rej(new Error('consume timed out')); }, CONSUME_TIMEOUT))
            ]).catch(e => { consumeErr = e; });
            
        } finally {
            // fix44: ensure window cleanup on all paths (success, throw, timeout, interrupt)
            // fix69: the state check is the handling: a window is open and it is not the player inventory. mineflayer's
            // closeWindow throws only on a null window (excluded here) and writes nothing once the socket is gone, so
            // the swallowing catch hid nothing but a bug, and in a finally it would also have masked the real error.
            if (bot.currentWindow && bot.currentWindow.type !== 'minecraft:inventory') {
                await bot.closeWindow(bot.currentWindow);
            }
        }
        
        // Check food rise to determine success even if consume threw/timed out
        const foodAfter = bot.food;
        const foodRose = foodAfter > foodBefore;
        
        if (consumeErr) {
            if (foodRose) {
                // Timeout but food did rise - count as success
                log(bot, `Consumed ${item.name} (food ${foodBefore} -> ${foodAfter}, server confirmed despite client timeout).`);
                return true;
            } else {
                // Timeout with no food rise - loud FAILED
                log(bot, `FAILED to consume ${itemName}: ${consumeErr.message}. Food stayed at ${foodBefore}. Window state: ${bot.currentWindow?.type || 'none'}`);
                return false;
            }
        }
        
        log(bot, `Consumed ${item.name} (food ${foodBefore} -> ${foodAfter}).`);
        return true;
    });
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    let player = bot.players[username]?.entity
    if (!player) {
        log(bot, bot.players[username] ? `${username} is online but too far away for you to see. Do NOT retry !goToPlayer. Ask ${username} for their coordinates and use !goToCoordinates, or ask them to come closer.` : `${username} is not online.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

/** fix66: the learned no-progress verdict in words (kind, active time, and what it was compared with) */
function describeStall(v) {
    return `no ${v.kind} progress for ${Math.round(v.activeMs)}ms active, longer than all ${v.bound.n} completed ${v.kind} steps learned (longest ${Math.round(v.bound.max)}ms${v.kind === 'dig' ? ` over the game dig time, ${Math.round(v.bound.ms - v.bound.max)}ms here` : ''})`;
}

export async function goToGoal(bot, goal) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     * @returns {Promise<boolean>} true if goal reached, false on failure/interrupt.
     **/

    // fix44: interrupt check with clean return and FAILED signal
    if (bot.interrupt_code) {
        log(bot, `FAILED: navigation cancelled (interrupted).`);
        return false;
    }

    bot.pathfinder.thinkTimeout = 10000; // fix44: reduced from 20s to 10s for faster failure feedback
    bot.pathfinder.tickTimeout = 40;
    const nonDestructiveMovements = _survivalMovements(bot);
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(bot.registry.blocksByName[block].id);   // fix60: the bot's live registry
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements = _survivalMovements(bot);

    let final_movements = destructiveMovements;

    const pathfind_timeout = 4000;
    if (bot.interrupt_code) {
        log(bot, `FAILED: navigation cancelled (interrupted).`);
        return false;
    }
    
    try {
        const nonDestructivePath = await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout);
        if (nonDestructivePath.status === 'success') {
            final_movements = nonDestructiveMovements;
            log(bot, `Found non-destructive path.`);
        }
        else {
            const destructivePath = await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout);
            if (destructivePath.status === 'success') {
                log(bot, `Found destructive path.`);
            }
            else {
                log(bot, `Path not found, but attempting to navigate anyway using destructive movements.`);
            }
        }
    } catch (pathErr) {
        log(bot, `FAILED: path calculation error: ${pathErr.message}`);
        return false;
    }

    const doorCheckInterval = startDoorInterval(bot);
    
    // fix44: progress monitoring - detect stalls where bot makes no progress
    // fix66: learned (utils/movement_model.js), checked on the physics tick; fix44's 1 s poll, 0.5-block "moved" and 15 s
    // "no progress" were constants that knew nothing of digging, pillaring or swimming
    let progressTimedOut = null;   // the verdict, when the learned no-progress check fired

    bot.pathfinder.setMovements(final_movements);
    try {
        const gotoWithProgress = async (targetGoal) => {
            return new Promise((resolve, reject) => {
                let stopWatch = null;
                const done = () => { stopWatch(); bot.removeListener('physicsTick', onInterrupt); };
                const onInterrupt = () => {
                    if (!bot.interrupt_code) return;
                    done();
                    bot.pathfinder.stop();
                    reject(new Error('interrupted'));
                };
                bot.on('physicsTick', onInterrupt);
                stopWatch = watchPathing(bot, (v) => {
                    progressTimedOut = v;
                    done();
                    bot.pathfinder.stop();
                    reject(new Error(`no progress (stalled): ${describeStall(v)}`));
                }, (line) => console.log(line));
                bot.pathfinder.goto(targetGoal)
                    .then(() => { done(); resolve(true); })
                    .catch((err) => { done(); reject(err); });
            });
        };

        try {
            await gotoWithProgress(goal);
        } catch (err) {
            // fix44: check for interrupt first
            if (bot.interrupt_code || /interrupted/i.test(String(err?.message))) {
                clearInterval(doorCheckInterval);
                bot.pathfinder.stop();
                log(bot, `FAILED: navigation cancelled (interrupted).`);
                return false;
            }
            
            // fix44: check for progress timeout (stall)
            if (progressTimedOut) {
                clearInterval(doorCheckInterval);
                log(bot, `FAILED: navigation stalled - ${describeStall(progressTimedOut)}.`);
                return false;
            }
            
            // long/complex path: hop via intermediate waypoints toward the goal, then retry
            if (!/Took to long|No path|Timeout/i.test(String(err?.message)) || goal.x == null) {
                throw err;
            }
            
            log(bot, `Path decision timeout, trying intermediate waypoints...`);
            for (let hop = 0; hop < 3; hop++) {
                if (bot.interrupt_code) {
                    clearInterval(doorCheckInterval);
                    bot.pathfinder.stop();
                    log(bot, `FAILED: navigation cancelled (interrupted).`);
                    return false;
                }
                const p = bot.entity.position;
                const dx = goal.x - p.x, dz = goal.z - p.z, dist = Math.hypot(dx, dz);
                if (dist < 6) break;
                const step = Math.min(16, dist / 2);
                const wx = Math.floor(p.x + dx / dist * step), wz = Math.floor(p.z + dz / dist * step);
                const wy = goal.y != null ? Math.floor(p.y + Math.sign(goal.y - p.y) * Math.min(6, Math.abs(goal.y - p.y))) : Math.floor(p.y);
                log(bot, `Trying waypoint ${wx}, ${wy}, ${wz}.`);
                bot.pathfinder.setMovements(destructiveMovements);
                // fix66: hops are watched by the same learned no-progress check (they were unwatched); a stall or
                // interrupt ends the navigation, any other hop failure is logged and the next hop is planned from here
                try { await gotoWithProgress(new pf.goals.GoalNear(wx, wy, wz, 2)); }
                catch (e) {
                    if (progressTimedOut || bot.interrupt_code) throw e;
                    log(bot, `Waypoint ${wx}, ${wy}, ${wz} not reached: ${e.message}`);
                }
            }
            bot.pathfinder.setMovements(destructiveMovements);
            
            // Reset progress tracking for final attempt
            progressTimedOut = null;
            
            await gotoWithProgress(goal);
        }
        clearInterval(doorCheckInterval);
        return true;
    } catch (err) {
        clearInterval(doorCheckInterval);
        bot.pathfinder.stop();
        
        // fix44: loud FAILED for all path failures
        if (bot.interrupt_code || /interrupted/i.test(String(err?.message))) {
            log(bot, `FAILED: navigation cancelled (interrupted).`);
        } else if (/Took to long/i.test(String(err?.message))) {
            log(bot, `FAILED: pathfinder took too long to decide path.`);
        } else if (/No path/i.test(String(err?.message))) {
            log(bot, `FAILED: no reachable path found.`);
        } else if (progressTimedOut) {
            log(bot, `FAILED: navigation stalled - ${describeStall(progressTimedOut)}.`);
        } else {
            log(bot, `FAILED: navigation error: ${err.message}`);
        }
        return false;
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance=2) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);
    
    try {
        // fix44: goToGoal now returns false on failure instead of always throwing
        const reached = await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        
        if (!reached) {
            // goToGoal already logged FAILED, add distance context
            const d = Math.round(bot.entity.position.distanceTo(new Vec3(x, y, z)));
            log(bot, `Still ${d} blocks from ${x}, ${y}, ${z}. ${_pathHint(bot, x, y, z)}`);
            return false;
        }
        
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `FAILED: unable to reach ${x}, ${y}, ${z}; still ${Math.round(distance)} blocks away. ${_pathHint(bot, x, y, z)}`);
            return false;
        }
    } catch (err) {
        clearInterval(progressInterval);
        const d = Math.round(bot.entity.position.distanceTo(new Vec3(x, y, z)));
        log(bot, `FAILED: pathfinding stopped (${err.message}); ${d} blocks from ${x}, ${y}, ${z}. ${_pathHint(bot, x, y, z)}`);
        return false;
    }
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `FAILED: no ${blockType} within ${range} blocks.` +
            (range < MAX_RANGE ? ` You may retry ONCE with a larger range (max ${MAX_RANGE}),` : ' Already at max range,') +
            ` otherwise do not retry: explore with !moveAway(64), pick a substitute block, or ask a player.`);
        // fix87: one block is what this call was searching for. A name that is not a block in the game data is not a reach need.
        markBlockOutOfRange(bot, [blockType], 1);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        const seen = [...new Set(Object.values(bot.entities).filter(e => e !== bot.entity && e.position && e.position.distanceTo(bot.entity.position) <= range).map(e => e.type === 'player' ? `player:${e.username}` : e.name))];
        const isPlayer = Object.keys(bot.players || {}).includes(entityType);
        log(bot, `FAILED: no entity of type '${entityType}' within ${range} blocks.` +
            (isPlayer ? ` '${entityType}' is a player name: use !goToPlayer, or ask them for coordinates.` : '') +
            ` Entity types actually nearby: ${seen.length ? seen.join(', ') : 'none'}.` +
            ` DO NOT retry this same search; it will fail again. Ask a player for coordinates or choose a different task.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players[username]?.entity
    if (!player) {
        log(bot, bot.players[username] ? `${username} is online but too far away for you to see. Do NOT retry !goToPlayer. Ask ${username} for their coordinates and use !goToCoordinates, or ask them to come closer.` : `${username} is not online.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    await goToGoal(bot, goal, true);

    log(bot, `You have reached ${username}.`);
}


export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username].entity
    if (!player)
        return false;

    const move = new pf.Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}


export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = new pf.Movements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));
    await bot.pathfinder.goto(inverted_goal);
    return true;
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        // fix69: bot.wake() rejects only with 'already awake' (!bot.isSleeping), which the loop condition rules out,
        // so the rejection it swallowed could not be a normal state
        if (bot.interrupt_code) {
            await bot.wake();
            log(bot, `Interrupted; got out of bed.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        placeBlock(bot, 'farmland', x, y, z);
        placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (outOfReach(bot, block.position)) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 3));
    }
    if (!bot.canSeeBlock(block) || outOfReach(bot, block.position)) await _reachBlock(bot, block);
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (outOfReach(bot, block.position)) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 3));
    }
    if (!bot.canSeeBlock(block) || outOfReach(bot, block.position)) await _reachBlock(bot, block);
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    const startBlock = bot.blockAt(bot.entity.position);
    if (!startBlock) {
        log(bot, 'FAILED: digDown - no block found at current position (chunk unloaded)');
        return false;
    }
    let start_block_pos = startBlock.position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`)
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0); // this will probably work most of the time but a custom mining and towering up implementation could be added if needed
        log(bot, `Going to the surface at y=${y+1}.`);``
        return true;
    }
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(world.gameReach(bot));
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(world.gameReach(bot));
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(world.gameReach(bot));
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }


function _pathHint(bot, x, y, z) {
    const p = bot.entity.position;
    const hints = [];
    if (bot.entity.isInWater) hints.push('you are in water, swim to shore first');
    if (Math.abs(y - p.y) > 6) hints.push(`target is ${Math.round(y - p.y)} blocks ${y > p.y ? 'above' : 'below'} you, check the y value (use the surface height) or use !goToSurface`);
    if (Math.hypot(x - p.x, z - p.z) > 100) hints.push('target is far and chunks may not be loaded, go to a waypoint halfway first');
    if (!bot.blockAt(new Vec3(x, y, z))) hints.push('target chunk is not loaded');
    hints.push('do not repeat the identical move; change the target or approach');
    return 'Hint: ' + hints.join('; ') + '.';
}

export async function gatherUntil(bot, itemName, target, maxRadius=256) {
    /**
     * Collect blocks until the inventory holds at least `target` of itemName, searching in widening rings. Reports progress and what is missing.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, block/item name to end up with, e.g. "birch_log", "cobblestone", "dirt".
     * @param {number} target, how many you want in the inventory in total.
     * @param {number} maxRadius, furthest search distance. Defaults to 256.
     * @returns {Promise<boolean>} true if the inventory reached target.
     * @example
     * await skills.gatherUntil(bot, "birch_log", 16);
     **/
    if (typeof itemName !== 'string' || !itemName) throw new Error(`gatherUntil: itemName must be a string, got ${itemName}`);
    target = Math.min(Math.max(1, Math.floor(target)), 256);
    const have = () => world.getInventoryCounts(bot)[itemName] || 0;
    const start = have();
    if (start >= target) { log(bot, `Already have ${start}/${target} ${itemName}.`); return true; }
    let fails = 0;
    while (have() < target && fails < 3) {
        if (bot.interrupt_code) return false;
        const before = have();
        // fix95: the blocks that yield itemName come from the game data (blockLoot), not a cobblestone/dirt list. An item
        //        no block yields fails loudly here instead of returning false with no I/O to a caller that retries it.
        const searched = itemSourceBlocks(bot.registry, itemName);
        if (searched.length === 0) throw new Error(`gatherUntil: no block in the game data drops ${itemName}; obtain it another way (craft, smelt, or a mob drop)`);
        const block = world.getNearestBlock(bot, searched, maxRadius);
        if (!block) {
            log(bot, `FAILED: have ${have()}/${target} ${itemName}; no more ${itemName} found within ${maxRadius} blocks. Move to a new area (!moveAway(100)) or use a substitute material.`);
            markBlockOutOfRange(bot, searched, target - have());
            return false;
        }
        await collectBlock(bot, block.name, Math.min(target - before, 16));
        if (have() <= before) fails++; else fails = 0;
    }
    const got = have();
    if (got >= target) { log(bot, `Done: have ${got}/${target} ${itemName}.`); return true; }
    log(bot, `FAILED: stuck at ${got}/${target} ${itemName} after 3 attempts without progress (missing tool? unreachable blocks?). Check tools with your inventory and pick a different spot.`);
    return false;
}

export async function buildStructure(bot, type, x, y, z, material, width=5, length=5, height=3) {
    /**
     * Build a simple structure from one material, placing only into air. type: "floor" (width x length at y), "wall" (width long along +x, height tall), "box" (hollow walls, no roof), "hut" (hollow box with roof and a door gap on the -z side), "roof" (flat layer at y), "pillar".
     * x,y,z is the min (north-west, bottom) corner. Checks materials first and reports exactly what is missing.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, "floor" | "wall" | "box" | "hut" | "roof" | "pillar".
     * @param {number} x, min x corner. @param {number} y, bottom y. @param {number} z, min z corner.
     * @param {string} material, block name, e.g. "birch_planks".
     * @param {number} width, size along x (max 16). @param {number} length, size along z (max 16). @param {number} height, size along y (max 8).
     * @returns {Promise<boolean>} true if every block was placed.
     * @example
     * await skills.buildStructure(bot, "hut", 100, 64, 200, "oak_planks", 5, 5, 3);
     **/
    width = Math.min(Math.max(1, width|0), 16); length = Math.min(Math.max(1, length|0), 16); height = Math.min(Math.max(1, height|0), 8);
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    const pos = [];
    const add = (a, b, c) => pos.push(new Vec3(a, b, c));
    if (type === 'floor' || type === 'roof') { for (let i=0;i<width;i++) for (let k=0;k<length;k++) add(x+i, y, z+k); }
    else if (type === 'wall') { for (let j=0;j<height;j++) for (let i=0;i<width;i++) add(x+i, y+j, z); }
    else if (type === 'pillar') { for (let j=0;j<height;j++) add(x, y+j, z); }
    else if (type === 'box' || type === 'hut') {
        const door = new Vec3(x + Math.floor(width/2), 0, z);
        for (let j=0;j<height;j++) for (let i=0;i<width;i++) for (let k=0;k<length;k++) {
            if (i!==0 && k!==0 && i!==width-1 && k!==length-1) continue;
            if (type === 'hut' && x+i === door.x && z+k === door.z && j < 2) continue;
            add(x+i, y+j, z+k);
        }
        if (type === 'hut') for (let i=0;i<width;i++) for (let k=0;k<length;k++) add(x+i, y+height, z+k);
    } else {
        throw new Error(`buildStructure: unknown type "${type}". Use floor, wall, box, hut, roof or pillar.`);
    }
    const todo = pos.filter(p => { const b = bot.blockAt(p); return !b || ['air','cave_air','short_grass','grass','tall_grass','snow'].includes(b.name) || b.name.endsWith('flower'); });
    const have = world.getInventoryCounts(bot)[material] || 0;
    if (todo.length === 0) { log(bot, `Nothing to do: the ${type} at ${x},${y},${z} is already complete.`); return true; }
    if (!bot.modes.isOn('cheat') && have < todo.length) {
        log(bot, `FAILED before building: ${type} needs ${todo.length} ${material}, you have ${have}. Get ${todo.length - have} more first (e.g. !gatherUntil or !craftRecipe), then retry.`);
        return false;
    }
    // build bottom-up, closest first, so each block has support
    todo.sort((a, b) => a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    let placed = 0; const failed = [];
    for (const p of todo) {
        if (bot.interrupt_code) break;
        const ok = await placeBlock(bot, material, p.x, p.y, p.z, 'bottom', true);
        if (ok) placed++; else failed.push(`${p.x},${p.y},${p.z}`);
    }
    if (failed.length === 0 && placed === todo.length) { log(bot, `Built ${type} at ${x},${y},${z}: placed ${placed} ${material}.`); return true; }
    log(bot, `FAILED partly: placed ${placed}/${todo.length} ${material} for ${type}. Could not place at: ${failed.slice(0,8).join(' ')}${failed.length>8?' ...':''}. Usually means no adjacent block to place against or out of reach; build a support block or stand closer, then rerun the same command (it skips finished blocks).`);
    return false;
}

export async function shelterNow(bot) {
    /**
     * Get safe right now: sleep if a bed is near and it is night, otherwise wall yourself into a 1x2 pocket with blocks from inventory (dig in if you have none).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if sheltered.
     * @example
     * await skills.shelterNow(bot);
     **/
    const t = bot.time.timeOfDay;
    if (t > 12500 && t < 23500 && world.getNearestBlocksWhere(bot, b => b.name.endsWith('_bed'), 24, 1).length) {
        if (await goToBed(bot)) return true;
    }
    const p = bot.entity.position.floored();
    const inv = world.getInventoryCounts(bot);
    const blocks = Object.keys(inv).filter(n => /(dirt|cobblestone|planks|stone|deepslate|sand|netherrack)$/.test(n) && !n.includes('slab') && !n.includes('stairs'));
    const needed = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[1,1,0],[-1,1,0],[0,1,1],[0,1,-1],[0,2,0]].map(o => p.offset(...o))
        .filter(q => { const b = bot.blockAt(q); return !b || b.boundingBox !== 'block'; });
    const total = blocks.reduce((s, n) => s + inv[n], 0);
    if (total >= needed.length) {
        let i = 0;
        for (const q of needed) {
            while (i < blocks.length && (world.getInventoryCounts(bot)[blocks[i]] || 0) === 0) i++;
            if (i >= blocks.length) break;
            await placeBlock(bot, blocks[i], q.x, q.y, q.z, 'bottom', true);
        }
        const left = needed.filter(q => { const b = bot.blockAt(q); return !b || b.boundingBox !== 'block'; });
        if (left.length === 0) { log(bot, `Sheltered: walled in at ${p.x},${p.y},${p.z}. Wait for day (time > 23500) then break out.`); return true; }
        log(bot, `Shelter incomplete: ${left.length} gaps left. Trying to dig in instead.`);
    } else {
        log(bot, `Only ${total} building blocks (need ${needed.length}); digging in instead.`);
    }
    await digDown(bot, 3);
    const above = bot.entity.position.floored().offset(0, 2, 0);
    const name = blocks.find(n => (world.getInventoryCounts(bot)[n] || 0) > 0) || 'dirt';
    if (world.getInventoryCounts(bot)[name]) await placeBlock(bot, name, above.x, above.y, above.z, 'bottom', true);
    const b = bot.blockAt(above);
    if (b && b.boundingBox === 'block') { log(bot, `Sheltered: dug in at ${bot.entity.position.floored()}.`); return true; }
    log(bot, `FAILED: could not seal shelter (no blocks to cover the hole). Collect 9 dirt with !gatherUntil("dirt", 9) and retry, or flee with !moveAway(32).`);
    return false;
}

export async function travelTo(bot, x, y, z, maxHops = 120) {
    /**
     * Travel long distances (hundreds of blocks) in short hops of up to 32 blocks, so chunks load and paths stay short.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, y, z target coordinates.
     * @returns {Promise<boolean>} true once within 4 blocks (horizontally) of the target.
     * @example
     * await skills.travelTo(bot, 100, 64, 200);
     **/
    let fails = 0;
    for (let hop = 0; hop < maxHops; hop++) {
        if (bot.interrupt_code) return false;
        const p = bot.entity.position;
        const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
        if (d <= 4) { log(bot, `Arrived near ${x}, ${y}, ${z}.`); return true; }
        if (d <= 32) { if (await goToPosition(bot, x, y, z, 3)) continue; }
        const step = Math.min(32, d);
        // sidestep a little after a failed hop so the next one tries a different line
        const side = fails ? (fails % 2 ? 1 : -1) * 10 * fails : 0;
        const tx = Math.round(p.x + dx / d * step - dz / d * side), tz = Math.round(p.z + dz / d * step + dx / d * side);
        try { await goToGoal(bot, new pf.goals.GoalNearXZ(tx, tz, 3)); fails = 0; }
        catch (err) {
            if (bot.interrupt_code) return false;
            if (++fails >= 6) { log(bot, `travelTo gave up at ${p.floored()} after 6 failed hops: ${err?.message}`); return false; }
        }
    }
    log(bot, `travelTo ran out of hops; still ${Math.round(Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z))} blocks away.`);
    return false;
}
