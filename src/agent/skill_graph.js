// Stage 1 (PSN-style skill network + Skill-V-style regression gate) helpers.
export function signatureOf(code, name) {
    const m = String(code).match(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(([^)]*)\\)'));
    return m ? `${name}(${m[1].replace(/\s+/g, ' ').trim()})` : `${name}(bot)`;
}
function stripComments(code) { return String(code).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); }
// names of library skills this code calls (excluding itself)
export function depsOf(code, name, names) {
    const src = stripComments(code);
    const out = new Set();
    const re = /(?<![.\w])([A-Za-z_]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(src))) if (m[1] !== name && names.has(m[1])) out.add(m[1]);
    return [...out];
}
// bare (non skills./world./bot.) calls to camelCase identifiers that are neither library skills nor defined locally
export function missingCalls(code, name, names) {
    const src = stripComments(code);
    const local = new Set([...src.matchAll(/(?:function\s+|(?:const|let|var)\s+)([A-Za-z_]\w*)/g)].map(m => m[1]));
    const builtins = new Set(['if','for','while','switch','return','catch','function','await','async','Math','Promise','setTimeout','Number','String','Array','Object','Set','Map','JSON','Vec3','log','parseInt','parseFloat','isNaN','Boolean','Error','Date','require','console']);
    const out = new Set();
    const re = /(?<![.\w])([a-z]\w*[A-Z]\w*)\s*\(/g;   // camelCase bare calls only
    let m;
    while ((m = re.exec(src))) if (m[1] !== name && !names.has(m[1]) && !local.has(m[1]) && !builtins.has(m[1])) out.add(m[1]);
    return [...out];
}
// would giving `name` these deps create a cycle of 2+ skills? returns the cycle path or null
export function findCycle(name, deps, graph) {
    const g = { ...graph, [name]: deps };
    const seen = new Set();
    const dfs = (n, path) => {
        for (const d of g[n] || []) {
            if (d === name) return [...path, d];
            if (seen.has(d)) continue;
            seen.add(d);
            const r = dfs(d, [...path, d]);
            if (r) return r;
        }
        return null;
    };
    return dfs(name, [name]);
}
export function newStats() { return { success: 0, fail: 0, streakFail: 0, tasks: [] }; }
export function recordRun(stats, task, ok) {
    if (ok) { stats.success++; stats.streakFail = 0; if (task && !stats.tasks.includes(task)) { stats.tasks.push(task); stats.tasks = stats.tasks.slice(-10); } }
    else { stats.fail++; stats.streakFail++; }
    return stats;
}
export function rate(stats) { const n = stats.success + stats.fail; return n ? stats.success / n : 0; }
export function gateLog(msg) { console.log('[gate] ' + msg); }
