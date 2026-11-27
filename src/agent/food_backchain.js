// fix93: when a learned food raiser cannot run, obtain an edible from game data
// (registry foods, recipes, block loot, harvest tools, entity loot) and close on the measured deficit.
import { lessCost } from './recipe_plan.js';

export function edibleNames(registry) {
    if (!registry || !registry.foodsByName || typeof registry.foodsByName !== 'object') throw new Error('[fix93] registry.foodsByName required');
    const names = Object.keys(registry.foodsByName);
    if (names.length === 0) throw new Error('[fix93] LOUD: game data lists no edible items');
    return names;
}

export function entityDroppers(registry, item) {
    if (!registry || registry.entityLoot === undefined || registry.entityLoot === null) throw new Error('[fix93] registry.entityLoot required');
    if (typeof item !== 'string' || item.length === 0) throw new Error('[fix93] item name required');
    const entries = Array.isArray(registry.entityLoot) ? registry.entityLoot : Object.values(registry.entityLoot);
    const out = [];
    for (const e of entries) {
        if (!e || typeof e.entity !== 'string' || !Array.isArray(e.drops)) throw new Error(`[fix93] entityLoot entry is malformed: ${JSON.stringify(e)}`);
        for (const d of e.drops) {
            if (!d || typeof d.item !== 'string') throw new Error(`[fix93] entity ${e.entity} drop is malformed`);
            if (d.item === item) out.push(e.entity);
        }
    }
    return out;
}

export function heldEdible(edibles, inventory) {
    if (!Array.isArray(edibles)) throw new Error('[fix93] edible names required');
    if (inventory === null || inventory === undefined || typeof inventory !== 'object') throw new Error('[fix93] inventory required');
    const held = [];
    for (const name of edibles) {
        if (!Object.hasOwn(inventory, name)) continue;
        const n = inventory[name];
        if (typeof n !== 'number') throw new Error(`[fix93] inventory count for ${name} is not a number`);
        if (n > 0) held.push(name);
    }
    return held;
}

// fix205: candidates are ranked by the game-data cost of closing the DEFICIT, not of one item.
// An item worth 1 food point costs ceil(deficit) units at deficit 15; an item worth 5 points, ceil(15/5)=3.
// Ranking one item at a time picked dried_kelp (cheapest unit) and queued a 15-smelt grind the bot
// could not finish (live 27 Nov: food fell to 2/20 and the bot starved next to a pillager camp).
export function planFoodAcquisition({ edibles, inventory, deficitPoints, foodValue, costOf, prerequisites, entityDroppersFor }) {
    if (typeof costOf !== 'function') throw new Error('[fix205] costOf(item, count, inventory) -> cost vector or null required');
    if (typeof foodValue !== 'function') throw new Error('[fix205] foodValue(item) -> food points required');
    if (typeof prerequisites !== 'function') throw new Error('[fix93] prerequisites(item, count, inventory) required');
    if (typeof entityDroppersFor !== 'function') throw new Error('[fix93] entityDroppers(item) required');
    if (typeof deficitPoints !== 'number' || !Number.isFinite(deficitPoints) || deficitPoints <= 0) {
        throw new Error(`[fix205] LOUD: deficitPoints must be a positive number of food points below the learned floor, got ${JSON.stringify(deficitPoints)}`);
    }
    const held = heldEdible(edibles, inventory);
    if (held.length > 0) return { executable: true, item: held[0], needs: [], entityDroppers: [] };
    let best = null;
    for (const item of edibles) {
        const points = foodValue(item);
        if (typeof points !== 'number' || !Number.isFinite(points)) throw new Error(`[fix205] LOUD: foodValue(${item}) must return a number, got ${JSON.stringify(points)}`);
        if (points <= 0) continue;   // game data: this item raises no hunger (a spice, not a meal)
        const units = Math.ceil(deficitPoints / points);
        const cost = costOf(item, units, inventory);
        if (cost === null) continue;   // not obtainable at this count
        // ties break by ascending item name — the same tie rule recipe_plan.js pick() applies to tied options
        // (fewest untried, then name), so ranking foods one cost() at a time cannot disagree with a set search.
        let take = false;
        if (best === null) take = true;
        else if (lessCost(cost, best.cost)) take = true;
        else if (!lessCost(best.cost, cost) && item < best.item) take = true;
        if (take) best = { item, cost, units, points };
    }
    if (best === null) throw new Error(`[fix205] LOUD: none of the ${edibles.length} edible items can close a ${deficitPoints}-food-point deficit from the game data`);
    const pre = prerequisites(best.item, 1, inventory);
    if (!pre || typeof pre.task !== 'string' || pre.task.length === 0) throw new Error('[fix93] LOUD: food plan has no task');
    const droppers = entityDroppersFor(best.item);
    if (!Array.isArray(droppers)) throw new Error('[fix93] entityDroppers must return an array');
    return {
        executable: false,
        item: best.item,
        units: best.units,
        task: pre.task,
        how: pre.how,
        plan: pre.plan,
        cycles: pre.cycles,
        needs: [{ item: best.item, count: 1, reason: 'input', source: 'game data' }],
        entityDroppers: droppers,
    };
}

// Closed only when measured food is no longer below the learned regen floor.
// Holding an edible is not the close condition.
export function hungerDeficitClosed(beforeFood, afterFood, floor) {
    if (typeof beforeFood !== 'number' || !Number.isFinite(beforeFood)) throw new Error('[fix93] food before the raiser required');
    if (typeof afterFood !== 'number' || !Number.isFinite(afterFood)) throw new Error('[fix93] food after the raiser required');
    if (typeof floor !== 'number' || !Number.isFinite(floor)) throw new Error('[fix93] LOUD: no learned regen floor; cannot close a hunger deficit');
    return { closed: afterFood >= floor, beforeFood, afterFood, floor, rose: afterFood > beforeFood };
}
