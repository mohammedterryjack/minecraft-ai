// fix76: typed unmet-precondition marker. Seeded skills that cannot run because a world
// prerequisite is missing call markPreconditionUnmet(bot) before returning false. The learner
// checks kind === 'precondition' — never message text.
export function markPreconditionUnmet(bot, detail) {
    if (!bot) throw new Error('[fix76] markPreconditionUnmet: bot object required');
    if (typeof bot !== 'object') throw new Error('[fix76] markPreconditionUnmet: bot object required');
    if (detail === undefined) detail = {};
    else if (detail === null) throw new Error('[fix76] markPreconditionUnmet: detail must be an object when provided');
    else if (typeof detail !== 'object') throw new Error('[fix76] markPreconditionUnmet: detail must be an object when provided');
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
