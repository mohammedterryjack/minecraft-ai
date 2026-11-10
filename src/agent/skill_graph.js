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
// fix83: parsed as a SCRIPT: there, two top-level declarations of one function are legal syntax, so a reply that pastes a library
//        skill next to its own function of the same name has a shape this rule can name. As a module it does not parse at all
//        ("Identifier 'craftSticks' has already been declared (47:15)", live 19:07:36 GMT), and fix82's rule never saw it: the
//        model was told only the parse error. Whether the code is valid module code is the lint's question (_parseError), not this.
// true when `code` parses as a script; otherwise the parse error text (callers must check === true: the text is not a boolean)
export function parsesAsScript(code) {
    try {
        acorn.parse(String(code), { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true });
        return true;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg) throw new Error('[skill_graph] parsesAsScript: parse failed with no message');
        return msg;
    }
}
export function topLevelStatements(code) {
    let ast;
    try { ast = acorn.parse(String(code), { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true }); }
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
    const entry = !!(last && last.kind === 'ExpressionStatement' && last.calls === own);
    const skillSource = entry
        ? (src.slice(0, last.node.start) + src.slice(last.node.end)).trim()
        : src.trim();
    return { skillSource, violations: skillSourceViolations(skillSource, own), entry };
}
// fix82: lint feedback for the model when its code breaks the one-function rule
// fix85: the reply that is executed must end with the call. The call is still cut before the skill is saved.
export function oneFunctionFeedback(own, violations, pasted) {
    if (!Array.isArray(violations) || !violations.length) throw new Error('oneFunctionFeedback: violations required');
    if (!Array.isArray(pasted)) throw new Error('oneFunctionFeedback: pasted (library skill names the code declares) required');
    const lib = pasted.length ? ` ${pasted.join(', ')} ${pasted.length === 1 ? 'is a learned skill' : 'are learned skills'} already defined for your code: call ${pasted.length === 1 ? 'it' : 'them'} by name, do not paste ${pasted.length === 1 ? 'its' : 'their'} source.` : '';
    return `A learned skill is ONE top-level function: \`async function ${own}(bot, ...)\` (the reply that runs must end with \`await ${own}(bot);\`, and that call is cut before the skill is saved). Helper functions and constants go INSIDE ${own}, so they are not globals of other skills' code. Your code has: ${violations.join('; ')}.${lib}`;
}
// fix85: a reply that only defines the function records no execution trace (live: collectLogs defined, never called)
export function entryCallFeedback(own) {
    if (typeof own !== 'string' || !own) throw new Error('entryCallFeedback: own function name required');
    return `The reply must end with exactly one call of ${own} (\`await ${own}(bot);\`) so the function runs and the execution trace records the call. A definition alone runs nothing: the task fails with no execution trace. That call is cut before the skill is saved, so the saved function does not run itself whenever it is staged.`;
}
// fix85: source text of each call of a reserved binding (whitespace-normalized). A repair must still contain each one.
export function markerCallTexts(code, name) {
    if (typeof name !== 'string' || !name) throw new Error('markerCallTexts: binding name required');
    let ast;
    try { ast = acorn.parse(String(code), { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); }
    catch (e) { throw new Error(`markerCallTexts: parse failed: ${e.message}`); }
    const src = String(code), out = [];
    const walk = n => {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === name) out.push(src.slice(n.start, n.end).replace(/\s+/g, ' '));
        for (const v of Object.values(n)) {
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
        }
    };
    walk(ast);
    return out;
}
// null when `after` still contains every call of `name` that `before` contains. A skill that did not call it must not gain one.
// fix96: the marker binding is a real sandbox endowment; the static API gate may treat it as defined exactly when the code
//        being replaced already calls it (markerCallsMissing then holds the candidate to those same calls). Before, the gate
//        always called it "not defined" while markerCallsMissing required it kept, so no skill that calls it could be
//        repaired or replaced (live: every collectBlock/ensureCraftingTable/craftRecipe repair failed both attempts).
export function markerGateNames(incumbentCode, name) {
    return markerCallTexts(incumbentCode, name).length ? [name] : [];
}
export function markerCallsMissing(before, after, name) {
    const kept = markerCallTexts(before, name);
    const now = markerCallTexts(after, name);
    if (!kept.length && now.length) return `uses ${name}, reserved for seeded primitives (a new skill must not call it; a repair of a skill that already calls it must keep those calls)`;
    // fix96: a repair keeps the incumbent's calls verbatim and adds none (each call voids a run's stats, fix76)
    const added = now.filter(c => !kept.includes(c));
    if (added.length) return `adds ${name} call(s) the current code does not have: ${added.join(' | ')}. A repair may keep the current calls, not add new ones.`;
    const missing = kept.filter(c => !now.includes(c));
    if (!missing.length) return null;
    return `repair dropped the ${name} call(s) the current code uses to report a structured need: ${missing.join(' | ')}. A repair must keep those calls. A seeded primitive that returned false after reporting a need is not a missing log line.`;
}
// fix83: library skills a reply declares at top level besides its own function, or its own name declared more than once: the
//        reply pasted their source (the prompt shows the top related skills in full)
export function pastedLibrarySkills(code, own, libraryNames) {
    if (!(libraryNames instanceof Set)) throw new Error('pastedLibrarySkills: libraryNames Set required');
    const counts = new Map();
    for (const t of topLevelStatements(code)) if (t.kind === 'FunctionDeclaration') counts.set(t.names[0], (counts.has(t.names[0]) ? counts.get(t.names[0]) : 0) + 1);
    return [...counts].filter(([n, k]) => libraryNames.has(n) && (n !== own || k > 1)).map(([n]) => n);
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

// The function calls itself, inside its own body, with its own parameters unchanged.
// A call with different arguments (bounded recursion) and a call after the function are not this.
// Returns the function name, or null when the source has no such call. Same predicate _relink used to inline.
function unconditionalSelfForward(code) {
    const fnMatch = code.match(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/);
    if (fnMatch === null) return null;
    const fnName = fnMatch[1];
    const params = fnMatch[2].split(',').map(p => p.split('=')[0].trim()).filter(Boolean);
    let bi = fnMatch.index + fnMatch[0].length, depth = 1;
    const bstart = bi;
    while (bi < code.length && depth) { const ch = code[bi]; if (ch === '{') depth++; else if (ch === '}') depth--; bi++; }
    const body = code.slice(bstart, bi - 1);
    for (const m of body.matchAll(new RegExp(`(?<![.\\w])${fnName}\\s*\\(([^)]*)\\)`, 'g'))) {
        const args = m[1].split(',').map(a => a.trim()).filter(Boolean);
        if (args.length === params.length && args.every((a, k) => a === params[k])) return fnName;
    }
    return null;
}

// fix88: one check for installing `candidate` into `skills`.
// A violation is a self-call (unconditional self-forward) or a dependency cycle the candidate would join.
// Other learned skills' edges are read from their code with the candidate's name in the set, so a skill that
// already calls the candidate is visible even when its stored deps were computed before the candidate existed.
// Seeded skills keep their stored deps (fix39: _relink does not recompute them).
// `candidate.deps` is the edge list that would be installed (saveSkill's library deps, after the seeded strip).
// Returns [] when the candidate may be installed. Callers reject before any write, and _relink throws.
export function installViolations(candidate, skills) {
    if (candidate === null || typeof candidate !== 'object') throw new Error('[fix88] installViolations: candidate skill required');
    if (typeof candidate.name !== 'string' || candidate.name.length === 0) throw new Error('[fix88] installViolations: candidate name required');
    if (typeof candidate.code !== 'string') throw new Error(`[fix88] installViolations: ${candidate.name} code must be a string`);
    if (!Array.isArray(candidate.deps)) throw new Error(`[fix88] installViolations: ${candidate.name} deps must be an array`);
    if (!Array.isArray(skills)) throw new Error('[fix88] installViolations: skills must be an array');
    const violations = [];
    const self = unconditionalSelfForward(candidate.code);
    if (self !== null) violations.push({ kind: 'self', name: candidate.name, fn: self });
    const names = new Set();
    for (const s of skills) {
        if (typeof s.name !== 'string' || s.name.length === 0) throw new Error('[fix88] installViolations: skill set entry missing name');
        names.add(s.name);
    }
    names.add(candidate.name);
    const graph = {};
    for (const s of skills) {
        if (s.name === candidate.name) continue;
        if (s.seeded === true) {
            if (!Array.isArray(s.deps)) throw new Error(`[fix88] installViolations: seeded skill ${s.name} has no deps array`);
            graph[s.name] = s.deps;
        } else {
            if (typeof s.code !== 'string') throw new Error(`[fix88] installViolations: skill ${s.name} has no code`);
            graph[s.name] = depsOf(s.code, s.name, names);
        }
    }
    graph[candidate.name] = candidate.deps;
    for (const path of findAllCycles(graph)) {
        if (!path.includes(candidate.name)) continue;
        violations.push({ kind: 'cycle', path });
    }
    return violations;
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
    const wrap = `const __T = bot.__psnTrace = []; __T.untraced = 0;   // fix96: calls past the record limit are counted, and the trace says so
const __TRACE_RECORDS = 1500;
const __rawInventoryCounts = getInventoryCounts;
const __inv = () => __rawInventoryCounts(bot);
const __eq = () => { const s = bot.inventory.slots; return { heldItem: s[bot.quickBarSlot + 36]?.name || null, offHand: s[45]?.name || null, helmet: s[5]?.name || null, chestplate: s[6]?.name || null, leggings: s[7]?.name || null, boots: s[8]?.name || null }; };
const __have = () => __inv();
const __fix98 = () => { if (bot.__fix98Facts !== true) return { isDay: null, sleeping: null, rest: null, hurtBy: null }; if (typeof bot.isSleeping !== 'boolean') throw new Error('[fix98] bot.isSleeping was not delivered'); if (!bot.time) throw new Error('[fix98] bot.time.isDay was not delivered'); if (typeof bot.time.isDay !== 'boolean') throw new Error('[fix98] bot.time.isDay was not delivered'); if (typeof bot.restSince !== 'number') throw new Error('[fix98] statistics packet missing; minecraft:time_since_rest was not delivered'); if (!Object.hasOwn(bot, 'hurtBy')) throw new Error('[fix98] bot.hurtBy was not delivered'); return { isDay: bot.time.isDay, sleeping: bot.isSleeping, rest: bot.restSince, hurtBy: bot.hurtBy }; };
const __st = () => { const p = bot.entity.position, b = bot.blockAt(p.floored().offset(0, 1, 0)); const f = __fix98(); return { pos: { x: p.x, y: p.y, z: p.z }, hp: bot.health, food: bot.food, oxygen: bot.oxygenLevel, sky: b ? b.skyLight : null, alive: bot.health > 0, dim: String(bot.game?.dimension || ''), inv: __inv(), free: bot.inventory.emptySlotCount(), eq: __eq(), isDay: f.isDay, sleeping: f.sleeping, rest: f.rest, hurtBy: f.hurtBy }; };
let __inHarness = false;
let __syncParent = -1;
bot.__psnFrame = -1;   // fix85: the frame markPreconditionUnmet stamps its need on (the bot slot is last-write-wins)
// fix83: argument text of a traced call; JSON renders NaN/Infinity as null and drops undefined, so the live trace showed
//        craftSticks(null) for the craftSticks(NaN) call its contract refused (19:03:57 GMT)
// fix96: a game object (block, entity: a name and a position) is rendered as its identity name@x,y,z. Before, the whole
//        object was JSON-rendered (light, biome, metadata...) and the text cut at 120 chars, so the trace showed
//        equipToolForBlock({"type":9,"metadata":0,"light":0,...,"biome":{"color":0,...") with neither the block name nor where
//        it was. Nothing is cut now.
const __gameObj = v => v !== null && typeof v === 'object' && typeof v.name === 'string' && v.position !== null && typeof v.position === 'object' && Number.isFinite(v.position.x);
const __valText = x => {
    if (typeof x === 'number' || x === undefined) return String(x);
    if (__gameObj(x)) return x.name + '@' + x.position.x + ',' + x.position.y + ',' + x.position.z;
    if (Array.isArray(x)) return '[' + x.map(__valText).join(',') + ']';
    return JSON.stringify(x, (k, v) => (k !== '' && __gameObj(v) ? v.name + '@' + v.position.x + ',' + v.position.y + ',' + v.position.z : v));
};
const __argText = xs => '[' + xs.map(__valText).join(',') + ']';
const __reported = new WeakSet();
const __harness = (stackStr, fn) => { const was = bot.__psnStackStr; bot.__psnStackStr = stackStr + ' <- (psn trace)'; __inHarness = true; try { return fn(); } finally { __inHarness = false; bot.__psnStackStr = was; } };
const __wrap = (n, f) => function (...a) {
    if (__inHarness) return f.apply(this, a);
    if (__T.length >= __TRACE_RECORDS) { __T.untraced += 1; return f.apply(this, a); }
    const par = __syncParent;
    const __stackParts = []; for (let __i = par; __i >= 0 && __i < __T.length; __i = __T[__i].parent) __stackParts.push(__T[__i].name); const __stackStr = [...__stackParts.reverse(), n].join(' <- ');
    bot.__psnRunningSkill = n;
    const rec = __harness(__stackStr, () => { const r0 = { name: n, args: __argText(a.slice(1)), parent: par, depth: par < 0 ? 0 : __T[par].depth + 1, o0: (bot.output || '').length, t0: Date.now(), pre: __have(), argv: a.slice(1).map(x => x === null || typeof x !== 'object' ? x : null) }; if (!n.startsWith('skills.')) r0.s0 = __st(); return r0; });
    bot.__psnStackStr = __stackStr;
    const id = __T.push(rec) - 1;
    const settle = (r) => { rec.ret = __valText(r); rec.rv = r === null || typeof r !== 'object' ? r : null; rec.fail = r === false || r === null || r === 0; return r; };
    const threw = (e) => { rec.fail = true; const msg = e instanceof Error ? e.message : String(e); rec.err = msg; rec.rv = false; if (e instanceof Error) rec.errTop = String(e.stack).split('\\n').find(l => l.trimStart().startsWith('at ')); if (!__reported.has(e)) { if (e !== null && typeof e === 'object') __reported.add(e); bot.output = bot.output + '\\nFAILED: ' + n + ' threw ' + msg + '\\n'; } };
    const finishBody = () => { __harness(__stackStr, () => { rec.t1 = Date.now(); if (!n.startsWith('skills.')) rec.s1 = __st(); rec.o1 = (bot.output || '').length; bot.__psnOut = bot.output; const post = __have(); rec.delta = {}; for (const k of new Set([...Object.keys(rec.pre || {}), ...Object.keys(post)])) { const d = (post[k] || 0) - ((rec.pre || {})[k] || 0); if (d) rec.delta[k] = d; } delete rec.pre; rec.intr = !!bot.interrupt_code; }); bot.__psnRunningSkill = par >= 0 ? __T[par].name : null; bot.__psnStackStr = __stackParts.join(' <- '); };
    const finish = () => { Promise.resolve().then(finishBody); };
    const prev = __syncParent;
    __syncParent = id;
    bot.__psnFrame = id;
    let r;
    try { r = f.apply(this, a); }
    catch (e) { threw(e); finish(); throw e; }
    finally { __syncParent = prev; bot.__psnFrame = prev; }
    if (r === null || typeof r !== 'object' || typeof r.then !== 'function') { settle(r); finish(); return r; }
    return (async () => {
        const prev2 = __syncParent;
        __syncParent = id;
        bot.__psnFrame = id;
        try {
            try { return settle(await r); }
            catch (e) { threw(e); throw e; }
            finally { await bot.waitForTicks(1); finish(); }
        } finally { __syncParent = prev2; bot.__psnFrame = prev2; }
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
        r.ownFail = own.split('\n').filter(l => FAIL_LINE.test(l));
        r.ok = !r.intr && !r.fail && !r.ownFail.length;
    });
    return trace;
}
// fix96: identical consecutive lines (a call repeated in a loop with the same arguments and outcome, the same failure line
//        printed again) are written once with their count; that is the whole trace, nothing is cut. Before, the trace kept
//        its first 40/60 calls and each call's failure lines were cut at 4 lines / 200 chars.
export function collapseRepeats(lines) {
    if (!Array.isArray(lines)) throw new Error('collapseRepeats: lines array required');
    const out = [];
    for (const l of lines) {
        const last = out[out.length - 1];
        if (last && last.text === l) last.n += 1; else out.push({ text: l, n: 1 });
    }
    return out.map(o => (o.n > 1 ? `${o.text} (x${o.n})` : o.text));
}
export function traceText(trace) {
    if (!Array.isArray(trace)) throw new Error('traceText: trace array required');
    const line = r => `${'  '.repeat(r.depth)}${r.name}(${r.args.replace(/^\[|\]$/g, '')}) -> ${r.err ? 'threw ' + r.err : r.ret}${r.ok ? '' : ' FAIL'}${Object.keys(r.delta || {}).length ? ' inv' + JSON.stringify(r.delta) : ''}${r.ownFail?.length ? ' | ' + collapseRepeats(r.ownFail).join(' | ') : ''}`;
    const kids = trace.map(() => []), roots = [];
    trace.forEach((r, i) => { if (r.parent >= 0 && r.parent < trace.length) kids[r.parent].push(i); else roots.push(i); });
    // fix96: a call repeated in a loop with the same arguments, outcome and sub-calls is written once with its count (live:
    //        "collectItem (767 calls)" was collectLogs() and its 11 sub-calls, identical, ~60 times in a row)
    const block = i => [line(trace[i]), ...siblings(kids[i])];
    const siblings = ids => {
        const out = [];
        let prev = null, n = 0;
        const flush = () => { if (!prev) return; out.push(n > 1 ? `${prev[0]} (x${n}: this call${prev.length > 1 ? ` and the ${prev.length - 1} under it` : ''} ran ${n} times in a row, identically)` : prev[0], ...prev.slice(1)); };
        for (const id of ids) {
            const b = block(id);
            if (prev && b.length === prev.length && b.every((l, k) => l === prev[k])) { n += 1; continue; }
            flush(); prev = b; n = 1;
        }
        flush();
        return out;
    };
    const text = siblings(roots);
    if (trace.untraced > 0) text.push(`(${trace.untraced} further call(s) ran after the trace's ${trace.length} records and were not recorded)`);
    return text.join('\n');
}
// Numbers are the part of a line that changes between repeats: coordinates, timestamps, distances, vitals.
// The words are the fact. Two lines with the same words are the same fact.
export function factKey(line) {
    return String(line).replace(/-?\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();
}
// Lines that share every word and differ only by numbers are one template. Each numeric slot is a series:
// an exact run (`16 x 4`), an arithmetic range (`0..399 step 1, x400`), or the values themselves.
// Zero-padding is not part of the value: `00` and `0` are the same number. Nothing is sliced.
const NUMERIC_TOKEN = /-?\d+(?:\.\d+)?/g;
function numericSlots(line) {
    const values = [];
    const template = line.replace(NUMERIC_TOKEN, (m) => {
        values.push(Number(m));
        return `{${values.length - 1}}`;
    });
    return { template, values };
}
function sameNumbers(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
function runLength(values, i) {
    let j = i + 1;
    while (j < values.length && values[j] === values[i]) j += 1;
    return j - i;
}
function arithmeticLength(values, i) {
    if (i + 2 >= values.length) return 1;
    if (!Number.isInteger(values[i]) || !Number.isInteger(values[i + 1])) return 1;
    const step = values[i + 1] - values[i];
    if (step === 0) return 1;
    let j = i + 2;
    while (j < values.length && Number.isInteger(values[j]) && values[j] - values[j - 1] === step) j += 1;
    return j - i;
}
function formatNum(n) {
    return String(n);
}
// One slot's values, in order. A constant run of 2 or more is `v x N`. An integer arithmetic run of 3 or more
// is `start..end step k, xN`. Anything shorter is written out. The pieces are separated by `; `.
function encodeSeries(values) {
    const parts = [];
    let i = 0;
    while (i < values.length) {
        const constant = runLength(values, i);
        const arithmetic = arithmeticLength(values, i);
        if (constant >= 2 && constant >= arithmetic) {
            parts.push(`${formatNum(values[i])} x ${constant}`);
            i += constant;
            continue;
        }
        if (arithmetic >= 3) {
            const step = values[i + 1] - values[i];
            const end = values[i] + (arithmetic - 1) * step;
            parts.push(`${formatNum(values[i])}..${formatNum(end)} step ${formatNum(step)}, x${arithmetic}`);
            i += arithmetic;
            continue;
        }
        const start = i;
        i += 1;
        while (i < values.length && runLength(values, i) < 2 && arithmeticLength(values, i) < 3) i += 1;
        parts.push(values.slice(start, i).map(formatNum).join(', '));
    }
    return parts.join('; ');
}
function expandSeries(spec) {
    const parts = String(spec).split(';').map(s => s.trim()).filter(s => s.length > 0);
    const out = [];
    for (const p of parts) {
        let m = p.match(/^(-?\d+(?:\.\d+)?) x (\d+)$/);
        if (m) {
            const v = Number(m[1]);
            const n = Number(m[2]);
            if (!Number.isInteger(n) || n < 1) throw new Error(`[fix97] series run is not a count: ${p}`);
            for (let i = 0; i < n; i++) out.push(v);
            continue;
        }
        m = p.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?) step (-?\d+(?:\.\d+)?), x(\d+)$/);
        if (m) {
            const start = Number(m[1]), end = Number(m[2]), step = Number(m[3]), n = Number(m[4]);
            if (!Number.isInteger(n) || n < 2 || !Number.isInteger(step) || step === 0) throw new Error(`[fix97] series range is not an integer step: ${p}`);
            const produced = [];
            for (let i = 0; i < n; i++) {
                const v = start + i * step;
                if (!Number.isInteger(v)) throw new Error(`[fix97] series range left the integers: ${p}`);
                produced.push(v);
            }
            if (produced[produced.length - 1] !== end) throw new Error(`[fix97] series range ${p} ended at ${produced[produced.length - 1]}`);
            out.push(...produced);
            continue;
        }
        if (p.length === 0) throw new Error('[fix97] series has an empty piece');
        for (const tok of p.split(',')) {
            const t = tok.trim();
            if (!/^-?\d+(?:\.\d+)?$/.test(t)) throw new Error(`[fix97] series value is not a number: ${JSON.stringify(t)}`);
            out.push(Number(t));
        }
    }
    return out;
}
function requireText(fn, text) {
    if (typeof text !== 'string') {
        const shown = text === undefined ? 'undefined' : text === null ? 'null' : typeof text;
        throw new Error(`[fix97] ${fn}: text must be a string, got ${shown}`);
    }
}
export function groupVaryingLines(text) {
    requireText('groupVaryingLines', text);
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    const groups = new Map();
    const order = [];
    lines.forEach((line, index) => {
        const { template, values } = numericSlots(line);
        let g = groups.get(template);
        if (!g) { g = { first: line, rows: [], at: [] }; groups.set(template, g); order.push(template); }
        g.rows.push(values);
        g.at.push(index);
    });
    // First-seen grouping pulls every row of a template together, so interleaved facts lose their order.
    // When that happens each row keeps the index it had in this text (`at:`), and the series of indexes
    // is the same encoding as the values. A text whose groups are already in order needs no index.
    let cursor = 0;
    let inOrder = true;
    for (const template of order) {
        for (const index of groups.get(template).at) {
            if (index !== cursor) inOrder = false;
            cursor += 1;
        }
    }
    const out = [];
    for (const template of order) {
        const g = groups.get(template);
        const n = g.rows.length;
        const slots = g.rows[0] ? g.rows[0].length : 0;
        const constant = g.rows.every(row => sameNumbers(row, g.rows[0]));
        if (n === 1 && inOrder) {
            // A generated header is `body (xN)` and is not escaped. A raw line escapes `\` and then a trailing
            // ` (xN)`, so the escape is reversible even when the line already contained a backslash.
            out.push(encodeRaw(g.first));
            continue;
        }
        const header = constant ? g.first : template;
        out.push(`${header} (x${n})`);
        if (!inOrder) out.push(`  at: ${encodeSeries(g.at)}`);
        if (!constant) {
            for (let s = 0; s < slots; s++) out.push(`  {${s}}: ${encodeSeries(g.rows.map(row => row[s]))}`);
        }
    }
    return out.join('\n');
}
function slotLine(line) {
    return typeof line === 'string' && (/^  at: /.test(line) || /^  \{\d+\}: /.test(line));
}
function encodeRaw(line) {
    const doubled = line.replaceAll('\\', '\\\\');
    return doubled.replace(/ \(x(\d+)\)$/, ' \\(x$1)');
}
function decodeRaw(line) {
    const marked = line.match(/^(.*?)(\\+)\(x(\d+)\)$/);
    let text = line;
    if (marked && marked[2].length % 2 === 1) text = `${marked[1]}${marked[2].slice(1)}(x${marked[3]})`;
    return text.replaceAll('\\\\', '\\');
}
function groupHeader(line) {
    if (typeof line !== 'string') return null;
    const m = line.match(/^(.*) \(x(\d+)\)$/);
    if (!m) return null;
    const n = Number(m[2]);
    if (!Number.isInteger(n) || n < 1) return null;
    return { body: m[1], n };
}
function readGroup(lines, i) {
    const header = groupHeader(lines[i]);
    if (!header) return null;
    if (!slotLine(lines[i + 1])) {
        if (header.n >= 2 && !/\{\d+\}/.test(header.body)) return { body: header.body, n: header.n, at: null, slots: null, next: i + 1 };
        return null;
    }
    let j = i + 1;
    let at = null;
    const slots = [];
    let sawSlot = false;
    while (j < lines.length && slotLine(lines[j])) {
        if (lines[j].startsWith('  at: ')) {
            if (at) throw new Error(`[fix97] template ${header.body} has two order indexes`);
            at = expandSeries(lines[j].slice(6));
        } else {
            const sm = lines[j].match(/^  \{(\d+)\}: (.*)$/);
            slots[Number(sm[1])] = expandSeries(sm[2]);
            sawSlot = true;
        }
        j += 1;
    }
    return { body: header.body, n: header.n, at, slots: sawSlot ? slots : null, next: j };
}
function linesOfGroup(g) {
    if (!g.slots) {
        const copies = [];
        for (let k = 0; k < g.n; k++) copies.push(g.body);
        return copies;
    }
    const expected = (g.body.match(/\{\d+\}/g) || []).length;
    if (g.slots.length !== expected) throw new Error(`[fix97] template ${g.body} has ${expected} slots and ${g.slots.length} series`);
    for (let s = 0; s < g.slots.length; s++) {
        if (!g.slots[s] || g.slots[s].length !== g.n) throw new Error(`[fix97] slot {${s}} of ${g.body} has ${g.slots[s] ? g.slots[s].length : 0} values for ${g.n} lines`);
    }
    const rows = [];
    for (let r = 0; r < g.n; r++) {
        let rebuilt = g.body;
        for (let s = g.slots.length - 1; s >= 0; s--) rebuilt = rebuilt.replaceAll(`{${s}}`, String(g.slots[s][r]));
        rows.push(rebuilt);
    }
    return rows;
}
function placeGroups(groups) {
    const rows = groups.map(g => ({ g, lines: linesOfGroup(g) }));
    let count = 0;
    let max = -1;
    for (const row of rows) {
        if (!row.g.at || row.g.at.length !== row.lines.length) throw new Error(`[fix97] template ${row.g.body} order index has ${row.g.at ? row.g.at.length : 0} positions for ${row.lines.length} lines`);
        for (const index of row.g.at) {
            if (!Number.isInteger(index) || index < 0) throw new Error(`[fix97] order index ${index} is not a position`);
            if (index > max) max = index;
        }
        count += row.lines.length;
    }
    if (max + 1 !== count) throw new Error(`[fix97] order index does not cover ${count} lines (max ${max})`);
    const placed = new Array(count);
    for (const row of rows) {
        for (let r = 0; r < row.lines.length; r++) {
            const index = row.g.at[r];
            if (placed[index] !== undefined) throw new Error(`[fix97] order index ${index} is used twice`);
            placed[index] = row.lines[r];
        }
    }
    if (placed.some(line => line === undefined)) throw new Error('[fix97] order index has a hole');
    return placed;
}
// Expand a templated block back to the lines it was built from, in their original order.
// An `at:` series is the index of each row. A block with no `at:` was already in order.
// `recoverTemplatedLines(groupVaryingLines(text))` is those lines, with each numeric token written in decimal.
export function recoverTemplatedLines(text) {
    requireText('recoverTemplatedLines', text);
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (/^  (?:at: |\{\d+\}: )/.test(lines[i])) throw new Error(`[fix97] series slot has no template: ${lines[i]}`);
        const first = readGroup(lines, i);
        if (!first) { out.push(decodeRaw(lines[i])); continue; }
        if (!first.at) {
            out.push(...linesOfGroup(first));
            i = first.next - 1;
            continue;
        }
        const groups = [first];
        let j = first.next;
        while (j < lines.length) {
            const next = readGroup(lines, j);
            if (!next || !next.at) break;
            groups.push(next);
            j = next.next;
        }
        out.push(...placeGroups(groups));
        i = j - 1;
    }
    return out;
}
function callErrorText(r) {
    const lines = [];
    if (Array.isArray(r.ownFail)) lines.push(...r.ownFail.filter(l => typeof l === 'string' && l.length > 0));
    return collapseRepeats(lines).join(' | ');
}
function outcomeText(r) {
    return r.err ? `threw ${r.err}` : `${r.ret}${r.ok ? '' : ' FAIL'}`;
}
function callHead(trace, r) {
    const parent = Number.isInteger(r.parent) && r.parent >= 0 && r.parent < trace.length ? trace[r.parent].name : '';
    const args = r.args.replace(/^\[|\]$/g, '');
    return `${parent ? parent + ' > ' : ''}${r.name}(${args}) -> ${outcomeText(r)}`;
}
// One line per call, then lines that differ only by numbers share a template. The outcome and the error stay in the
// line, so a different return or a different sentence is a different template. The series keeps every value.
export function structuredTrace(trace) {
    if (!Array.isArray(trace)) throw new Error('structuredTrace: trace array required');
    const lines = [];
    for (let i = 0; i < trace.length; i++) {
        const r = trace[i];
        if (!r || typeof r.name !== 'string' || r.name.length === 0) throw new Error(`structuredTrace: record ${i} has no name`);
        if (typeof r.args !== 'string') throw new Error(`structuredTrace: ${r.name} args are not text`);
        const errors = callErrorText(r);
        lines.push(`${callHead(trace, r)}${errors ? ' | ' + errors : ''}`);
    }
    if (trace.untraced > 0) lines.push(`(${trace.untraced} further call(s) ran after the trace's ${trace.length} records and were not recorded)`);
    return groupVaryingLines(lines.join('\n'));
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
    const evidence = (collapseRepeats(best[0].ownFail).join(' | ') || best[0].err || `returned ${best[0].ret}`);
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
    // fix85: a frame that reported a structured need failed because that need is unmet, not because its source is wrong.
    // It is not repaired. Ancestors that only propagated it (no failure line of their own) are not blamed for the log line
    // the marker's comment was copied into (live collectBlock: the reach call became log("FAILED: no source within reach...")).
    const structured = new Set();
    for (const [r, i] of pool) if (r.reportedNeed) {
        structured.add(i);
        for (let p = r.parent; p >= 0; p = trace[p].parent) if (!(trace[p].ownFail || []).length) structured.add(p);
    }
    // top-down: walk each failing call's ancestry from the root so a parent is credited before its children
    for (const [r, i] of [...pool].sort((x, y) => y[0].depth - x[0].depth)) {   // deepest failure first: it defines each skill's role
        const chain = []; for (let k = i; k >= 0; k = trace[k].parent) chain.unshift(k);
        const path = chain.map(k => trace[k].name);
        const evidence = (collapseRepeats(r.ownFail).join(' | ') || r.err || `returned ${r.ret}`);
        for (const k of chain) {
            const n = trace[k].name; if (isLeaf(n) || !isLearned(n) || (k === i && trace[k].preFail)) continue;   // fix22: violated precondition -> caller's fault
            if (owned.has(k) && !trace[k].ownFail.length) continue;   // fix60: only propagated a callee-owned failure
            if (structured.has(k)) continue;   // fix85: a reported structured need, or an ancestor that only propagated it
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
