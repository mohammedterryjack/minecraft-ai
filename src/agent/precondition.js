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

// fix87: a search that found no block of these names. Names that are not blocks in the game data are not a reach
// need (the caller still reports its own failure). Returns the need, or null when none of the names is a block.
export function reachNeedForBlocks(blocksByName, blockNames, count) {
    if (!blocksByName || typeof blocksByName !== 'object') throw new Error('[fix87] reachNeedForBlocks: blocksByName required');
    if (!Array.isArray(blockNames) || blockNames.length === 0) throw new Error('[fix87] reachNeedForBlocks: block names required');
    for (const n of blockNames) if (typeof n !== 'string' || n === '') throw new Error(`[fix87] reachNeedForBlocks: block name must be a non-empty string, got ${JSON.stringify(n)}`);
    if (!Number.isInteger(count) || count < 1) throw new Error(`[fix87] reachNeedForBlocks: positive integer count required, got ${JSON.stringify(count)}`);
    const blocks = [];
    for (const n of blockNames) if (Object.hasOwn(blocksByName, n) && !blocks.includes(n)) blocks.push(n);
    if (!blocks.length) return null;
    return blocks.length === 1 ? { item: blocks[0], count, reason: 'reach' } : { anyOf: blocks, count, reason: 'reach' };
}

// fix87: the search gave up. Stamp a reach need on the running call when the name is a block in the game data.
export function markBlockOutOfRange(bot, blockNames, count) {
    if (!bot || typeof bot !== 'object') throw new Error('[fix87] markBlockOutOfRange: bot required');
    if (!bot.registry || !bot.registry.blocksByName) throw new Error('[fix87] markBlockOutOfRange: bot.registry.blocksByName required');
    const need = reachNeedForBlocks(bot.registry.blocksByName, blockNames, count);
    if (need === null) {
        console.error(`[fix87] LOUD: search miss for ${blockNames.join(' / ')} is not a block in the game data; no reach need`);
        return null;
    }
    const named = need.item || need.anyOf.join(' / ');
    console.error(`[fix87] LOUD: no ${named} within search range; reporting a reach need of ${count}`);
    return markPreconditionUnmet(bot, { need });
}

export function clearPreconditionUnmet(bot) {
    if (!bot) throw new Error('[fix76] clearPreconditionUnmet: bot object required');
    if (typeof bot !== 'object') throw new Error('[fix76] clearPreconditionUnmet: bot object required');
    delete bot.__unmetPrecondition;
}
