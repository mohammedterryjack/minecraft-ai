// fix93: a repair retry carries the rejected candidate and the exact reason it was rejected.
// An identical executable candidate is one named failure. Lint text stays text.

import { extractBareCalls } from './prompt_utils.js';

export function repairRetrySuffix({ candidate, reason, identity, n }) {
    if (typeof candidate !== 'string' || candidate.length === 0) throw new Error('[fix93] rejected candidate missing from the retry');
    if (typeof reason !== 'string' || reason.length === 0) throw new Error('[fix93] exact rejection reason missing from the retry');
    if (typeof identity !== 'string' || identity.length === 0) throw new Error('[fix93] attempt identity missing from the retry');
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new Error('[fix93] attempt number required');
    return `\n--- your previous reply was rejected ---\n${reason}\n--- rejected candidate (attempt ${n}, identity ${identity}) ---\n${candidate}\nFix the error and write a different function. Do not repeat the rejected candidate.\n`;
}

export function executableIdentity(hash, reply, extractCode) {
    if (typeof hash !== 'function') throw new Error('[fix93] hash function required');
    if (typeof extractCode !== 'function') throw new Error('[fix93] extractCode required');
    const code = extractCode(reply);
    const source = typeof code === 'string' && code.length > 0 ? code : String(reply);
    return { source, identity: hash(source) };
}

export function repeatedRejection(previous, current) {
    if (!previous || typeof previous.identity !== 'string') throw new Error('[fix93] previous attempt required');
    if (!current || typeof current.identity !== 'string') throw new Error('[fix93] current attempt required');
    if (previous.identity !== current.identity) return null;
    return {
        name: 'repeated-rejected-reply',
        attempts: [
            previous,
            { n: current.n, candidate: current.candidate, reason: previous.reason, identity: current.identity, repeated: true },
        ],
    };
}

// Built-ins the skill's own code calls. An empty result is empty: it is not the full signature list.
export function builtInsCalled(sigs, code) {
    if (!Array.isArray(sigs)) throw new Error('[fix93] built-in signatures required');
    if (typeof code !== 'string') throw new Error('[fix93] skill code required');
    const calls = new Set(extractBareCalls(code));
    const out = [];
    for (const sig of sigs) {
        if (typeof sig !== 'string') throw new Error('[fix93] built-in signature is not a string');
        const i = sig.indexOf('(');
        if (i < 1) throw new Error(`[fix93] built-in signature has no name: ${sig}`);
        const name = sig.slice(0, i);
        if (calls.has(name)) out.push(`- ${sig} [built-in]`);
    }
    return out;
}
