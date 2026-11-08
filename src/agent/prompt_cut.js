// fix93: the voyager code-model system prompt keeps the instruction prose and drops the
// placeholders the user message already carries (stats, inventory, docs, examples, memory, self-prompt).
// Those expansions were a second, stale copy of the same facts.

const REDUNDANT = ['$SELF_PROMPT', '$MEMORY', '$STATS', '$INVENTORY', '$CODE_DOCS', '$EXAMPLES'];

export function voyagerCodingInstructions(coding, name) {
    if (typeof coding !== 'string' || coding.length === 0) throw new Error('[fix93] profile.coding required');
    for (const marker of REDUNDANT) {
        if (!coding.includes(marker)) throw new Error(`[fix93] profile.coding has no ${marker}; the redundant expansion cannot be cut`);
    }
    let first = coding.length;
    for (const marker of REDUNDANT) {
        const at = coding.indexOf(marker);
        if (at < first) first = at;
    }
    let prose = coding.slice(0, first).trim();
    if (prose.length === 0) throw new Error('[fix93] profile.coding has no instruction prose before its placeholders');
    if (prose.includes('$NAME')) {
        if (typeof name !== 'string' || name.length === 0) throw new Error('[fix93] $NAME is in the coding instructions but the bot name is missing');
        prose = prose.replaceAll('$NAME', name);
    }
    for (const marker of REDUNDANT) {
        if (prose.includes(marker)) throw new Error(`[fix93] coding instructions still contain ${marker}`);
    }
    return prose;
}
