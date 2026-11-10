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
            if (!r || !Array.isArray(r.delta) || !r.result || !Number.isInteger(r.result.count) || r.result.count < 1) {
                const why = !r ? 'recipe is empty' : !Array.isArray(r.delta) ? 'recipe has no delta array' : !r.result ? 'recipe has no result' : `recipe result count is ${JSON.stringify(r.result.count)}`;
                throw new Error(`[fix85] game-data recipe for ${name} is malformed (${why})`);
            }
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

// fix92: one stack in the player window. metadata is kept when the slot has it, so two damaged tools are two slots.
export function inventoryStacks(bot) {
    if (!bot || !bot.inventory || !Array.isArray(bot.inventory.slots)) throw new Error('[fix92] inventoryStacks: bot.inventory.slots required');
    const start = bot.inventory.inventoryStart, end = bot.inventory.inventoryEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) throw new Error(`[fix92] inventory window range required, got ${JSON.stringify(start)}..${JSON.stringify(end)}`);
    const out = [];
    for (let i = start; i < end; i++) {
        const s = bot.inventory.slots[i];
        if (s == null) continue;
        if (typeof s.name !== 'string' || !Number.isInteger(s.count) || s.count < 1) throw new Error(`[fix92] slot ${i} is not an item stack: ${JSON.stringify(s)}`);
        let metadata = null;
        if (Object.hasOwn(s, 'metadata')) metadata = s.metadata;
        out.push({ slot: i, name: s.name, count: s.count, metadata });
    }
    return out;
}

const PROVENANCE = ['learned', 'goal', 'game-data'];

function analysedSkills(skills) {
    if (!Array.isArray(skills)) throw new Error('[fix92] capacityPlan: skills array required');
    const out = [];
    for (const s of skills) {
        if (s === null || typeof s !== 'object' || typeof s.name !== 'string' || s.name.length === 0) throw new Error(`[fix92] capacityPlan: skill entry has no name: ${JSON.stringify(s)}`);
        if (s.demoted) continue;
        if (typeof s.mergedInto === 'string' && s.mergedInto.length > 0) continue;
        out.push(s);
    }
    return out;
}

// verified max only when the item was seen on every measured run.
// consumeEvidence is written by recordConsumeEvidence. A skill with no record has no verified spend
// (consume_evidence.js). Malformed evidence throws. useEvidence is not a field: nothing recorded it,
// and a missing value must not be treated as a measured zero.
function readEvidence(skill, field) {
    if (field !== 'consumeEvidence') throw new Error(`[fix97] LOUD: ${field} is not recorded; reserves come from consumeEvidence and the plan`);
    if (!Object.hasOwn(skill, field)) return {};
    const ev = skill[field];
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) throw new Error(`[fix92] LOUD: incomplete ${field} for ${skill.name}: ${JSON.stringify(ev)}`);
    if (!Number.isInteger(ev.runs) || ev.runs < 1) throw new Error(`[fix92] LOUD: incomplete ${field} for ${skill.name}: runs ${JSON.stringify(ev.runs)}`);
    if (ev.items === null || typeof ev.items !== 'object' || Array.isArray(ev.items)) throw new Error(`[fix92] LOUD: incomplete ${field} for ${skill.name}: items ${JSON.stringify(ev.items)}`);
    const out = {};
    for (const [k, it] of Object.entries(ev.items)) {
        if (it === null || typeof it !== 'object' || Array.isArray(it)) throw new Error(`[fix92] LOUD: incomplete ${field} for ${skill.name} item ${k}: ${JSON.stringify(it)}`);
        if (!Number.isInteger(it.runs) || it.runs < 0 || it.runs > ev.runs) throw new Error(`[fix92] LOUD: incomplete ${field} for ${skill.name} item ${k}: runs ${JSON.stringify(it.runs)}`);
        if (!Number.isInteger(it.max) || it.max < 1) throw new Error(`[fix92] LOUD: incomplete ${field} for ${skill.name} item ${k}: max ${JSON.stringify(it.max)}`);
        if (it.runs === ev.runs) out[k] = it.max;
    }
    return out;
}

function bumpReserve(keep, item, count, prov) {
    if (!Number.isInteger(count) || count < 0) throw new Error(`[fix92] reserve of ${item} is not a non-negative integer: ${JSON.stringify(count)}`);
    if (count === 0) return;
    const cur = keep.get(item);
    if (!cur || count > cur.count) keep.set(item, { count, prov: new Set([prov]) });
    else if (count === cur.count) cur.prov.add(prov);
}

function provenanceText(set) {
    const parts = [];
    for (const p of PROVENANCE) if (set.has(p)) parts.push(p);
    if (!parts.length) throw new Error('[fix92] reserve has no provenance');
    return parts.join('+');
}

function countsOf(stacks) {
    const counts = {};
    for (const s of stacks) {
        if (!Object.hasOwn(counts, s.name)) counts[s.name] = 0;
        counts[s.name] += s.count;
    }
    return counts;
}

// Whole-slot capacity plan. A stack can be emptied only when the rest of that kind still covers its reserve
// (tossing does not compact other stacks). Zero slot-gain is not a candidate. Ties: fewer items, then registry
// item id, then slot index.
export function capacityPlan({ registry, skills, stacks, slotsNeeded, goalItem, goalCount, needItem, prerequisites, toolsNeeded, recipesOf }) {
    if (!registry || !registry.itemsByName) throw new Error('[fix92] capacityPlan: registry required');
    if (!Number.isInteger(slotsNeeded) || slotsNeeded < 0) throw new Error(`[fix92] capacityPlan: slotsNeeded must be a non-negative integer, got ${JSON.stringify(slotsNeeded)}`);
    if (typeof goalItem !== 'string' || goalItem.length === 0) throw new Error(`[fix92] capacityPlan: goalItem required, got ${JSON.stringify(goalItem)}`);
    if (!Number.isInteger(goalCount) || goalCount < 1) throw new Error(`[fix92] capacityPlan: goalCount must be a positive integer, got ${JSON.stringify(goalCount)}`);
    if (typeof needItem !== 'string' || needItem.length === 0) throw new Error(`[fix92] capacityPlan: needItem required, got ${JSON.stringify(needItem)}`);
    if (typeof prerequisites !== 'function') throw new Error('[fix92] capacityPlan: prerequisites(item, count, inv) required');
    if (typeof toolsNeeded !== 'function') throw new Error('[fix92] capacityPlan: toolsNeeded(item) required');
    if (typeof recipesOf !== 'function') throw new Error('[fix92] capacityPlan: recipesOf(itemId) required');
    if (!Array.isArray(stacks)) throw new Error('[fix92] capacityPlan: stacks required');
    for (const s of stacks) {
        if (s === null || typeof s !== 'object' || typeof s.name !== 'string' || !Number.isInteger(s.count) || s.count < 1 || !Number.isInteger(s.slot)) {
            throw new Error(`[fix92] capacityPlan: stack is not { slot, name, count }: ${JSON.stringify(s)}`);
        }
        stackSizeOf(registry, s.name);
    }
    const counts = countsOf(stacks);
    const keep = new Map();
    for (const s of analysedSkills(skills)) {
        if (Object.hasOwn(s, 'useEvidence')) throw new Error(`[fix97] LOUD: ${s.name} has useEvidence, which is not recorded. Spends are consumeEvidence; tools and recipe ingredients come from the plan.`);
        const consumed = readEvidence(s, 'consumeEvidence');
        for (const [item, max] of Object.entries(consumed)) bumpReserve(keep, item, max, 'learned');
    }
    const pre = prerequisites(goalItem, goalCount, { ...counts });
    if (!pre || !Array.isArray(pre.ingredients)) throw new Error(`[fix92] prerequisites(${goalItem}) returned no ingredient list`);
    for (const ing of pre.ingredients) {
        if (!ing || typeof ing.item !== 'string' || !Number.isInteger(ing.count) || ing.count < 1) throw new Error(`[fix92] ingredient of ${goalItem} is malformed: ${JSON.stringify(ing)}`);
        const have = Object.hasOwn(counts, ing.item) ? counts[ing.item] : 0;
        const reserve = have < ing.count ? have : ing.count;
        bumpReserve(keep, ing.item, reserve, 'game-data');
    }
    const tools = toolsNeeded(goalItem);
    if (tools !== null) {
        if (!Array.isArray(tools)) throw new Error(`[fix92] toolsNeeded(${goalItem}) returned ${JSON.stringify(tools)}`);
        for (const t of tools) {
            if (typeof t !== 'string') throw new Error(`[fix92] toolsNeeded(${goalItem}) entry is not a name: ${JSON.stringify(t)}`);
            if (!Object.hasOwn(counts, t)) continue;
            bumpReserve(keep, t, counts[t], 'game-data');
        }
    }
    if (Object.hasOwn(counts, goalItem)) bumpReserve(keep, goalItem, counts[goalItem], 'goal');
    if (needItem !== goalItem && Object.hasOwn(counts, needItem)) bumpReserve(keep, needItem, counts[needItem], 'goal');

    const byName = new Map();
    for (const s of stacks) {
        let list = byName.get(s.name);
        if (!list) { list = []; byName.set(s.name, list); }
        list.push(s);
    }
    const names = [...byName.keys()];
    names.sort((a, b) => registry.itemsByName[a].id - registry.itemsByName[b].id);
    const candidates = [];
    const pool = [];
    for (const name of names) {
        const held = counts[name];
        const rec = keep.get(name);
        const keepN = rec ? rec.count : 0;
        const prov = rec ? provenanceText(rec.prov) : 'learned';
        const surplus = held > keepN ? held - keepN : 0;
        const id = registry.itemsByName[name].id;
        const kindStacks = byName.get(name).slice();
        kindStacks.sort((a, b) => {
            if (a.count !== b.count) return a.count - b.count;
            return a.slot - b.slot;
        });
        let potential = 0;
        let removed = 0;
        for (const st of kindStacks) {
            if (removed + st.count <= surplus) {
                potential += 1;
                removed += st.count;
                pool.push({ name, count: st.count, slot: st.slot, id, keep: keepN, provenance: prov });
            }
        }
        candidates.push({ item: name, held, keep: keepN, provenance: prov, surplus, potential });
    }
    pool.sort((a, b) => {
        if (a.count !== b.count) return a.count - b.count;
        if (a.id !== b.id) return a.id - b.id;
        return a.slot - b.slot;
    });
    const chosen = [];
    const taken = new Map();
    for (const st of pool) {
        if (chosen.length >= slotsNeeded) break;
        const already = taken.has(st.name) ? taken.get(st.name) : 0;
        const rec = keep.get(st.name);
        const keepN = rec ? rec.count : 0;
        if (already + st.count > counts[st.name] - keepN) continue;
        chosen.push(st);
        taken.set(st.name, already + st.count);
    }
    const chosenByName = new Map();
    for (const st of chosen) {
        let list = chosenByName.get(st.name);
        if (!list) { list = []; chosenByName.set(st.name, list); }
        list.push(st);
    }
    for (const c of candidates) {
        const picked = chosenByName.has(c.item) ? chosenByName.get(c.item) : [];
        let pickedCount = 0;
        for (const st of picked) pickedCount += st.count;
        const rejected = c.potential < 1;
        const remove = rejected ? c.surplus : pickedCount;
        let suffix = '';
        if (rejected) suffix = ' rejected';
        console.log(`[slot] candidate item=${c.item} held=${c.held} keep=${c.keep} provenance=${c.provenance} remove=${remove} predicted_freed=${c.potential}${suffix}`);
    }
    const removals = [];
    for (const st of chosen) {
        let g = null;
        for (const r of removals) if (r.item === st.name) g = r;
        if (g === null) {
            g = { item: st.name, remove: 0, keep: st.keep, provenance: st.provenance, stacks: [] };
            removals.push(g);
        }
        g.remove += st.count;
        g.stacks.push({ slot: st.slot, count: st.count });
    }
    const craft = bestSlotFreeingCraft(registry, recipesOf, counts);
    return { slotsNeeded, candidates, removals, freed: chosen.length, craft };
}
