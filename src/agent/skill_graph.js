// Stage 1 (PSN-style skill network + Skill-V-style regression gate) helpers.
import * as acorn from 'acorn';

/** Function declaration / async function expression assigned to `name` — AST only (no name regex on user code). */
export function signatureOf(code, name) {
    let ast;
    try {
        ast = acorn.parse(String(code), { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
    } catch (e) {
        throw new Error(`[skill_graph] signatureOf: parse failed for skill "${name}": ${e && e.message ? e.message : String(e)}`);
    }
    const paramsFrom = (fnNode) => {
        if (!fnNode.body) return '';
        const header = String(code).slice(fnNode.start, fnNode.body.start);
        const open = header.indexOf('(');
        const close = header.lastIndexOf(')');
        if (open < 0 || close <= open) return '';
        return header.slice(open + 1, close).replace(/\s+/g, ' ').trim();
    };
    let found = null;
    const walk = (node) => {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'ExportDefaultDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === name) {
            found = node.declaration;
            return;
        }
        if (node.type === 'FunctionDeclaration' && node.id?.name === name) {
            found = node;
            return;
        }
        if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === name) {
            const init = node.init;
            if (init && (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression')) found = init;
        }
        for (const k in node) {
            const v = node[k];
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v.type === 'string') walk(v);
        }
    };
    walk(ast);
    if (found) return `${name}(${paramsFrom(found)})`;
    throw new Error(`[skill_graph] signatureOf: no function declaration or assignment for "${name}" in skill source`);
}
function stripComments(code) { return String(code).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); }
// fix74: which of the host-reserved sandbox bindings (repo-owned code only) this code names outside comments
export function reservedNamesUsed(code, reserved) {
    if (!Array.isArray(reserved)) throw new Error('reservedNamesUsed: reserved must be an array of binding names');
    const src = stripComments(code);
    return reserved.filter(n => src.includes(n));
}
// fix51: strip string literals so names inside strings aren't counted as dependencies
function stripStrings(code) {
    return String(code)
        .replace(/`(?:[^`\\]|\\.)*`/g, '""')  // template literals
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')  // double-quoted strings
        .replace(/'(?:[^'\\]|\\.)*'/g, '""'); // single-quoted strings
}
// fix82: the library is ONE flat scope. Every staged bundle (writeCode, replay, repair, practice) concatenates the sources of
// the skills it needs, so every top-level binding of a skill source is a global of every bundle that stages that skill, under
// a name no catalogue, deps edge or dedupe knows about. Live 18:23:44Z writeCode "Verify the inventory contains the
// iron_pickaxe": checkForIronPickaxe (NEW 17:50:41Z) had been saved with the reply's second top-level function
// checkIronPickaxe; the new reply declared its own checkIronPickaxe, fix70's dedupe (by skill NAME only) kept the library
// source, and the bundle did not parse ("Identifier 'checkIronPickaxe' has already been declared (65:15)").
// A learned skill source is therefore exactly one top-level statement: the function declaration of its own name.
function patternNames(p) {
    if (p.type === 'Identifier') return [p.name];
    if (p.type === 'AssignmentPattern') return patternNames(p.left);
    if (p.type === 'RestElement') return patternNames(p.argument);
    if (p.type === 'ObjectPattern') return p.properties.flatMap(q => patternNames(q.type === 'RestElement' ? q : q.value));
    if (p.type === 'ArrayPattern') return p.elements.filter(e => e !== null).flatMap(patternNames);
    throw new Error(`[skill_graph] patternNames: unexpected binding pattern ${p.type}`);
}
// topLevelStatements: every top-level statement of `code`, by kind and declared name (AST; comments are not statements).
export function topLevelStatements(code) {
    let ast;
    try { ast = acorn.parse(String(code), { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); }
    catch (e) { throw new Error(`[skill_graph] topLevelStatements: parse failed: ${e.message}`); }
    return ast.body.map(n => {
        if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') return { node: n, kind: n.type, names: [n.id.name] };
        if (n.type === 'VariableDeclaration') return { node: n, kind: n.type, names: n.declarations.flatMap(d => patternNames(d.id)) };
        if (n.type === 'ExpressionStatement') {
            const x = n.expression.type === 'AwaitExpression' ? n.expression.argument : n.expression;
            return { node: n, kind: 'ExpressionStatement', names: [], calls: x.type === 'CallExpression' && x.callee.type === 'Identifier' ? x.callee.name : null };
        }
        return { node: n, kind: n.type, names: [] };
    });
}
// what in a skill source breaks the one-function rule above ([] = conforming)
export function skillSourceViolations(code, name) {
    if (typeof name !== 'string' || !name) throw new Error('skillSourceViolations: skill name required');
    const out = [];
    let own = 0;
    for (const t of topLevelStatements(code)) {
        if (t.kind === 'FunctionDeclaration' && t.names[0] === name) { own++; continue; }
        if (t.names.length) out.push(`top-level ${t.kind === 'VariableDeclaration' ? 'variable' : t.kind === 'ClassDeclaration' ? 'class' : 'function'} ${t.names.join(', ')} besides ${name}`);
        else if (t.kind === 'ExpressionStatement' && t.calls) out.push(`top-level call ${t.calls}(...) (runs whenever the skill is staged)`);
        else out.push(`top-level ${t.kind}`);
    }
    if (own !== 1) out.push(`${own} top-level declarations of function ${name} (exactly 1 required)`);
    return out;
}

// fix82: model code for a skill = the skill source plus, optionally, ONE trailing top-level call of it (writeCode runs the
// reply as is; the call is not part of what is saved). The call is cut by its AST position: the regex this replaces
// (/\n\s*await\s+\w+\(bot\);\s*$/) kept every call with arguments, so tossClutterForIron was saved ending in
// `await tossClutterForIron(bot, 4);` and would run itself in any bundle that staged it.
export function splitGeneratedCode(code, own) {
    if (typeof own !== 'string' || !own) throw new Error('splitGeneratedCode: own function name required');
    const src = String(code), body = topLevelStatements(src);
    const last = body[body.length - 1];
    const skillSource = last && last.kind === 'ExpressionStatement' && last.calls === own
        ? (src.slice(0, last.node.start) + src.slice(last.node.end)).trim()
        : src.trim();
    return { skillSource, violations: skillSourceViolations(skillSource, own) };
}
// fix82: lint feedback for the model when its code breaks the one-function rule
export function oneFunctionFeedback(own, violations) {
    if (!Array.isArray(violations) || !violations.length) throw new Error('oneFunctionFeedback: violations required');
    return `A learned skill is ONE top-level function: \`async function ${own}(bot, ...)\` (optionally followed by one call of it). Helper functions and constants go INSIDE ${own}, so they are not globals of other skills' code. Your code has: ${violations.join('; ')}`;
}
// fix70: names this code declares itself (function declarations, const/let/var). A name the code declares is its own
// definition, even when a library skill has the same name: it is not a call into the library.
export function declaredNames(code) {
    const out = new Set();
    for (const m of stripStrings(stripComments(code)).matchAll(/(?:\bfunction\s*\*?\s*|\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
    return out;
}
// fix70: a declaration `async function equipBestArmor(bot) {` matched the call pattern below, so generated code that defined
// its own equipBestArmor "depended on" the library equipBestArmor; writeCode then put the library copy into the same bundle
// and the bundle could not parse ("Identifier 'equipBestArmor' has already been declared", 13:35:42Z). Only `name` was exempt.
// names of library skills this code calls (excluding itself and the names it declares)
export function depsOf(code, name, names) {
    const src = stripStrings(stripComments(code));
    const own = declaredNames(code);
    const out = new Set();
    const re = /(?<![.\w])([A-Za-z_]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(src))) if (m[1] !== name && !own.has(m[1]) && names.has(m[1])) out.add(m[1]);
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
    
    // fix51: JS builtins derived from the real global object (isFinite, encodeURIComponent, ...), not a hand list
    const builtins = new Set(Object.getOwnPropertyNames(globalThis));
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
    // fix11 (B6) / fix68b: parent is __syncParent (explicit slot). Was AsyncLocalStorage; ALS.run around user code is
    //        fatal under stack overflow on Node 20.19 (CVE-2025-59466). fix12 SES note still applies to the prelude scope.
    // fix43: __st() now includes equipment state (eq) so equip skill contracts can be idempotent (already-equipped = success)
    // fix59: __st() also records free (empty inventory slots) so a skill's slot effect is learned, not matched by name
    // fix65: when a traced call returns, bot.__psnRunningSkill/__psnStackStr go back to its CALLER (they were cleared, so a
    //        parent that then blocked showed no stack in the watchdog's evidence)
    // fix49/fix51: __have() = getInventoryCounts (slots 5+ already include armor, held hotbar slot and off-hand: counting eq again double-counts)
    //        waitForTicks(1) before post snapshot (one server tick, not magic timers)
    // fix68: three faults made the 14:02:29Z replay of mineOneIronOre block the main thread for 22.7 s (SIGKILL):
    //   1. the harness read inventory through the BARE binding getInventoryCounts, which this same prelude rebinds to a
    //      traced wrapper whenever getInventoryCounts is in the traced names (it was: the promoted mineIronOreBlock carried
    //      built-in deps from saveSkill). Every traced call's pre-snapshot then re-entered the wrapper, whose own
    //      pre-snapshot re-entered it again, synchronously (no await before the snapshot at the root, par = -1; the 1500-record
    //      cap never tripped because the push comes after the snapshot). Each tower ran to a stack overflow, the rejected
    //      promise was dropped, and the parent started the next tower from its state snapshot: unbounded synchronous work.
    //      The harness now captures the functions it needs before any rebinding and never traces its own calls.
    //   2. the wrapper was async, so a traced SYNC function (getInventoryCounts, a learned sync helper such as
    //      isSafeTarget) returned a Promise to its caller: `counts.raw_iron` was undefined, `if (isSafeTarget(b))` always
    //      true. A sync function is now traced synchronously and returns its own value; only a returned thenable is awaited.
    //   (fix68b) nothing in the harness turns an error into a value. The towers' RangeErrors were dropped at the async
    //      wrapper boundary: `async function (...a)` turns a throw before its first await into a rejected promise, and the
    //      harness stored that promise unawaited in the snapshot (`pre: __have()`, `inv: __inv()`), so the caller simply
    //      went on to its next snapshot and the next tower. And fix51 (#42) changed fix10's `catch (e) { ...; throw e; }`
    //      to `return false`, so every exception inside traced code became a plain failed return. A traced call that throws
    //      now records the failure, writes one FAILED line (where it was thrown) and rethrows to its caller.
    //   3. the watchdog saw stack "getInventoryCounts": the harness's own bookkeeping, outside any skill, was shown as a
    //      skill. While the harness snapshots state the published stack says so: "<stack> <- (psn trace)".
    // fix68b: never run user code inside AsyncLocalStorage / async_hooks. On Node 20.19.5 a stack overflow
    //      while ALS hooks are on the stack is fatal (exit 7, CVE-2025-59466). Parent is an explicit __syncParent
    //      slot: set for the sync apply, restored when apply returns, then held again for the duration of awaiting
    //      that call's thenable so nested traced calls after `await` still see this frame. One path on every Node.
    //      finish() always runs on a fresh stack via Promise.resolve().then (inventory snapshots need stack;
    //      overflowing inside finish must not escape as uncaught). threw() only writes the FAILED line and flags (no snapshot).
    // fix70: a traced call that throws also records the top frame of the error's stack (rec.errTop; the same for every caller
    //        it is rethrown through), so the learner can tell where the error was raised: see thrownIn
    const wrap = `const __T = bot.__psnTrace = [];
const __rawInventoryCounts = getInventoryCounts;
const __inv = () => __rawInventoryCounts(bot);
const __eq = () => { const s = bot.inventory.slots; return { heldItem: s[bot.quickBarSlot + 36]?.name || null, offHand: s[45]?.name || null, helmet: s[5]?.name || null, chestplate: s[6]?.name || null, leggings: s[7]?.name || null, boots: s[8]?.name || null }; };
const __have = () => __inv();
const __st = () => { const p = bot.entity.position, b = bot.blockAt(p.floored().offset(0, 1, 0)); return { pos: { x: p.x, y: p.y, z: p.z }, hp: bot.health, food: bot.food, oxygen: bot.oxygenLevel, sky: b ? b.skyLight : null, alive: bot.health > 0, dim: String(bot.game?.dimension || ''), inv: __inv(), free: bot.inventory.emptySlotCount(), eq: __eq() }; };
let __inHarness = false;
let __syncParent = -1;
const __reported = new WeakSet();
const __harness = (stackStr, fn) => { const was = bot.__psnStackStr; bot.__psnStackStr = stackStr + ' <- (psn trace)'; __inHarness = true; try { return fn(); } finally { __inHarness = false; bot.__psnStackStr = was; } };
const __wrap = (n, f) => function (...a) {
    if (__inHarness || __T.length >= 1500) return f.apply(this, a);
    const par = __syncParent;
    const __stackParts = []; for (let __i = par; __i >= 0 && __i < __T.length; __i = __T[__i].parent) __stackParts.push(__T[__i].name); const __stackStr = [...__stackParts.reverse(), n].join(' <- ');
    bot.__psnRunningSkill = n;
    const rec = __harness(__stackStr, () => { const r0 = { name: n, args: JSON.stringify(a.slice(1)).slice(0, 120), parent: par, depth: par < 0 ? 0 : __T[par].depth + 1, o0: (bot.output || '').length, t0: Date.now(), pre: __have(), argv: a.slice(1).map(x => x === null || typeof x !== 'object' ? x : null) }; if (!n.startsWith('skills.')) r0.s0 = __st(); return r0; });
    bot.__psnStackStr = __stackStr;
    const id = __T.push(rec) - 1;
    const settle = (r) => { rec.ret = r === undefined ? 'undefined' : String(JSON.stringify(r)).slice(0, 60); rec.rv = r === null || typeof r !== 'object' ? r : null; rec.fail = r === false || r === null || r === 0; return r; };
    const threw = (e) => { rec.fail = true; const msg = e instanceof Error ? e.message : String(e); rec.err = msg; rec.rv = false; if (e instanceof Error) rec.errTop = String(e.stack).split('\\n').find(l => l.trimStart().startsWith('at ')); if (!__reported.has(e)) { if (e !== null && typeof e === 'object') __reported.add(e); bot.output = bot.output + '\\nFAILED: ' + n + ' threw ' + msg + '\\n'; } };
    const finishBody = () => { __harness(__stackStr, () => { rec.t1 = Date.now(); if (!n.startsWith('skills.')) rec.s1 = __st(); rec.o1 = (bot.output || '').length; bot.__psnOut = bot.output; const post = __have(); rec.delta = {}; for (const k of new Set([...Object.keys(rec.pre || {}), ...Object.keys(post)])) { const d = (post[k] || 0) - ((rec.pre || {})[k] || 0); if (d) rec.delta[k] = d; } delete rec.pre; rec.intr = !!bot.interrupt_code; }); bot.__psnRunningSkill = par >= 0 ? __T[par].name : null; bot.__psnStackStr = __stackParts.join(' <- '); };
    const finish = () => { Promise.resolve().then(finishBody); };
    const prev = __syncParent;
    __syncParent = id;
    let r;
    try { r = f.apply(this, a); }
    catch (e) { threw(e); finish(); throw e; }
    finally { __syncParent = prev; }
    if (r === null || typeof r !== 'object' || typeof r.then !== 'function') { settle(r); finish(); return r; }
    return (async () => {
        const prev2 = __syncParent;
        __syncParent = id;
        try {
            try { return settle(await r); }
            catch (e) { threw(e); throw e; }
            finally { await bot.waitForTicks(1); finish(); }
        } finally { __syncParent = prev2; }
    })();
};`;
    return wrap + '\n' + names.map(n => `${n} = __wrap(${JSON.stringify(n)}, ${n});`).join('\n');
}
// fix70: where a thrown error was raised, from its top stack frame. The staged program (learned skills + generated code) is
// source evaluated in an SES compartment with no file of its own: V8 ends its frames' location in "<anonymous>:L:C". Every
// other frame lives in a module file or node internals (the seeded library, mineflayer, node): an error raised there is a
// fault of that code, not of the learned skill that called it. Returns { staged, fn, loc }.
export function thrownIn(top) {
    if (typeof top !== 'string' || !top.trimStart().startsWith('at ')) throw new Error(`thrownIn: not a stack frame line: ${JSON.stringify(top)}`);
    const f = top.trim().slice(3), open = f.indexOf(' (');
    const fn = open >= 0 && f.endsWith(')') ? f.slice(0, open) : '<anonymous function>';
    const loc = open >= 0 && f.endsWith(')') ? f.slice(open + 2, -1) : f;
    const tail = loc.slice(loc.lastIndexOf(', ') + 1).trim();
    return { staged: /^<anonymous>:\d+:\d+$/.test(tail), fn, loc: tail };
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
    // fix60: a non-leaf library skill that failed although its own precondition held owns that failure; ancestors that
    // merely propagated it (no FAILED line of their own) met the callee's contract and are not blamed for it
    const owned = new Set();
    for (const [r] of pool) if (r.preHeld && !isLeaf(r.name) && isLearned(r.name)) for (let p = r.parent; p >= 0; p = trace[p].parent) owned.add(p);
    // top-down: walk each failing call's ancestry from the root so a parent is credited before its children
    for (const [r, i] of [...pool].sort((x, y) => y[0].depth - x[0].depth)) {   // deepest failure first: it defines each skill's role
        const chain = []; for (let k = i; k >= 0; k = trace[k].parent) chain.unshift(k);
        const path = chain.map(k => trace[k].name);
        const evidence = (r.ownFail.join(' | ') || r.err || `returned ${r.ret}`).slice(0, 400);
        for (const k of chain) {
            const n = trace[k].name; if (isLeaf(n) || !isLearned(n) || (k === i && trace[k].preFail)) continue;   // fix22: violated precondition -> caller's fault
            if (owned.has(k) && !trace[k].ownFail.length) continue;   // fix60: only propagated a callee-owned failure
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
