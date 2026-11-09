// fix93: a repair retry carries the rejected candidate and the exact reason it was rejected.
// An identical executable candidate is one named failure. Lint text stays text.

import { extractBareCalls } from './prompt_utils.js';

// fix96: a line diff of the rejected candidate against the code it was meant to replace. The current code is already in
//        the prompt, so the candidate is fully determined by the diff: every added and removed line is written, and a run of
//        unchanged lines is named by its line numbers in the current code. Repair retries used to paste the whole candidate
//        again (live: ensureCraftingTable, 7950 chars of code, 21-23k-char retry prompts that mostly repeated that code).
export function lineDiff(before, after) {
    if (typeof before !== 'string' || typeof after !== 'string') throw new Error('[fix96] lineDiff: before and after must be strings');
    const a = before.split('\n'), b = after.split('\n');
    const n = a.length, m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) { ops.push({ op: '=', i }); i++; j++; }
        else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { ops.push({ op: '+', text: b[j] }); j++; }
        else { ops.push({ op: '-', text: a[i] }); i++; }
    }
    const out = [];
    for (let k = 0; k < ops.length;) {
        if (ops[k].op === '=') {
            let e = k; while (e + 1 < ops.length && ops[e + 1].op === '=') e++;
            const from = ops[k].i + 1, to = ops[e].i + 1;
            out.push(from === to ? `  (current line ${from} unchanged)` : `  (current lines ${from}-${to} unchanged)`);
            k = e + 1;
        } else { out.push(`${ops[k].op} ${ops[k].text}`); k++; }
    }
    return out.join('\n');
}

export function repairRetrySuffix({ candidate, reason, identity, n, current }) {
    if (typeof candidate !== 'string' || candidate.length === 0) throw new Error('[fix93] rejected candidate missing from the retry');
    if (typeof reason !== 'string' || reason.length === 0) throw new Error('[fix93] exact rejection reason missing from the retry');
    if (typeof identity !== 'string' || identity.length === 0) throw new Error('[fix93] attempt identity missing from the retry');
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new Error('[fix93] attempt number required');
    if (typeof current !== 'string' || current.length === 0) throw new Error('[fix96] the current code the candidate was meant to replace is required (the retry shows the candidate as a diff of it)');
    // both forms are the whole candidate; the shorter one is sent (a candidate that rewrote most lines is shorter as itself)
    const diff = lineDiff(current, candidate);
    const shown = diff.length < candidate.length
        ? `--- rejected candidate (attempt ${n}, identity ${identity}) as a diff of the current code above ('+' added, '-' removed) ---\n${diff}`
        : `--- rejected candidate (attempt ${n}, identity ${identity}) ---\n${candidate}`;
    return `\n--- your previous reply was rejected ---\n${reason}\n${shown}\nFix the error and write a different function. Do not repeat the rejected candidate.\n`;
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

// fix96: a repair-memory lesson that records one of this skill's own proposals (same evidence, same change) is already in the
//        repair prompt as repair history; it is not shown a second time as a lesson
export function repairLessonInHistory(lesson, skill) {
    if (!lesson || typeof lesson.errorRaw !== 'string' || typeof lesson.fixSnippet !== 'string') throw new Error('[fix96] repair lesson needs errorRaw and fixSnippet');
    if (!skill || typeof skill.name !== 'string') throw new Error('[fix96] skill required');
    if (lesson.skillName !== skill.name) return false;
    return (skill.repairHistory || []).some(h => h.evidence === lesson.errorRaw && h.desc === lesson.fixSnippet);
}
