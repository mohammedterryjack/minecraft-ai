// fix76: typed unmet-precondition marker. Seeded skills that cannot run because a world
// prerequisite is missing call markPreconditionUnmet(bot, { need }) before returning false. The learner
// checks kind === 'precondition' — never message text.
// fix81: the marker must say WHAT is missing: need = { item | anyOf: [items], count, reason } (reason kind: 'tool',
// 'ingredients', 'proximity', 'place', 'contract', ...). The learner chains subgoals on it (voyager _chainNeeds).
export function checkNeed(need, source) {
    if (!need) throw new Error(`[fix81] need from ${source} must be an object`);
    if (typeof need !== 'object') throw new Error(`[fix81] need from ${source} must be an object`);
    if (typeof need.reason !== 'string') throw new Error(`[fix81] need from ${source} has no reason kind: ${JSON.stringify(need)}`);
    if (!Number.isInteger(need.count)) throw new Error(`[fix81] need from ${source} has no integer count: ${JSON.stringify(need)}`);
    if (need.count < 1) throw new Error(`[fix81] need from ${source} has count < 1: ${JSON.stringify(need)}`);
    const hasItem = typeof need.item === 'string', hasAny = Array.isArray(need.anyOf);
    if (hasItem === hasAny) throw new Error(`[fix81] need from ${source} must name exactly one of item / anyOf: ${JSON.stringify(need)}`);
    if (hasAny && !need.anyOf.length) throw new Error(`[fix81] need from ${source} has an empty anyOf`);
    return need;
}
export function markPreconditionUnmet(bot, detail) {
    if (!bot) throw new Error('[fix76] markPreconditionUnmet: bot object required');
    if (typeof bot !== 'object') throw new Error('[fix76] markPreconditionUnmet: bot object required');
    if (!detail) throw new Error('[fix81] markPreconditionUnmet: detail { need: { item | anyOf, count, reason } } required');
    if (typeof detail !== 'object') throw new Error('[fix81] markPreconditionUnmet: detail must be an object');
    checkNeed(detail.need, 'markPreconditionUnmet');
    // fix85: the need belongs to the call that is running, not to a single bot slot (last write wins, so a nested
    // iron_pickaxe need became the need of "Collect 4 oak_planks"). The trace prelude publishes that frame on the bot.
    const frame = bot.__psnFrame;
    if (typeof frame === 'number' && frame >= 0) {
        if (!Array.isArray(bot.__psnTrace)) throw new Error('[fix85] markPreconditionUnmet: bot.__psnFrame is set but bot.__psnTrace is not the trace');
        const rec = bot.__psnTrace[frame];
        if (!rec) throw new Error(`[fix85] markPreconditionUnmet: frame ${frame} is not in the trace (${bot.__psnTrace.length} records)`);
        rec.reportedNeed = detail.need;
    }
    bot.__unmetPrecondition = Object.assign({ kind: 'precondition' }, detail);
    return bot.__unmetPrecondition;
}

export function peekPreconditionUnmet(bot) {
    if (!bot) throw new Error('[fix76] peekPreconditionUnmet: bot object required');
    if (typeof bot !== 'object') throw new Error('[fix76] peekPreconditionUnmet: bot object required');
    if (!Object.hasOwn(bot, '__unmetPrecondition')) return null;
    const m = bot.__unmetPrecondition;
    if (!m) throw new Error('[fix76] __unmetPrecondition must be an object');
    if (typeof m !== 'object') throw new Error('[fix76] __unmetPrecondition must be an object');
    if (m.kind !== 'precondition') throw new Error(`[fix76] __unmetPrecondition.kind must be 'precondition', got ${JSON.stringify(m.kind)}`);
    return m;
}

export function clearPreconditionUnmet(bot) {
    if (!bot) throw new Error('[fix76] clearPreconditionUnmet: bot object required');
    if (typeof bot !== 'object') throw new Error('[fix76] clearPreconditionUnmet: bot object required');
    delete bot.__unmetPrecondition;
}
