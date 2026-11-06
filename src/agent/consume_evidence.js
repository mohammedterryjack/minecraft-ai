// fix70: what a skill consumes is learned WITH its evidence, so a wrong record can be outvoted by real runs.
//   skill.consumeEvidence = { runs, items: { <item>: { runs, max } } }
//     runs       - successful runs of the skill whose inventory was measured over that run alone (before -> after)
//     items[k]   - in how many of those runs k went down, and the most it went down by
// skill.consumes is DERIVED from it: the items spent in every measured run, at the largest amount seen. An item that went
// down once because something else was acting in the window drops out at the next run that does not spend it.
// A consumes map with no evidence beside it (recorded before fix70, over the task window: eatCookedMutton's
// {cobblestone, dirt, andesite, raw_copper}) has never been re-verified, so verifiedConsumes reports nothing for it.
const count = (inv, k) => Object.hasOwn(inv, k) ? inv[k] : 0;

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
