// fix70: what a skill consumes is learned WITH its evidence, so a wrong record can be outvoted by real runs.
//   skill.consumeEvidence = { runs, items: { <item>: { runs, max } } }
//     runs       - successful runs of the skill whose inventory was measured over that run alone (before -> after)
//     items[k]   - in how many of those runs k went down, and the most it went down by
// skill.consumes is DERIVED from it: the items spent in every measured run, at the largest amount seen. An item that went
// down once because something else was acting in the window drops out at the next run that does not spend it.
// A consumes map with no evidence beside it (recorded before fix70, over the task window: eatCookedMutton's
// {cobblestone, dirt, andesite, raw_copper}) has never been re-verified, so verifiedConsumes reports nothing for it.
// an inventory map lists only items held: an item absent from it is held 0 times
export const count = (inv, k) => Object.hasOwn(inv, k) ? inv[k] : 0;

export function recordConsumeEvidence(skill, inv0, inv1) {
    if (!inv0 || !inv1 || typeof inv0 !== 'object' || typeof inv1 !== 'object') throw new Error(`recordConsumeEvidence(${skill?.name}): before/after inventories are required`);
    const ev = Object.hasOwn(skill, 'consumeEvidence') ? skill.consumeEvidence : { runs: 0, items: {} };
    ev.runs++;
    for (const k of Object.keys(inv0)) {
        const spent = count(inv0, k) - count(inv1, k);
        if (spent <= 0) continue;
        const it = Object.hasOwn(ev.items, k) ? ev.items[k] : (ev.items[k] = { runs: 0, max: 0 });
        it.runs++;
        it.max = Math.max(it.max, spent);
    }
    skill.consumeEvidence = ev;
    skill.consumes = verifiedConsumes(skill);
    return skill.consumes;
}

export function verifiedConsumes(skill) {
    if (!Object.hasOwn(skill, 'consumeEvidence')) return {};
    const ev = skill.consumeEvidence, out = {};
    for (const [k, it] of Object.entries(ev.items)) if (it.runs === ev.runs) out[k] = it.max;
    return out;
}

// fix74: what a skill PRODUCES is learned the same way. Before, skill.effects was a union of every item that went up in any
// success window and could never shrink (voyager _learnEffects, fix32 d1ea48e; the window was the whole task until fix70
// 5d378f9). travelWestAvoidDeathHotspot was saved at 2026-11-06T02:47:40Z after code-model call #94, during which idle practice
// ran craftOneIronPickaxe x3, pickupNearbyItems, equipBestPickaxeForMining and findIronOreNearby; the task window's gains became
// its effects [crafting_table, cobblestone] (a westward walk produces neither), and every one of its practice runs (311 by 2026-11-06 15:47 GMT) then read
// "NOT SUCCESS: no gain for effects [crafting_table,cobblestone]".
//   skill.effectEvidence = { runs, items: { <item>: { runs, gained } } }
//     runs          - successful runs of the skill whose inventory was measured over that run alone (before -> after)
//     items[k].runs - of those, the runs since k was first seen gained in which k could count (no goal hint, or k in the goal)
//     items[k].gained - in how many of them k went up
// skill.effects is DERIVED from it: the items gained in every run in which they could count. A goal hint (fix44) only says
// which ups count in that run, so a skill that makes two items is not outvoted on one by a run whose goal was the other.
// Effects with no evidence beside them (recorded before fix74) have never been re-verified: verifiedEffects reports none.
export function recordEffectEvidence(skill, inv0, inv1, goalItems) {
    if (!inv0 || !inv1 || typeof inv0 !== 'object' || typeof inv1 !== 'object') throw new Error(`recordEffectEvidence(${skill?.name}): before/after inventories are required`);
    if (goalItems !== null && !Array.isArray(goalItems)) throw new Error(`recordEffectEvidence(${skill?.name}): goalItems must be an array or null (no goal hint), got ${JSON.stringify(goalItems)}`);
    const counts = k => goalItems === null || goalItems.includes(k);
    const ev = Object.hasOwn(skill, 'effectEvidence') ? skill.effectEvidence : { runs: 0, items: {} };
    ev.runs++;
    for (const k of Object.keys(inv1)) {
        if (count(inv1, k) > count(inv0, k) && counts(k) && !Object.hasOwn(ev.items, k)) ev.items[k] = { runs: 0, gained: 0 };
    }
    for (const [k, it] of Object.entries(ev.items)) {
        if (!counts(k)) continue;
        it.runs++;
        if (count(inv1, k) > count(inv0, k)) it.gained++;
    }
    skill.effectEvidence = ev;
    skill.effects = verifiedEffects(skill);
    return skill.effects;
}

export function verifiedEffects(skill) {
    if (!Object.hasOwn(skill, 'effectEvidence')) return [];
    return Object.entries(skill.effectEvidence.items).filter(([, it]) => it.gained === it.runs).map(([k]) => k);
}
