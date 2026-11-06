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
// fix47: comprehensive local declaration detection - handles function/const/let/var, params, destructuring, arrow params, for-of, catch
export function missingCalls(code, name, names) {
    const src = stripComments(code);
    const local = new Set();
    
    // Pattern 1: function declarations and const/let/var declarations
    // e.g., function foo(...), const foo = ..., let bar, var baz
    for (const m of src.matchAll(/(?:function\s+|(?:const|let|var)\s+)([A-Za-z_]\w*)/g)) {
        local.add(m[1]);
    }
    
    // Pattern 2: function parameters (both regular and arrow functions)
    // e.g., function foo(bar, baz) {...}, (x, y) => ..., async (a, b) => ...
    for (const m of src.matchAll(/(?:function\s*\w*|(?:async\s+)?)\s*\(([^)]*)\)\s*(?:=>|\{)/g)) {
        const params = m[1];
        for (const p of params.split(',')) {
            const trimmed = p.trim().replace(/\s*=.*$/, '');  // remove default values
            const id = trimmed.match(/^([A-Za-z_]\w*)/);
            if (id) local.add(id[1]);
        }
    }
    
    // Pattern 3: arrow function single parameter (no parens)
    // e.g., const fn = x => x * 2, array.map(item => ...)
    for (const m of src.matchAll(/(?:^|[=,(\s])([A-Za-z_]\w*)\s*=>/gm)) {
        local.add(m[1]);
    }
    
    // Pattern 4: destructuring in const/let/var
    // e.g., const { foo, bar } = obj, const [a, b] = arr, const { foo: bar } = obj
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]+)\}/g)) {
        const inner = m[1];
        // Handle both { foo } and { foo: bar } patterns
        // { foo } - foo is the local variable
        // { foo: bar } - bar is the local variable (renaming)
        for (const prop of inner.split(',')) {
            const trimmed = prop.trim();
            const colonIdx = trimmed.indexOf(':');
            let localName;
            if (colonIdx !== -1) {
                // { foo: bar } pattern - bar is the local variable name
                const afterColon = trimmed.slice(colonIdx + 1).trim();
                const match = afterColon.match(/^([A-Za-z_]\w*)/);
                localName = match ? match[1] : null;
            } else {
                // { foo } pattern - foo is the local variable name
                const match = trimmed.match(/^([A-Za-z_]\w*)/);
                localName = match ? match[1] : null;
            }
            if (localName && /^[A-Za-z_]\w*$/.test(localName)) local.add(localName);
        }
    }
    for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]+)\]/g)) {
        for (const id of m[1].matchAll(/([A-Za-z_]\w*)/g)) {
            local.add(id[1]);
        }
    }
    
    // Pattern 5: for-of and for-in loop variables
    // e.g., for (const item of items), for (let key in obj)
    for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_]\w*)\s+(?:of|in)\b/g)) {
        local.add(m[1]);
    }
    
    // Pattern 6: catch clause parameter
    // e.g., catch (err) {...}, catch (e) {...}
    for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_]\w*)\s*\)/g)) {
        local.add(m[1]);
    }
    
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

// fix47: find ALL cycles in the skill graph (not just from one skill)
// Used at load time to detect and report all dependency cycles before any skill runs
export function findAllCycles(graph) {
    const cycles = [];
    const visited = new Set();
    const onStack = new Set();
    
    const dfs = (node, path) => {
        if (onStack.has(node)) {
            const cycleStart = path.indexOf(node);
            if (cycleStart >= 0) {
                cycles.push([...path.slice(cycleStart), node]);
            }
            return;
        }
        if (visited.has(node)) return;
        
        visited.add(node);
        onStack.add(node);
        
        for (const dep of graph[node] || []) {
            dfs(dep, [...path, node]);
        }
        
        onStack.delete(node);
    };
    
    for (const node of Object.keys(graph)) {
        if (!visited.has(node)) {
            dfs(node, []);
        }
    }
    
    return cycles;
}

export function newStats() { return { success: 0, fail: 0, streakFail: 0, tasks: [] }; }
export function recordRun(stats, task, ok) {
    if (ok) { stats.success++; stats.streakFail = 0; if (task && !stats.tasks.includes(task)) { stats.tasks.push(task); stats.tasks = stats.tasks.slice(-10); } }
    else { stats.fail++; stats.streakFail++; }
    return stats;
}
export function rate(stats) { const n = stats.success + stats.fail; return n ? stats.success / n : 0; }
export function gateLog(msg) { console.log('[gate] ' + msg); }

// ---------- fix10: PSN execution tracing + failure attribution ----------
// After PSN skill_graph/models/execution.py SkillExecutionTrace (call_stack, call_depth, pre/post state, execution_status)
// and optimizer/phases/reflection_chain.py (failure propagated down the executed invocation trace; caller_fix vs callee_fix).
// instrumentSrc: JS appended after the skill library inside the staged program; rebinds every skill to a wrapper that
// records one trace record per call (name, args, parent, depth, own output span, inventory delta, return, error).
export function instrumentSrc(names) {
    // fix11 (B6): parent call tracked with AsyncLocalStorage (bot.__psnALS, set by voyager.js before each run; fix12: SES compartments have their own globalThis), so parallel calls get the right parent
    // fix43: __st() now includes equipment state (eq) so equip skill contracts can be idempotent (already-equipped = success)
    // fix49: (a) wait for inventory settle via updateSlot/windowClose before post snapshot for craft skills
    //        (b) expose canonical `have` count = inv + held + offhand in state for contract synthesis
    const wrap = `const __T = bot.__psnTrace = []; const __als = bot.__psnALS; if (!__als) throw new Error('PSN trace: bot.__psnALS (AsyncLocalStorage) missing'); const __inv = () => { try { return world.getInventoryCounts(bot); } catch { return {}; } };
const __eq = () => { try { const s = bot.inventory?.slots || []; return { heldItem: s[bot.quickBarSlot + 36]?.name || null, offHand: s[45]?.name || null, helmet: s[5]?.name || null, chestplate: s[6]?.name || null, leggings: s[7]?.name || null, boots: s[8]?.name || null }; } catch { return {}; } };
const __have = () => { try { const inv = __inv(), eq = __eq(), h = {...inv}; if (eq.heldItem) h[eq.heldItem] = (h[eq.heldItem] || 0) + 1; if (eq.offHand) h[eq.offHand] = (h[eq.offHand] || 0) + 1; return h; } catch { return __inv(); } };
const __st = () => { try { const p = bot.entity.position, b = bot.blockAt(p.floored().offset(0, 1, 0)), inv = __inv(), eq = __eq(), have = __have(); return { pos: { x: p.x, y: p.y, z: p.z }, hp: bot.health, food: bot.food, sky: b ? b.skyLight : null, alive: bot.health > 0, dim: String(bot.game?.dimension || ''), inv, eq, have }; } catch (e) { return { err: String(e?.message || e) }; } };
const __waitSettle = () => new Promise(r => { let t = setTimeout(r, 150); const h = () => { clearTimeout(t); t = setTimeout(r, 80); }; bot.on('updateSlot', h); bot.once('windowClose', () => { bot.removeListener('updateSlot', h); clearTimeout(t); setTimeout(r, 50); }); setTimeout(() => { bot.removeListener('updateSlot', h); r(); }, 400); });
const __wrap = (n, f) => async function (...a) {
    if (__T.length >= 1500) return await f.apply(this, a);
    const par = __als.getStore() ?? -1;
    const rec = { name: n, args: (() => { try { return JSON.stringify(a.slice(1)).slice(0, 120); } catch { return '?'; } })(), parent: par, depth: par < 0 ? 0 : __T[par].depth + 1, o0: (bot.output || '').length, t0: Date.now(), pre: __inv(), argv: a.slice(1).map(x => x === null || typeof x !== 'object' ? x : null) };
    if (!n.startsWith('skills.')) rec.s0 = __st();
    const id = __T.push(rec) - 1;
    try { const r = await __als.run(id, () => f.apply(this, a)); rec.ret = r === undefined ? 'undefined' : String(JSON.stringify(r)).slice(0, 60); rec.rv = r === null || typeof r !== 'object' ? r : null; rec.fail = r === false || r === null || r === 0; return r; }
    catch (e) { rec.fail = true; rec.err = String(e?.message || e).slice(0, 200); throw e; }
    finally { if (/^craft/i.test(n)) await __waitSettle(); rec.t1 = Date.now(); if (!n.startsWith('skills.')) rec.s1 = __st(); rec.o1 = (bot.output || '').length; bot.__psnOut = bot.output; const post = __inv(); rec.delta = {}; for (const k of new Set([...Object.keys(rec.pre), ...Object.keys(post)])) { const d = (post[k] || 0) - (rec.pre[k] || 0); if (d) rec.delta[k] = d; } delete rec.pre; rec.intr = !!bot.interrupt_code; }
};`;
    // fix40: bare-name API - builtins and learned skills both use bare names
    // Wrap all provided names (both built-in and learned) for tracing
    // Built-in primitives (like goToPosition) are traced with their bare name
    return wrap + '\n' + names.map(n => `${n} = __wrap(${JSON.stringify(n)}, ${n});`).join('\n');
}
const FAIL_LINE = /FAILED|\bfailed\b|\bneed (?:a |an )?\w+_\w+|\bno \w+ within\b|cannot|can't|not enough/i;
// per-call contract result: failed return/exception, or a failure line emitted by the call itself (not by its children)
export function annotateTrace(trace, output) {
    const out = String(output || '');
    trace.forEach((r, i) => {
        const kids = trace.map((c, j) => [c, j]).filter(([c]) => c.parent === i).map(([c]) => [c.o0, c.o1 ?? c.o0]);
        let own = '', p = r.o0;
        for (const [a, b] of kids) { own += out.slice(p, a); p = Math.max(p, b); }
        own += out.slice(p, r.o1 ?? out.length);
        r.ownFail = own.split('\n').filter(l => FAIL_LINE.test(l)).slice(0, 4);
        r.ok = !r.intr && !r.fail && !r.ownFail.length;
    });
    return trace;
}
export function traceText(trace, max = 40) {
    return trace.slice(0, max).map(r => `${'  '.repeat(r.depth)}${r.name}(${r.args.replace(/^\[|\]$/g, '')}) -> ${r.err ? 'threw ' + r.err : r.ret}${r.ok ? '' : ' FAIL'}${Object.keys(r.delta || {}).length ? ' inv' + JSON.stringify(r.delta) : ''}${r.ownFail?.length ? ' | ' + r.ownFail.join(' | ').slice(0, 200) : ''}`).join('\n');
}
// credit assignment: blame the deepest failing call; a failing leaf (hand-written primitive, no skill deps) is never edited,
// so responsibility moves to its caller (PSN calling_pattern_issues -> caller_fix); otherwise the callee itself (callee_fix).
// fix11 (B5): prefer failures that propagated (every ancestor up to a root also failed); failures a caller caught and
// recovered from are only considered when no propagated failure exists, and are labelled 'swallowed'.
export function blame(trace, isLeaf) {
    const failed = trace.map((r, i) => [r, i]).filter(([r]) => !r.ok && !r.intr);
    if (!failed.length) return null;
    // a step child -> parent propagates if the parent also failed and did not catch the child's exception (child threw, parent returned normally)
    const propagated = failed.filter(([r]) => { for (let c = r, p = r.parent; p >= 0; c = trace[p], p = trace[p].parent) if (trace[p].ok || (c.err && !trace[p].err)) return false; return true; });
    const pool = propagated.length ? propagated : failed;
    let best = pool[0];
    for (const f of pool) if (f[0].depth > best[0].depth) best = f;
    const path = []; for (let i = best[1]; i >= 0; i = trace[i].parent) path.unshift(trace[i].name);
    let t = best[1], kind = 'callee_fix';
    while (t >= 0 && isLeaf(trace[t].name)) { t = trace[t].parent; kind = 'caller_fix'; }
    const swallowed = !propagated.length;
    const evidence = (best[0].ownFail.join(' | ') || best[0].err || `returned ${best[0].ret}`).slice(0, 400);
    if (t < 0) return { target: null, leaf: best[0].name, path, kind: 'leaf_only', swallowed, evidence };
    return { target: trace[t].name, leaf: best[0].name, path, kind, swallowed, evidence };
}
// fix20 (PSN credit assignment, top-down): every learned skill on a propagated failure path is responsible.
// The deepest non-leaf on each path is callee_fix; its failing ancestors are caller_fix (they did not handle the child's
// failure). Returned bottom-up (deepest first) so patches are applied children before parents.
export function blameAll(trace, isLeaf, isLearned) {
    const failed = trace.map((r, i) => [r, i]).filter(([r]) => !r.ok && !r.intr);
    if (!failed.length) return [];
    const prop = failed.filter(([r]) => { for (let c = r, p = r.parent; p >= 0; c = trace[p], p = trace[p].parent) if (trace[p].ok || (c.err && !trace[p].err)) return false; return true; });
    const pool = prop.length ? prop : failed, swallowed = !prop.length;
    const out = new Map();
    // top-down: walk each failing call's ancestry from the root so a parent is credited before its children
    for (const [r, i] of [...pool].sort((x, y) => y[0].depth - x[0].depth)) {   // deepest failure first: it defines each skill's role
        const chain = []; for (let k = i; k >= 0; k = trace[k].parent) chain.unshift(k);
        const path = chain.map(k => trace[k].name);
        const evidence = (r.ownFail.join(' | ') || r.err || `returned ${r.ret}`).slice(0, 400);
        for (const k of chain) {
            const n = trace[k].name; if (isLeaf(n) || !isLearned(n) || (k === i && trace[k].preFail)) continue;   // fix22: violated precondition -> caller's fault
            const kind = k === i ? 'callee_fix' : 'caller_fix';   // the failing call itself vs an ancestor that did not handle it
            const prev = out.get(n);
            if (!prev) out.set(n, { target: n, leaf: r.name, path, kind, swallowed, evidence, depth: trace[k].depth });
        }
    }
    return [...out.values()].sort((a, b) => b.depth - a.depth);
}
// all transitive parents (skills whose dependency closure contains name)
export function parentsOf(name, graph) {
    const out = new Set(); let frontier = [name];
    while (frontier.length) { const next = []; for (const [k, deps] of Object.entries(graph)) if (!out.has(k) && deps.some(d => frontier.includes(d))) { out.add(k); next.push(k); } frontier = next; }
    out.delete(name); return [...out];
}
