// fix93: when a learned food raiser cannot run, obtain an edible from game data
// (registry foods, recipes, block loot, harvest tools, entity loot) and close on the measured deficit.

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

export function planFoodAcquisition({ edibles, inventory, cheapest, prerequisites, entityDroppersFor }) {
    if (typeof cheapest !== 'function') throw new Error('[fix93] cheapest(edibles, count, inventory) required');
    if (typeof prerequisites !== 'function') throw new Error('[fix93] prerequisites(item, count, inventory) required');
    if (typeof entityDroppersFor !== 'function') throw new Error('[fix93] entityDroppers(item) required');
    const held = heldEdible(edibles, inventory);
    if (held.length > 0) return { executable: true, item: held[0], needs: [], entityDroppers: [] };
    const choice = cheapest(edibles, 1, inventory);
    if (!choice || typeof choice.item !== 'string' || choice.item.length === 0) throw new Error('[fix93] LOUD: food plan chose no item');
    const pre = prerequisites(choice.item, 1, inventory);
    if (!pre || typeof pre.task !== 'string' || pre.task.length === 0) throw new Error('[fix93] LOUD: food plan has no task');
    const droppers = entityDroppersFor(choice.item);
    if (!Array.isArray(droppers)) throw new Error('[fix93] entityDroppers must return an array');
    return {
        executable: false,
        item: choice.item,
        task: pre.task,
        how: pre.how,
        plan: pre.plan,
        cycles: pre.cycles,
        needs: [{ item: choice.item, count: 1, reason: 'input', source: 'game data' }],
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
