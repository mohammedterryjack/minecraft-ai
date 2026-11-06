// fix84: inventory room and slot-freeing crafts, from the game data only.
// A stackable slot holds one item up to its minecraft-data stackSize. Partial stacks (count not a multiple of
// stackSize) still have room for that item. The stackable window is the player window's main+hotbar range
// (utils/carried.js PLAYER_WINDOW), not a counted literal.
// A craft frees slots when, for some number of crafts the held ingredients allow, the stacks afterwards occupy
// fewer slots than the stacks before (ceil(count / stackSize) summed over items).
import { PLAYER_WINDOW } from '../utils/carried.js';
import { verifiedConsumes } from './consume_evidence.js';

export function stackableCapacity() {
    const n = PLAYER_WINDOW.offHand - PLAYER_WINDOW.mainStart;
    if (!Number.isInteger(n) || n < 1) throw new Error(`[fix84] stackable window has no slots (${PLAYER_WINDOW.mainStart}..${PLAYER_WINDOW.offHand})`);
    return n;
}

export function stackSizeOf(registry, name) {
    if (!registry || !registry.itemsByName) throw new Error('[fix84] stackSizeOf: registry required');
    const it = registry.itemsByName[name];
    if (!it) throw new Error(`[fix84] ${JSON.stringify(name)} is not an item in the game data`);
    if (!Number.isInteger(it.stackSize) || it.stackSize < 1) throw new Error(`[fix84] ${name} has no stackSize in the game data`);
    return it.stackSize;
}

export function slotsOccupied(registry, counts) {
    if (!counts || typeof counts !== 'object') throw new Error('[fix84] slotsOccupied: counts required');
    let n = 0;
    for (const [name, count] of Object.entries(counts)) {
        if (!Number.isInteger(count) || count < 0) throw new Error(`[fix84] count of ${name} must be a non-negative integer, got ${JSON.stringify(count)}`);
        if (count === 0) continue;
        n += Math.ceil(count / stackSizeOf(registry, name));
    }
    return n;
}

// how many more of `item` fit in `counts` once partial stacks of that item and empty slots are counted
export function roomFor(registry, counts, item) {
    const capacity = stackableCapacity();
    const used = slotsOccupied(registry, counts);
    if (used > capacity) throw new Error(`[fix84] ${used} slots occupied; the stackable window holds ${capacity}`);
    const empty = capacity - used;
    const ss = stackSizeOf(registry, item);
    const held = Object.hasOwn(counts, item) ? counts[item] : 0;
    const rem = held % ss;
    const partial = rem === 0 ? 0 : ss - rem;
    return empty * ss + partial;
}

// empty slots that must be gained before `qty` more of `item` fit (0 when they already do)
export function emptySlotsToFit(registry, counts, item, qty) {
    if (!Number.isInteger(qty) || qty < 1) throw new Error(`[fix84] emptySlotsToFit: positive integer qty required, got ${JSON.stringify(qty)}`);
    const ss = stackSizeOf(registry, item);
    let space = roomFor(registry, counts, item);
    let slots = 0;
    while (space < qty) { slots += 1; space += ss; }
    return slots;
}

export function stackableCounts(bot) {
    if (!bot || !bot.inventory || !Array.isArray(bot.inventory.slots)) throw new Error('[fix84] stackableCounts: bot.inventory.slots required');
    const start = bot.inventory.inventoryStart, end = bot.inventory.inventoryEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) throw new Error(`[fix84] inventory window range required, got ${JSON.stringify(start)}..${JSON.stringify(end)}`);
    const counts = {};
    for (let i = start; i < end; i++) {
        const s = bot.inventory.slots[i];
        if (s == null) continue;
        if (typeof s.name !== 'string' || !Number.isInteger(s.count) || s.count < 1) throw new Error(`[fix84] slot ${i} is not an item stack: ${JSON.stringify(s)}`);
        if (!Object.hasOwn(counts, s.name)) counts[s.name] = 0;
        counts[s.name] += s.count;
    }
    return counts;
}

// lay `counts` into the stackable window (perfect stacking). Throws when they do not fit.
export function placeCounts(registry, counts) {
    const start = PLAYER_WINDOW.mainStart, end = PLAYER_WINDOW.offHand;
    const slots = new Array(PLAYER_WINDOW.size).fill(null);
    let i = start;
    for (const [name, count] of Object.entries(counts)) {
        if (!Number.isInteger(count) || count < 0) throw new Error(`[fix84] placeCounts: bad count for ${name}`);
        const ss = stackSizeOf(registry, name);
        let left = count;
        while (left > 0) {
            if (i >= end) throw new Error(`[fix84] placeCounts: ${name} does not fit in the stackable window`);
            const n = left < ss ? left : ss;
            slots[i] = { name, count: n, stackSize: ss };
            left -= n;
            i += 1;
        }
    }
    return { slots, inventoryStart: start, inventoryEnd: end };
}

function applyDelta(registry, counts, delta, times) {
    const next = { ...counts };
    for (const d of delta) {
        const it = registry.items[d.id];
        if (!it) throw new Error(`[fix84] recipe delta id ${d.id} is not an item`);
        const cur = Object.hasOwn(next, it.name) ? next[it.name] : 0;
        const after = cur + d.count * times;
        if (after < 0) return null;
        if (after === 0) delete next[it.name];
        else next[it.name] = after;
    }
    return next;
}

// the craft of a held recipe that frees the most slots (lexical item name, then fewer crafts, on a tie). null when none does.
export function bestSlotFreeingCraft(registry, recipesOf, counts) {
    if (typeof recipesOf !== 'function') throw new Error('[fix84] bestSlotFreeingCraft: recipesOf(itemId) required');
    const before = slotsOccupied(registry, counts);
    let best = null;
    for (const name of Object.keys(registry.itemsByName)) {
        const id = registry.itemsByName[name].id;
        const recipes = recipesOf(id);
        if (!Array.isArray(recipes)) throw new Error(`[fix84] recipesOf(${name}) did not return an array`);
        for (const r of recipes) {
            if (!r || !Array.isArray(r.delta) || !r.result || !Number.isInteger(r.result.count) || r.result.count < 1) continue;
            const ings = r.delta.filter(d => d.count < 0);
            if (!ings.length) continue;
            let maxTimes = null;
            for (const g of ings) {
                const it = registry.items[g.id];
                if (!it) throw new Error(`[fix84] recipe ingredient id ${g.id} is not an item`);
                const have = Object.hasOwn(counts, it.name) ? counts[it.name] : 0;
                const each = -g.count;
                if (each < 1) throw new Error(`[fix84] recipe for ${name} has a non-positive ingredient count`);
                const t = Math.floor(have / each);
                if (maxTimes === null || t < maxTimes) maxTimes = t;
            }
            if (maxTimes === null || maxTimes < 1) continue;
            for (let times = 1; times <= maxTimes; times++) {
                const next = applyDelta(registry, counts, r.delta, times);
                if (next === null) continue;
                const occ = slotsOccupied(registry, next);
                if (occ > stackableCapacity()) continue;
                const freed = before - occ;
                if (freed < 1) continue;
                const option = { item: name, times, produced: times * r.result.count, freed, task: `Craft ${times * r.result.count} ${name}` };
                if (best === null || option.freed > best.freed || (option.freed === best.freed && (option.item < best.item || (option.item === best.item && option.times < best.times)))) best = option;
            }
        }
    }
    return best;
}

// surplus is what consumption evidence says is above the most any skill has been verified to spend.
// an item with no verified consumption is not surplus (absence is not evidence it can be tossed).
export function surplusFromConsumption(skills, counts) {
    if (!Array.isArray(skills)) throw new Error('[fix84] surplusFromConsumption: skills array required');
    if (!counts || typeof counts !== 'object') throw new Error('[fix84] surplusFromConsumption: counts required');
    const keep = {};
    for (const s of skills) {
        const v = verifiedConsumes(s);
        for (const [item, amt] of Object.entries(v)) {
            if (!Number.isInteger(amt) || amt < 1) throw new Error(`[fix84] ${s.name} verified consume of ${item} is not a positive integer: ${JSON.stringify(amt)}`);
            if (!Object.hasOwn(keep, item) || amt > keep[item]) keep[item] = amt;
        }
    }
    const out = [];
    for (const [item, held] of Object.entries(counts)) {
        if (!Number.isInteger(held) || held < 0) throw new Error(`[fix84] held ${item} is not a non-negative integer`);
        if (!Object.hasOwn(keep, item)) continue;
        if (held > keep[item]) out.push({ item, count: held - keep[item], keep: keep[item] });
    }
    out.sort((a, b) => (b.count - a.count) || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    return out;
}

export function slotsFreedBy(registry, counts, surplus) {
    const next = { ...counts };
    for (const s of surplus) {
        if (!Object.hasOwn(next, s.item)) throw new Error(`[fix84] surplus ${s.item} is not held`);
        const left = next[s.item] - s.count;
        if (left < 0) throw new Error(`[fix84] surplus of ${s.item} (${s.count}) exceeds held ${next[s.item]}`);
        if (left === 0) delete next[s.item];
        else next[s.item] = left;
    }
    return slotsOccupied(registry, counts) - slotsOccupied(registry, next);
}
