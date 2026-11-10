import { writeFile, readFile, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import { Vec3 } from 'vec3';
import * as acorn from "acorn";
const { tokenizer: acornTokenizer, tokTypes } = acorn;
import pf from 'mineflayer-pathfinder';
import { logPromptBreakdown } from './prompt_utils.js';
import { withStallPhase, pushStallPhase, popStallPhase, getStallPhaseStack } from '../utils/event_loop_guard.js';
import { mainThreadWatchdogStarted, publishMainThreadCode } from '../utils/main_thread_watchdog.js';
import { wrapBotForApiTiming } from '../utils/bot_api_timing.js';
import { markPreconditionUnmet } from './precondition.js';

// fix38: expose pathfinder goals to generated code (fail loud if missing)
const pathfinderGoals = pf.goals;
if (!pathfinderGoals || !pathfinderGoals.GoalNear) {
    throw new Error('[coder] FATAL: mineflayer-pathfinder goals not available - GoalNear and siblings will be undefined at runtime');
}
// fix61: pathfinder goal endowments of the exec sandbox; the lint prelude declares exactly these names too
export const SANDBOX_GOALS = {
    GoalNear: pathfinderGoals.GoalNear,
    GoalFollow: pathfinderGoals.GoalFollow,
    GoalInvert: pathfinderGoals.GoalInvert,
    GoalBlock: pathfinderGoals.GoalBlock,
    GoalXZ: pathfinderGoals.GoalXZ,
    GoalNearXZ: pathfinderGoals.GoalNearXZ,
    GoalGetToBlock: pathfinderGoals.GoalGetToBlock,
    GoalLookAtBlock: pathfinderGoals.GoalLookAtBlock,
    GoalBreakBlock: pathfinderGoals.GoalBreakBlock,
    GoalCompositeAny: pathfinderGoals.GoalCompositeAny,
    GoalCompositeAll: pathfinderGoals.GoalCompositeAll,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function _trimLineAt(code, line1) {
    const lines = code.split('\n');
    const raw = lines[line1 - 1];
    if (raw === undefined) throw new Error(`[coder] line ${line1} out of range (${lines.length} lines in source)`);
    return raw.trim();
}

// fix40/41: unified bare-name API - all functions (built-in + learned) use bare names only
// Exported for voyager.js to build the unified signature list for prompts
// fix41: Object.keys registration for every exported function even when extractSig regex misses
let _bareAPICache = null;
// fix83: getInventoryCounts(bot) lists only the items the bot holds, so `getInventoryCounts(bot).stick` is undefined when it holds
//        none and arithmetic on it is NaN. Live 19:03:50 GMT: the generated ensureSticks did `const currentSticks =
//        getInventoryCounts(bot).stick; const neededSticks = 2 - currentSticks; await craftSticks(bot, neededSticks)` with no
//        sticks, and craftSticks' precondition refused craftSticks(NaN) (traced as craftSticks(null)). Lint feedback for the
//        model (the code is not rewritten): every arithmetic operand that is an item count read straight from
//        getInventoryCounts(...), directly, through a variable holding the counts, or through a variable holding one count.
const ARITH_OPS = new Set(['+', '-', '*', '/', '%', '**']);
export function missingCountArithmetic(code) {
    let ast;
    try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); }
    catch (e) { throw new Error(`[fix83] missingCountArithmetic: called on code that does not parse (${e.message}); userGeneratedCodeLintBlockers reports parse errors first`); }
    const isCountsCall = n => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'getInventoryCounts';
    const countsVars = new Set(), countVars = new Map();
    const isCountRead = n => n.type === 'MemberExpression' && (isCountsCall(n.object) || (n.object.type === 'Identifier' && countsVars.has(n.object.name)));
    const visit = (n, f) => {
        if (!n || typeof n.type !== 'string') return;
        f(n);
        for (const v of Object.values(n)) { if (Array.isArray(v)) for (const x of v) visit(x, f); else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, f); }
    };
    visit(ast, n => {
        if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier' || n.init === null) return;
        if (isCountsCall(n.init)) countsVars.add(n.id.name);
    });
    visit(ast, n => {
        if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier' || n.init === null) return;
        if (isCountRead(n.init)) countVars.set(n.id.name, code.slice(n.init.start, n.init.end));
    });
    const out = [];
    visit(ast, n => {
        if (n.type !== 'BinaryExpression' || !ARITH_OPS.has(n.operator)) return;
        for (const side of [n.left, n.right]) {
            const read = isCountRead(side) ? code.slice(side.start, side.end) : side.type === 'Identifier' && countVars.has(side.name) ? `${side.name} (= ${countVars.get(side.name)})` : null;
            if (read !== null) out.push(`\`${code.slice(n.start, n.end)}\`: ${read} is undefined when the bot holds none of that item (getInventoryCounts lists only held items), so this is NaN. Read the count with a check that the item is listed.`);
        }
    });
    return out;
}
// fix74: internal sandbox binding of markPreconditionUnmet (see _stageCode endowments); seeded primitives call it by this name
export const PRECONDITION_UNMET_BINDING = '__mcPreconditionUnmet__';
export function getBareAPI() {
    if (_bareAPICache) return _bareAPICache;
    const extractSig = (fn, modName) => {
        const str = fn.toString();
        const match = str.match(/function\s+\w+\s*\(([^)]*)\)/);
        if (!match) return null;
        const params = match[1].trim();
        return { name: fn.name, sig: `${fn.name}(${params})`, source: modName };
    };
    // fix41: collect ALL function keys first, then try extractSig; fallback to name() if regex misses
    const skillKeys = Object.keys(skills).filter(k => typeof skills[k] === 'function' && k !== 'log');
    const worldKeys = Object.keys(world).filter(k => typeof world[k] === 'function');
    const skillsFns = skillKeys.map(k => extractSig(skills[k], 'skills') || { name: k, sig: `${k}()`, source: 'skills' });
    const worldFns = worldKeys.map(k => extractSig(world[k], 'world') || { name: k, sig: `${k}()`, source: 'world' });
    const all = [...skillsFns, ...worldFns];
    _bareAPICache = { 
        names: new Set(all.map(f => f.name)),
        sigs: all.map(f => f.sig),
        byName: Object.fromEntries(all.map(f => [f.name, f]))
    };
    return _bareAPICache;
}
// fix60: closest real member of the live bot object, reflected at runtime (own and inherited properties, no name list).
// Members of the same kind (callable vs value, read from property descriptors so no getter runs) rank first, then the most
// shared camelCase words (Jaccard overlap), then the smallest edit distance. Returns the closest few, best first.
export function botMembers(bot) {
    const out = new Map();
    for (let o = bot; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
        for (const k of Object.getOwnPropertyNames(o)) {
            if (out.has(k) || k === 'constructor' || k.startsWith('_')) continue;
            const d = Object.getOwnPropertyDescriptor(o, k);
            out.set(k, 'value' in d && typeof d.value === 'function');
        }
    return out;
}
export function nearestBotMember(bot, name, isCall) {
    const words = s => s.split(/(?=[A-Z])/).map(w => w.toLowerCase());
    const want = new Set(words(name));
    const lev = (a, b) => { let prev = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[b.length]; };
    const scored = [...botMembers(bot)].map(([k, fn]) => ({ k, kind: fn === isCall ? 0 : 1, shared: -(() => { const w = new Set(words(k)); const n = [...w].filter(x => want.has(x)).length; return n / new Set([...w, ...want]).size; })(), d: lev(name.toLowerCase(), k.toLowerCase()) }));
    if (!scored.length) throw new Error('nearestBotMember: the live bot exposes no members');
    scored.sort((a, b) => a.kind - b.kind || a.shared - b.shared || a.d - b.d);
    return scored.slice(0, 3).map(x => x.k);
}
// fix40: legacy getRealAPI for compatibility (returns both bare and prefixed forms)
export function getRealAPI() {
    const bare = getBareAPI();
    const list = bare.sigs.map(s => {
        const name = s.split('(')[0];
        const fn = bare.byName[name];
        return fn ? `${fn.source}.${s}` : s;
    });
    return { set: new Set(list), list };
}

/**
 * Which built-in skill/world bare names the source references (for smaller lint/exec bindings).
 * fix73: every reference counts, not only call sites. #44 (da3cfce) collected CallExpression callees only; fix68 (#61) made
 * the PSN harness read inventory through a value reference (`const __rawInventoryCounts = getInventoryCounts;`), so a
 * traced bundle that never called getInventoryCounts( itself was staged without that endowment, the SES compartment
 * resolved the free name to undefined, and the first trace snapshot threw "__rawInventoryCounts is not a function"
 * (15:06:47Z replay of scanForIronOreBlocks). A name passed, stored or rebound (`x = __wrap("x", x)`) is used as much as
 * a called one. Not references: the property of `obj.name` and a non-computed object/class key.
 */
export function collectBareApiUsedInSource(combinedSrc) {
    const skillNames = new Set();
    const worldNames = new Set();
    const skillKeySet = new Set(Object.keys(skills).filter((k) => typeof skills[k] === 'function' && k !== 'log'));
    const worldKeySet = new Set(Object.keys(world).filter((k) => typeof world[k] === 'function'));
    let ast;
    try {
        ast = acorn.parse(String(combinedSrc), { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
    } catch (e) {
        const loc = e && typeof e.pos === 'number' ? ` (at offset ${e.pos})` : '';
        throw new Error(`[coder] collectBareApiUsedInSource: parse failed${loc}: ${e && e.message ? e.message : String(e)}`);
    }
    // the Program node has no parent: everything below it does
    const notReference = (parent, key, node) => parent !== null && (
        (parent.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed && !(parent.shorthand && parent.value === node))
        || ((parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && key === 'label'));
    const walk = (node, parent, key) => {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'Identifier' && !notReference(parent, key, node)) {
            const id = node.name;
            if (skillKeySet.has(id)) skillNames.add(id);
            if (worldKeySet.has(id)) worldNames.add(id);
        }
        for (const k in node) {
            const v = node[k];
            if (Array.isArray(v)) v.forEach(c => walk(c, node, k));
            else if (v && typeof v.type === 'string') walk(v, node, k);
        }
    };
    walk(ast, null, null);
    return { skillNames, worldNames };
}

export class Coder {
    constructor(agent) {
        this.agent = agent;
        this.file_counter = 0;
        this.fp = '/bots/'+agent.name+'/action-code/';
        this.code_template = '';
        this.code_lint_template = '';

        readFile(path.join(__dirname, '../../bots/execTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_template = data;
        });
        readFile(path.join(__dirname, '../../bots/lintTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_lint_template = data;
        });
        mkdirSync('.' + this.fp, { recursive: true });
    }
    
    // fix47: per-prompt breakdown logging for code generation (uses shared helper)
    _logPromptBreakdown(kind, sections) {
        return logPromptBreakdown(kind, sections);
    }
    
    async generateCode(agent_history) {
        this.agent.bot.modes.pause('unstuck');
        lockdown();
        // this message history is transient and only maintained in this function
        // fix46: keep base messages separate - on every retry, use base + latest code + latest error only
        const baseMessages = agent_history.getHistory();
        baseMessages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});
        
        // fix47: log initial base prompt size
        const baseSize = JSON.stringify(baseMessages).length;
        this._logPromptBreakdown('coder-base', {
            history: baseSize
        });

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let code = null;
        let no_code_failures = 0;
        let lastCode = null;   // fix46: track latest code for retry
        let lastError = null;  // fix46: track latest error for retry
        
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (this.agent.bot.interrupt_code)
                return null;
            
            // fix46: on every retry, send base messages + latest code + latest error only
            // This prevents prompt accumulation (800k vs 20k issue)
            let messages;
            if (i === 0) {
                messages = [...baseMessages];
            } else {
                messages = [...baseMessages];
                if (lastCode) {
                    messages.push({ role: 'assistant', content: '```javascript\n' + lastCode + '\n```' });
                }
                if (lastError) {
                    messages.push({ role: 'system', content: lastError });
                }
                const promptSize = JSON.stringify(messages).length;
                // fix47: per-prompt breakdown logging for retries
                this._logPromptBreakdown('coder-retry', {
                    base: baseSize,
                    history: 0,
                    code: lastCode ? lastCode.length : 0,
                    error: lastError ? lastError.length : 0
                });
                console.log(`[fix46] Retry ${i} prompt: ${promptSize} chars (base + latest code + latest error)`);
                // Log loudly if still large (likely indicates an unusually large error message)
                if (promptSize > 100000) {
                    console.log(`[fix46] LOUD: Retry prompt is ${promptSize} chars - consider if error message is too verbose`);
                }
            }
            
            const messages_copy = JSON.parse(JSON.stringify(messages));
            let res = await this.agent.prompter.promptCoding(messages_copy);
            if (this.agent.bot.interrupt_code)
                return null;
            let contains_code = res.indexOf('```') !== -1;
            if (!contains_code) {
                if (res.indexOf('!newAction') !== -1) {
                    // Continue without accumulating - next iteration rebuilds from base
                    continue;
                }
                
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                lastError = 'Error: no code provided. Write code in codeblock in your response. ``` // example ```';
                console.warn("No code block generated. Trying again.");
                no_code_failures++;
                continue;
            }
            code = res.substring(res.indexOf('```')+3, res.lastIndexOf('```'));
            // fix34: formatting-only auto-fix before lint (whitespace, semicolons, quotes - nothing semantic)
            code = this._autoFixFormatting(code);
            lastCode = code;  // fix46: track for retry
            const bareApiFilter = collectBareApiUsedInSource(code);
            const stagedLint = await withStallPhase('coder:stage', () => this._stageCode(code, { bareApiFilter, lintOnly: true }));
            // fix45: pass preludeLines to exclude prelude bindings from shadow warnings
            if (typeof stagedLint.preludeLines !== 'number') {
                throw new Error('[coder] generateCode: staged lint bundle must return numeric preludeLines');
            }
            const lintResult = await withStallPhase('coder:lint', () => this._lintCode(stagedLint.src_lint_copy, stagedLint.preludeLines));
            if (lintResult) {
                lastError = 'Error: Code lint error:\n' + lintResult + '\nPlease try again.';
                console.warn("Linting error:\n" + lintResult + '\n');
                continue;
            }
            const result = await withStallPhase('coder:stage-exec', () => this._stageCode(code, { bareApiFilter, lintOnly: false }));
            const executionModule = result.func;
            if (!executionModule) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }

            try {
                console.log('Executing code...');
                await withStallPhase('coder:execute', async () => {
                    const timedBot = wrapBotForApiTiming(this.agent.bot);
                    if (timedBot !== this.agent.bot) this.agent.bot = timedBot;
                    await executionModule.main(timedBot);
                });

                const code_output = this.agent.actions.getBotOutputSummary();
                const summary = "Agent wrote this code: \n```" + this._sanitizeCode(code) + "```\nCode Output:\n" + code_output;
                return summary;
            } catch (e) {
                if (this.agent.bot.interrupt_code)
                    return null;
                
                console.warn('Generated code threw error: ' + e.toString());
                console.warn('trying again...');

                const code_output = this.agent.actions.getBotOutputSummary();
                // fix46: just track lastError - messages are rebuilt from base on next retry
                lastError = `Code Output:\n${code_output}\nCODE EXECUTION THREW ERROR: ${e.toString()}\n Please try again:`;
            }
        }
        return `Code generation failed after ${MAX_ATTEMPTS} attempts.`;
    }
    
    /**
     * Pre-lint checks on user/voyager-generated snippet only (no prelude); blocks execution if timers invalid or API gate fails.
     * @param {string} code
     * @param {string[]} knownNames
     * @returns {string|null}
     */
    userGeneratedCodeLintBlockers(code, knownNames = []) {
        // fix70: code the model wrote that does not parse (13:42:41Z: its reply declared ensureFurnaceInRange twice) is lint
        // feedback for the model, as in _lintCode and _apiGate; _forbiddenTimerLint threw instead and the whole step failed
        // ("step failed: [coder] _forbiddenTimerLint: parse failed"), so the model never saw its own error
        const parseErr = this._parseError(code);
        if (parseErr) return `Syntax error (cannot parse): ${parseErr}`;
        const timerLint = this._forbiddenTimerLint(code, 0);
        if (timerLint.length > 0) {
            return 'setTimeout/setInterval are not available in the sandbox; use `await sleep(ms)`';
        }
        const missingCounts = missingCountArithmetic(code);   // fix83
        if (missingCounts.length) return missingCounts.join('\n');
        return this._apiGate(code, knownNames);
    }

    // fix32: static API gate on freshly generated code: every bot.<member> must exist on the live bot (or be assigned
    // in the code), every bare function call must be declared in the code, a known skill, or a sandbox global, and every
    // snake_case string passed to a call must be a real item/block/entity name in the live registry. Returns null or an error text.
    _apiGate(code, knownNames = []) {
        let ast;
        try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); }
        catch (e) { return `syntax error: ${e.message}`; }
        const bot = this.agent.bot, reg = bot.registry;
        const declared = new Set(knownNames), assigned = new Set(), errs = new Set();
        // fix40: sandbox includes all bare-name builtins + goals + utilities
        // Note: 'skills' and 'world' objects are NOT available - use bare names
        const bareAPI = getBareAPI();
        const sandbox = new Set([...bareAPI.names, 'log', 'sleep', 'Vec3', 'goals',
            'GoalNear', 'GoalFollow', 'GoalInvert', 'GoalBlock', 'GoalXZ', 'GoalNearXZ',
            'GoalGetToBlock', 'GoalLookAtBlock', 'GoalBreakBlock', 'GoalCompositeAny', 'GoalCompositeAll']);
        const nodes = [];
        (function walk(n) { if (!n || typeof n.type !== 'string') return; nodes.push(n); for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); } })(ast);
        const decl = p => { if (!p) return; if (p.type === 'Identifier') declared.add(p.name); else if (p.type === 'AssignmentPattern') decl(p.left); else if (p.type === 'RestElement') decl(p.argument); else if (p.type === 'ObjectPattern') p.properties.forEach(q => decl(q.value || q.argument)); else if (p.type === 'ArrayPattern') p.elements.forEach(decl); };
        for (const n of nodes) {
            if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')) { if (n.id) declared.add(n.id.name); n.params.forEach(decl); }
            if (n.type === 'VariableDeclarator') decl(n.id);
            if (n.type === 'CatchClause') decl(n.param);
            if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.type === 'Identifier' && n.left.object.name === 'bot' && !n.left.computed) assigned.add(n.left.property.name);
        }
        const isName = s => !!(reg.itemsByName[s] || reg.blocksByName[s] || reg.entitiesByName?.[s]);
        const allNames = [...new Set([...Object.keys(reg.itemsByName), ...Object.keys(reg.blocksByName), ...Object.keys(reg.entitiesByName || {})])];
        const lev = (a, b) => { if (Math.abs(a.length - b.length) > 2) return 3; let prev = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[b.length]; };
        const nearMiss = s => allNames.find(x => lev(s, x) <= 2);   // only typo-like strings are flagged; free-form labels pass
        // fix79: runtime-owned keys (fix51 __prereqFail, fix76 __unmetPrecondition). Seeded ensure* writes them;
        // generated/repaired code must not. Only these two names — other bot.__* assignments still pass via `assigned`.
        const runtimeOwnedBotWrites = new Set(['__unmetPrecondition', '__prereqFail']);
        for (const n of nodes) {
            if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed
                && n.left.object.type === 'Identifier' && n.left.object.name === 'bot'
                && n.left.property.type === 'Identifier' && runtimeOwnedBotWrites.has(n.left.property.name))
                errs.add(`writing bot.${n.left.property.name} is forbidden in generated code (runtime-owned; seeded ensure* sets it)`);
            if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'bot' && n.property.type === 'Identifier' && !(n.property.name in bot) && !assigned.has(n.property.name))
                errs.add(`bot.${n.property.name} does not exist on the live bot (closest real members: ${nearestBotMember(bot, n.property.name, nodes.some(c => c.type === 'CallExpression' && c.callee === n)).map(k => 'bot.' + k).join(', ')})`);
            if (n.type === 'CallExpression') {
                if (n.callee.type === 'Identifier' && !declared.has(n.callee.name) && !sandbox.has(n.callee.name) && !(n.callee.name in globalThis))
                    errs.add(`${n.callee.name}() is not defined (not a skill, not declared in the code)`);
                for (const a of n.arguments) if (a.type === 'Literal' && typeof a.value === 'string' && /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(a.value) && !isName(a.value)) { const nm = nearMiss(a.value);
                    if (nm) errs.add(`'${a.value}' is not an item, block or entity name in this Minecraft version (did you mean '${nm}'?)`); }
            }
        }
        return errs.size ? `API gate: ${[...errs].join('; ')}` : null;   // fix96: every error, none cut
    }
    // fix34: Levenshtein distance for API name matching
    _lev(a, b) {
        if (Math.abs(a.length - b.length) > 6) return 99;
        let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
        for (let i = 1; i <= a.length; i++) {
            const cur = [i];
            for (let j = 1; j <= b.length; j++)
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = cur;
        }
        return prev[b.length];
    }
    // fix40: get unified bare-name API (built-in + learned)
    _getUnifiedAPI() {
        const bare = getBareAPI();
        const learned = this._getLearnedSkillNames();
        return {
            names: new Set([...bare.names, ...learned]),
            builtInNames: bare.names,
            learnedNames: new Set(learned),
            builtInSigs: bare.sigs
        };
    }
    // fix40: get learned skill names from voyager (bare function names)
    _getLearnedSkillNames() {
        const voyager = this.agent.voyager;
        if (!voyager || !Array.isArray(voyager.skills)) return [];
        return voyager.skills.filter(s => !s.demoted && !s.mergedInto).map(s => s.name);
    }
    // fix40: find nearest bare-name function by edit distance (searches unified pool: builtins + learned)
    // NO autocorrect - suggestions only for lint feedback
    _nearestBareName(name) {
        const { names, builtInNames, learnedNames } = this._getUnifiedAPI();
        const lower = name.toLowerCase();
        let best = null, bestDist = Infinity;
        for (const n of names) {
            const dist = this._lev(lower, n.toLowerCase());
            if (dist < bestDist) { best = n; bestDist = dist; }
        }
        if (!best || bestDist > 8) return null;
        return { 
            match: best, 
            dist: bestDist, 
            isBuiltIn: builtInNames.has(best),
            isLearned: learnedNames.has(best)
        };
    }
    // fix44: check for variable declarations that shadow the `log` helper (lint feedback only, NO auto-rename)
    // fix45: accepts preludeLines parameter to exclude prelude bindings from shadow warnings
    // Returns array of { line, text } for each shadowing declaration found (only user code, not prelude)
    _checkLogShadowing(code, preludeLines = 0) {
        let ast;
        try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, locations: true }); }
        catch (e) { return []; }
        const warnings = [];
        const codeLines = code.split('\n');
        const walk = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === 'log') {
                const line = node.loc?.start?.line || 0;
                // fix45: exclude prelude lines (injected bare API bindings like `const log = skills.log`)
                if (line > preludeLines) {
                    warnings.push({ line, text: codeLines[line - 1]?.trim() || `const/let/var log = ...` });
                }
            }
            if (node.type === 'FunctionDeclaration' && node.id?.name === 'log') {
                const line = node.loc?.start?.line || 0;
                // fix45: exclude prelude lines
                if (line > preludeLines) {
                    warnings.push({ line, text: codeLines[line - 1]?.trim() || `function log(...)` });
                }
            }
            for (const key in node) {
                const val = node[key];
                if (Array.isArray(val)) val.forEach(walk);
                else if (val && typeof val.type === 'string') walk(val);
            }
        };
        walk(ast);
        return warnings;
    }
    // fix51: check for potential null dereference on findBlock/blockAt results (feedback only)
    // Pattern: x = getNearestBlock(...) or x = bot.blockAt(...) followed by x.property access without null check
    _checkNullDeref(code, preludeLines = 0) {
        const warnings = [];
        const codeLines = code.split('\n');
        // Simple pattern matching - not full AST analysis, just common cases
        // Look for patterns like: const block = getNearestBlock(...); ... block.position
        const nullableAssigns = new Map();
        for (let i = 0; i < codeLines.length; i++) {
            const line = codeLines[i];
            const lineNum = i + 1;
            if (lineNum <= preludeLines) continue;
            
            // Match: const/let/var x = getNearestBlock(...) or bot.blockAt(...) or findBlock(...)
            const assignMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:getNearestBlock|bot\.blockAt|bot\.findBlock)\s*\(/);
            if (assignMatch) {
                nullableAssigns.set(assignMatch[1], lineNum);
            }
            
            // Check for immediate property access on same line without null check
            const immediateDeref = line.match(/(?:getNearestBlock|bot\.blockAt|bot\.findBlock)\s*\([^)]*\)\s*\.(name|position|count)/);
            if (immediateDeref) {
                warnings.push({ line: lineNum, text: line.trim() });
            }
        }
        
        // Look for subsequent access without null check
        for (let i = 0; i < codeLines.length; i++) {
            const line = codeLines[i];
            const lineNum = i + 1;
            if (lineNum <= preludeLines) continue;
            
            // Check if any nullable var is accessed without a prior null check on the same line or preceding lines
            for (const [varName, assignLine] of nullableAssigns.entries()) {
                if (lineNum <= assignLine) continue;
                // Check for varName.property access
                const accessMatch = line.match(new RegExp(`\\b${varName}\\.(name|position|count)\\b`));
                if (accessMatch) {
                    // Check if there's a null check between assign and access
                    let hasNullCheck = false;
                    for (let j = assignLine; j < lineNum; j++) {
                        if (codeLines[j].includes(`!${varName}`) || codeLines[j].includes(`${varName} === null`) || codeLines[j].includes(`${varName} == null`)) {
                            hasNullCheck = true;
                            break;
                        }
                    }
                    if (!hasNullCheck) {
                        warnings.push({ line: lineNum, text: line.trim() });
                        break;  // Only report first access per variable
                    }
                }
            }
        }
        return warnings;
    }
    // fix40: extract skills.*/world.* calls from code using acorn - these are NOW FORBIDDEN
    // All functions must be called by bare name, not with skills.*/world.* prefix
    /**
     * Warn on loops inside non-async functions: they cannot yield, so the event loop waits for them to finish (fix64).
     * @param {string} code
     * @param {number} preludeLines
     */
    _syncLoopLint(code, preludeLines) {
        let ast;
        try {
            ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, locations: true });
        } catch (e) {
            throw new Error(`[coder] _syncLoopLint: parse failed: ${e && e.message ? e.message : String(e)}`);
        }
        const out = [];
        const loopKinds = new Set(['ForStatement', 'WhileStatement', 'DoWhileStatement', 'ForInStatement', 'ForOfStatement']);
        const fnTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
        // fix64: loops in async code get one event-loop turn per iteration at exec (_injectLoopTurns), so only a loop inside a
        // non-async function can still hold the event loop; the old "body has no await" test flagged bounded for-of scans and
        // missed the live hang (an async loop whose `continue` path had no await)
        const walk = (node, inAsync) => {
            if (!node || typeof node.type !== 'string') return;
            const here = fnTypes.has(node.type) ? !!node.async : inAsync;
            if (loopKinds.has(node.type) && !here) {
                const line = node.body.loc.start.line;
                if (line > preludeLines) out.push({ line, text: _trimLineAt(code, line) });
            }
            for (const k in node) {
                const v = node[k];
                if (Array.isArray(v)) v.forEach(c => walk(c, here));
                else if (v && typeof v.type === 'string') walk(v, here);
            }
        };
        walk(ast, true);
        return out;
    }

    _getNumericLiteral(node) {
        if (!node) return null;
        if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
        if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'Literal' && typeof node.argument.value === 'number') {
            return -node.argument.value;
        }
        return null;
    }

    /**
     * Warn on large-radius block/entity scans (numeric maxDistance or similar).
     */
    /**
     * @param {string} code
     * @param {number} preludeLines
     * @param {number} warnDistMs numeric literal threshold (the keep-alive kick bound the stall guard sets)
     */
    _largeWorldScanLint(code, preludeLines, warnDistMs) {
        if (typeof warnDistMs !== 'number' || !Number.isFinite(warnDistMs) || warnDistMs <= 0) {
            throw new Error('[coder] _largeWorldScanLint: warnDistMs must be a positive finite number');
        }
        let ast;
        try {
            ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, locations: true });
        } catch (e) {
            throw new Error(`[coder] _largeWorldScanLint: parse failed: ${e && e.message ? e.message : String(e)}`);
        }
        const warnDist = warnDistMs;
        const out = [];
        const scanCalleeNames = new Set(['findBlock', 'findBlocks', 'nearestEntity']);
        const walk = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'CallExpression') {
                let reportLine = null;
                let detail = '';
                const callee = node.callee;
                if (callee?.type === 'MemberExpression' && !callee.computed && callee.object?.type === 'Identifier' && callee.object.name === 'bot' && callee.property?.type === 'Identifier' && scanCalleeNames.has(callee.property.name)) {
                    const first = node.arguments[0];
                    if (first?.type === 'ObjectExpression') {
                        for (const p of first.properties) {
                            if (p.type !== 'Property' || p.key?.type !== 'Identifier') continue;
                            const kn = p.key.name;
                            if (kn !== 'maxDistance' && kn !== 'maxBlocks') continue;
                            const n = this._getNumericLiteral(p.value);
                            if (n !== null && n >= warnDist) {
                                reportLine = p.value.loc.start.line;
                                detail = `bot.${callee.property.name} option ${kn}=${n} (>= keep-alive kick bound ${warnDist}ms as stall-risk distance)`;
                            }
                        }
                    }
                    if (callee.property.name === 'nearestEntity' && node.arguments.length >= 2) {
                        const n = this._getNumericLiteral(node.arguments[1]);
                        if (n !== null && n >= warnDist) {
                            reportLine = node.arguments[1].loc.start.line;
                            detail = `bot.nearestEntity second arg maxDistance=${n} (>= keep-alive kick bound ${warnDist}ms as stall-risk distance)`;
                        }
                    }
                }
                if (callee?.type === 'Identifier' && callee.name === 'getNearestBlock' && node.arguments.length >= 3) {
                    const n = this._getNumericLiteral(node.arguments[2]);
                    if (n !== null && n >= warnDist) {
                        reportLine = node.arguments[2].loc.start.line;
                        detail = `getNearestBlock distance=${n} (>= keep-alive kick bound ${warnDist}ms as stall-risk distance)`;
                    }
                }
                if (reportLine !== null && reportLine > preludeLines) {
                    out.push({ line: reportLine, text: _trimLineAt(code, reportLine), detail });
                }
            }
            for (const k in node) {
                const v = node[k];
                if (Array.isArray(v)) v.forEach(walk);
                else if (v && typeof v.type === 'string') walk(v);
            }
        };
        walk(ast);
        return out;
    }

    /** fix70: the parser's message for code that does not parse, or null when it parses. */
    _parseError(code) {
        try { acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); }
        catch (e) { if (!(e instanceof SyntaxError)) throw e; return e.message; }
        return null;
    }
    /**
     * Disallow setTimeout/setInterval in sandbox-bound code (AST; not string regex).
     */
    _forbiddenTimerLint(code, preludeLines) {
        let ast;
        try {
            ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, locations: true });
        } catch (e) {
            throw new Error(`[coder] _forbiddenTimerLint: parse failed: ${e && e.message ? e.message : String(e)}`);
        }
        const bad = [];
        const walk = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && (node.callee.name === 'setTimeout' || node.callee.name === 'setInterval')) {
                const line = node.loc.start.line;
                if (line > preludeLines) {
                    bad.push({ line, text: _trimLineAt(code, line) });
                }
            }
            for (const k in node) {
                const v = node[k];
                if (Array.isArray(v)) v.forEach(walk);
                else if (v && typeof v.type === 'string') walk(v);
            }
        };
        walk(ast);
        return bad;
    }

    _extractOldStyleCalls(code) {
        let ast;
        try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); }
        catch (e) { if (!e.loc) throw e; return { calls: [], positions: [], error: e.message, errorLine: e.loc.line }; }
        const calls = [], positions = [];
        const walk = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
                node.callee.object.type === 'Identifier' && ['skills', 'world'].includes(node.callee.object.name) &&
                node.callee.property.type === 'Identifier') {
                const call = `${node.callee.object.name}.${node.callee.property.name}`;
                calls.push(call);
                positions.push({ call, start: node.callee.start, end: node.callee.end });
            }
            for (const key in node) {
                const val = node[key];
                if (Array.isArray(val)) val.forEach(walk);
                else if (val && typeof val.type === 'string') walk(val);
            }
        };
        walk(ast);
        return { calls, positions, error: null };
    }
    /**
     * After each statement semicolon that is immediately followed by a line break, insert interrupt check
     * (template/string safe — uses tokenizer, not naive `;\\n` replace).
     */
    _injectSemicolonInterruptGuards(code) {
        const src = String(code);
        const GUARD = ' if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}';
        /** @type {number[]} */
        const insertAt = [];
        const t = acornTokenizer(src, { ecmaVersion: 2024, sourceType: 'module', allowAwaitOutsideFunction: true });
        for (const tok of t) {
            if (tok.type === tokTypes.semi && tok.end < src.length) {
                const ch = src[tok.end];
                if (ch === '\n' || ch === '\r') insertAt.push(tok.end);
            }
        }
        insertAt.sort((a, b) => b - a);
        let out = src;
        for (const p of insertAt) out = out.slice(0, p) + GUARD + out.slice(p);
        return out;
    }

    /**
     * fix64: every loop iteration inside an async function (or the template's async top level) starts with
     * `await __loopTurn__();`, one event-loop turn. The interrupt guard injected into each loop body (fix44) is a flag set by
     * an event handler; on an iteration path with no await the handler can never run, so the guard was dead exactly when
     * it was needed. Live 12:43Z: the collectBlock candidate's `excluded.add(..); i--; continue;` path re-ran a 64-block
     * getNearestBlocks scan per remembered candidate without ever awaiting, keep_alive went unanswered and the server
     * timed the bot out while the process stayed blocked. With a turn per iteration the loop still runs to completion,
     * but keep_alive, interrupts and the stall watchdog's heartbeat are served between iterations.
     * Loops inside non-async functions cannot await; they are left as written (lint names them, the watchdog backs them).
     * Insertions add no lines, so lint/trace line numbers are unchanged.
     * @param {string} code
     */
    _injectLoopTurns(code) {
        const src = String(code);
        const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
        const TURN = ' await __loopTurn__();';
        /** @type {{ at: number, text: string }[]} */
        const edits = [];
        const fnTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
        const loopKinds = new Set(['ForStatement', 'WhileStatement', 'DoWhileStatement', 'ForInStatement', 'ForOfStatement']);
        const walk = (node, inAsync) => {
            if (!node || typeof node.type !== 'string') return;
            const here = fnTypes.has(node.type) ? !!node.async : inAsync;
            if (loopKinds.has(node.type) && here) {
                const b = node.body;
                if (b.type === 'BlockStatement') edits.push({ at: b.start + 1, text: TURN });
                else { edits.push({ at: b.start, text: '{' + TURN + ' ' }); edits.push({ at: b.end, text: ' }' }); }
            }
            for (const k in node) {
                const v = node[k];
                if (Array.isArray(v)) v.forEach(c => walk(c, here));
                else if (v && typeof v.type === 'string') walk(v, here);
            }
        };
        walk(ast, true);   // the exec template runs staged code inside `(async (bot) => { ... })`
        edits.sort((a, b) => b.at - a.at);
        let out = src;
        for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
        return out;
    }

    // fix34: formatting-only auto-fix (whitespace, semicolons, quotes, code fences - nothing semantic)
    _autoFixFormatting(code) {
        let fixed = code.trim();
        if (fixed.startsWith('javascript') || fixed.startsWith('js')) {
            fixed = fixed.replace(/^(?:javascript|js)\s*/, '');
        }
        fixed = fixed.replace(/\r\n/g, '\n').replace(/\t/g, '    ');
        fixed = fixed.replace(/[ \t]+$/gm, '');
        return fixed;
    }
    async _lintWithEslintWorker(code) {
        const workerPath = path.join(__dirname, '../utils/eslint_lint_worker.mjs');
        return new Promise((resolve, reject) => {
            let settled = false;
            const w = new Worker(workerPath);
            w.on('message', (msg) => {
                settled = true;
                w.terminate();
                if (msg && msg.error) reject(new Error(msg.error));
                else resolve(msg.results);
            });
            w.on('error', (e) => { if (!settled) reject(e); });
            w.on('exit', (c) => {
                if (!settled && c !== 0) reject(new Error(`eslint worker exited ${c}`));
            });
            w.postMessage(code);
        });
    }

    // fix45: accept preludeLines to exclude prelude bindings from shadow warnings
    async  _lintCode(code, preludeLines = 0) {
        const header = '#### CODE ERROR INFO ###\n';
        /** @type {string[]} */
        const errors = [];
        /** @type {string[]} */
        const warnings = [];
        // fix40: use acorn to extract old-style skills.*/world.* calls - these are NOW FORBIDDEN
        const { calls: oldStyleCalls, error: parseError, errorLine } = this._extractOldStyleCalls(code);
        if (parseError) {
            // fix61: the prelude (lines before preludeLines) is generated by staging, never by the model or a skill. A parse error there
            // is a harness bug the model cannot see or fix; feeding it back made every attempt get the same feedback, so the model
            // returned the same reply. Fail loud instead. Errors in the code itself quote the offending line so each turn carries it.
            if (errorLine < preludeLines) throw new Error(`[fix61] LOUD FAIL: staged lint prelude does not parse (line ${errorLine} of ${preludeLines - 1} prelude lines): ${parseError}: ${code.split('\n')[errorLine - 1].trim()}`);
            errors.push(`Syntax error (cannot parse): ${parseError}\nOffending line: ${code.split('\n')[errorLine - 1].trim()}\n`);
            return header + errors.join('');
        }
        const { builtInNames, learnedNames, builtInSigs } = this._getUnifiedAPI();
        const learned = this._getLearnedSkillNames();
        // fix40: ANY skills.*/world.* call is an error - must use bare names
        if (oldStyleCalls.length > 0) {
            let block = 'ERROR: Old-style skills.*/world.* calls are forbidden. Use bare function names instead.\n';
            block += 'The following calls must be changed to bare names:\n';
            block += oldStyleCalls.map(call => {
                const fnName = call.split('.').pop();
                // Find nearest match in unified pool (built-in + learned)
                const nearest = this._nearestBareName(fnName);
                const suggestions = [];
                // Check if the exact bare name exists
                if (builtInNames.has(fnName)) {
                    suggestions.push(`${fnName} (built-in, use bare name)`);
                } else if (learnedNames.has(fnName)) {
                    suggestions.push(`${fnName} (learned, use bare name)`);
                } else if (nearest) {
                    const label = nearest.isBuiltIn ? 'built-in' : nearest.isLearned ? 'learned' : '';
                    suggestions.push(`${nearest.match} (${label}, use bare name)`);
                }
                // Also show other close matches
                const allNames = [...builtInNames, ...learnedNames];
                const scored = allNames.map(n => ({ n, dist: this._lev(fnName.toLowerCase(), n.toLowerCase()) }))
                    .filter(s => s.dist <= 6 && s.n !== fnName && (!nearest || s.n !== nearest.match))
                    .sort((a, b) => a.dist - b.dist)
                    .slice(0, 3);
                for (const s of scored) {
                    const label = builtInNames.has(s.n) ? 'built-in' : 'learned';
                    suggestions.push(`${s.n} (${label})`);
                }
                const suggestionText = suggestions.length ? suggestions.join(', ') : '(no close match)';
                return `  ${call} -> use bare name: ${suggestionText}`;
            }).join('\n');
            block += '\n\nAVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z)):\n';
            block += builtInSigs.join('\n');
            if (learned.length) {
                block += '\n\nLEARNED SKILLS (also bare names):\n' + learned.join(', ');
            }
            console.log(header + block);
            return header + block;
        }

        // fix44: lint check for shadowing `log` - explicit feedback only, NO auto-renaming of user locals
        // This warns when generated code does e.g. `const log = getNearestBlock(...)` which would break
        // the bare `log()` helper. The interrupt guard is safe (uses __mcLog__), but user code calling log() is not.
        // fix45: use preludeLines from _stageCode (calculated after inserting bare bindings)
        const shadowLogWarnings = this._checkLogShadowing(code, preludeLines);
        if (shadowLogWarnings.length > 0) {
            let w = 'WARNING: Variable(s) shadowing the built-in `log` helper detected.\n';
            w += 'This will prevent log(bot, ...) calls from working in that scope.\n';
            w += 'Consider renaming your variable to avoid collision (e.g., `logBlock`, `targetBlock`, `nearestLog`):\n';
            for (const x of shadowLogWarnings) {
                w += `  Line ${x.line}: ${x.text}\n`;
            }
            w += '\n';
            warnings.push(w);
        }

        // fix51: lint check for potential null dereference on findBlock/blockAt results (feedback only)
        // These functions can return null (chunk unloaded, no block found), and accessing .name/.position/.count will TypeError
        const nullDerefWarnings = this._checkNullDeref(code, preludeLines);
        if (nullDerefWarnings.length > 0) {
            let w = 'WARNING: Potential null dereference on findBlock/blockAt result detected.\n';
            w += 'These functions return null when no block is found or the chunk is unloaded.\n';
            w += 'Accessing properties like .name, .position, or .count on null will throw TypeError.\n';
            w += 'Check for null before accessing properties:\n';
            w += '  WRONG:  const block = getNearestBlock(bot, "iron_ore", 16); const pos = block.position;\n';
            w += '  RIGHT:  const block = getNearestBlock(bot, "iron_ore", 16); if (!block) { log(bot, "no iron_ore found"); return false; } const pos = block.position;\n';
            for (const x of nullDerefWarnings) {
                w += `  Line ${x.line}: ${x.text}\n`;
            }
            w += '\n';
            warnings.push(w);
        }

        const timerLint = this._forbiddenTimerLint(code, preludeLines);
        if (timerLint.length > 0) {
            let e = 'ERROR: setTimeout/setInterval are not available in the sandbox; use `await sleep(ms)`.\n';
            for (const x of timerLint) {
                e += `  Line ${x.line}: ${x.text}\n`;
            }
            e += '\nThe code contains forbidden timer calls and cannot continue execution.';
            errors.push(e);
            return header + errors.join('');
        }

        const bot = this.agent.bot;
        const stallMs =
            bot &&
            typeof bot.__eventLoopStallThresholdMs === 'number' &&
            Number.isFinite(bot.__eventLoopStallThresholdMs) &&
            bot.__eventLoopStallThresholdMs > 0
                ? bot.__eventLoopStallThresholdMs
                : null;
        if (stallMs === null) {
            warnings.push(
                'WARNING: large-radius scan stall-risk check is OFF until the event-loop guard sets the keep-alive kick bound.\n'
            );
        }
        const largeScanWarnings = stallMs === null ? [] : this._largeWorldScanLint(code, preludeLines, stallMs);
        if (largeScanWarnings.length > 0) {
            const wd = stallMs;
            let w = `WARNING: Large-radius block/world scan (numeric distance >= ${wd} — the keep-alive kick bound used for stall detection) may block the event loop.\n`;
            w += 'Prefer smaller maxDistance, chunk-aware iteration, or yield with await between batches.\n';
            for (const x of largeScanWarnings) {
                w += `  Line ${x.line}: ${x.detail}\n`;
            }
            w += '\n';
            warnings.push(w);
        }

        const syncLoopWarnings = this._syncLoopLint(code, preludeLines);
        if (syncLoopWarnings.length > 0) {
            let w = 'WARNING: Loop inside a non-async function cannot yield to the event loop; it blocks the bot until it ends. Make the function async or bound the loop by data it already holds.\n';
            for (const x of syncLoopWarnings) {
                w += `  Line ${x.line}: ${x.text}\n`;
            }
            w += '\n';
            warnings.push(w);
        }

        const results = await this._lintWithEslintWorker(code);
        const codeLines = code.split('\n');
        let exceptions = results.map(r => r.messages).flat();
        
        // fix26: filter out lint messages about inserted interrupt return statements
        // These are inserted by _stageCode as `if(bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}`
        // and may trigger lint warnings about ReturnStatement usage. Per Mo: feedback-only, not blocking.
        const isInterruptReturnError = (exc) => {
            if (!exc.line) return false;
            const line = codeLines[exc.line - 1] || '';
            return line.includes('bot.interrupt_code') && (
                (exc.message && /return|ReturnStatement/i.test(exc.message)) ||
                (exc.ruleId && /return/i.test(exc.ruleId))
            );
        };
        const interruptErrors = exceptions.filter(isInterruptReturnError);
        if (interruptErrors.length > 0) {
            console.log(`[lint] filtered ${interruptErrors.length} lint warning(s) about inserted interrupt return statements (feedback-only)`);
        }
        exceptions = exceptions.filter(exc => !isInterruptReturnError(exc));

        if (exceptions.length > 0) {
            let eslintBlock = '';
            exceptions.forEach((exc, index) => {
                if (exc.line && exc.column ) {
                    const errorLine = codeLines[exc.line - 1]?.trim() || 'Unable to retrieve error line content';
                    eslintBlock += `#ERROR ${index + 1}\n`;
                    // Actionable feedback for empty catch blocks (Mo fail-loud principle)
                    if (exc.ruleId === 'no-empty' && /catch\s*\([^)]*\)\s*\{\s*\}/.test(errorLine)) {
                        eslintBlock += `Message: EMPTY CATCH BLOCK - swallowing errors hides failures and breaks the repair loop.\n`;
                        eslintBlock += `Why rejected: Mo fail-loud principle - every error must propagate so the skill library can learn what went wrong. An empty catch silently discards the failure, leaving no trace for diagnosis or repair.\n`;
                        eslintBlock += `How to fix: Either rethrow the error, or log then rethrow:\n`;
                        eslintBlock += `  WRONG:  } catch (e) {}\n`;
                        eslintBlock += `  RIGHT:  } catch (e) { throw e; }\n`;
                        eslintBlock += `  RIGHT:  } catch (e) { log(bot, \`Step failed: \${e.message}\`); throw e; }\n`;
                        eslintBlock += `If the error is truly recoverable, log it and return a falsy value - never silently continue.\n`;
                    } else {
                        eslintBlock += `Message: ${exc.message}\n`;
                    }
                    eslintBlock += `Location: Line ${exc.line}, Column ${exc.column}\n`;
                    eslintBlock += `Related Code Line: ${errorLine}\n`;
                    // fix36: add surrounding context to help identify which skill contains the error (especially for joined skill code)
                    const start = Math.max(0, exc.line - 4);
                    const end = Math.min(codeLines.length, exc.line + 2);
                    const context = codeLines.slice(start, end).map((l, i) => {
                        const ln = start + i + 1;
                        const marker = ln === exc.line ? '>>>' : '   ';
                        return `${marker} ${ln}: ${l}`;
                    }).join('\n');
                    eslintBlock += `Context:\n${context}\n`;
                }
            });
            eslintBlock += 'The code contains exceptions and cannot continue execution.';
            errors.push(eslintBlock);
            return header + errors.join('');
        }

        if (warnings.length) {
            console.warn('[lint] warnings (non-blocking):\n' + warnings.join(''));
        }
        return null;
    }
    // write custom code to file and import it
    /**
     * @param {string} code - combined skill library + generated user code (or user-only when no library)
     * @param {{ bareApiFilter?: { skillNames: Set<string>, worldNames: Set<string> }, lintOnly?: boolean, learnedNamesForLint?: Set<string> }} [opts]
     */
    async _stageCode(code, opts) {
        const lintOnly = !!(opts && opts.lintOnly);
        const bareApiFilter = opts && opts.bareApiFilter ? opts.bareApiFilter : null;
        const learnedNamesForLint = opts && opts.learnedNamesForLint ? opts.learnedNamesForLint : null;
        code = this._sanitizeCode(code);
        let src = '';
        code = code.replaceAll('console.log(', 'log(bot,');
        code = code.replaceAll('log("', 'log(bot,"');

        console.log(`[staging] coder:_stageCode staged_source=${code.length} chars lines=${code.split('\n').length}`);

        // fix44: interrupt guard uses __mcLog__ (collision-safe binding injected into endowments)
        // String/template aware: naive `;\n` replacement breaks instrumentSrc template bodies that contain `;`+newline
        // fix64: exec copy only (lint feedback is about the code as written); runs before the semicolon guards so every turn is
        // followed by the interrupt check
        if (!lintOnly) code = this._injectLoopTurns(code);
        code = this._injectSemicolonInterruptGuards(code);
        for (let line of code.split('\n')) {
            // every loop iteration checks for an interrupt
            line = line.replace(/^(\s*(?:\}\s*)?(?:for|while)\s*\(.*\)\s*\{)\s*$/, '$1 if (bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}');
            line = line.replace(/^(\s*do\s*\{)\s*$/, '$1 if (bot.interrupt_code) {__mcLog__(bot, "Code interrupted.");return;}');
            src += `    ${line}\n`;
        }
        // fix41: generate const bindings for bare API names so ESLint no-undef can see them
        // fix45: include log in bare bindings (no longer in prelude to avoid shadow warning on prelude)
        const allSkillKeys = Object.keys(skills).filter(k => typeof skills[k] === 'function');
        const allWorldKeys = Object.keys(world).filter(k => typeof world[k] === 'function');
        const alwaysSkills = new Set(['log']);
        const skillKeysForLint = bareApiFilter
            ? [...new Set([...alwaysSkills, ...allSkillKeys.filter(k => bareApiFilter.skillNames.has(k))])].filter(k => typeof skills[k] === 'function')
            : allSkillKeys;
        const worldKeysForLint = bareApiFilter
            ? allWorldKeys.filter(k => bareApiFilter.worldNames.has(k))
            : allWorldKeys;
        const bareBindingsLint = [
            ...skillKeysForLint.map(k => `const ${k} = skills.${k};`),
            ...worldKeysForLint.map(k => `const ${k} = world.${k};`)
        ].join('\n');
        // fix61: a seeded primitive is BOTH a library skill and a built-in (e.g. breakBlockAt): it is already bound above from
        // skills./world., so declaring it again here made the prelude itself unparseable ("Identifier 'breakBlockAt' has already
        // been declared") and every bundle whose closure held one failed lint before it ran, replays of craftItem included.
        // fix61: names the exec sandbox endows besides skills./world. (pathfinder goals) are declared for lint from the same object,
        // so a seeded primitive copied from skills.js (travelTo uses GoalNearXZ) lints exactly as it runs
        const endowedLint = ['goals', ...Object.keys(SANDBOX_GOALS), PRECONDITION_UNMET_BINDING].map(k => `const ${k} = undefined; // sandbox endowment (no-undef)`).join('\n');
        const boundBare = new Set([...skillKeysForLint, ...worldKeysForLint, 'goals', ...Object.keys(SANDBOX_GOALS)]);
        let learnedConstBlock = '';
        if (learnedNamesForLint && learnedNamesForLint.size > 0) {
            learnedConstBlock = [...learnedNamesForLint].filter(n => !boundBare.has(n)).sort().map(n => `const ${n} = undefined; // learned skill (no-undef)`).join('\n');
        }
        // fix45: calculate prelude line count AFTER inserting bare bindings but BEFORE inserting user code
        // This is used by _lintCode to exclude prelude lines from shadow warnings
        const templateWithBindings = this.code_lint_template
            .replace('/* BARE API HERE */', bareBindingsLint + '\n' + endowedLint + (learnedConstBlock ? '\n' + learnedConstBlock : ''));
        const preludeLines = (templateWithBindings.split('/* CODE HERE */')[0] || '').split('\n').length;
        let src_lint_copy = templateWithBindings.replace('/* CODE HERE */', src);
        if (lintOnly) {
            return { src_lint_copy, preludeLines };
        }
        src = this.code_template.replace('/* CODE HERE */', src);
        // fix96: the watchdog writes this into watchdog_kill.json if the main thread blocks while it runs. Kills at 15:43 and
        //        17:32 GMT on 9 Nov named only the skill (smeltWithFuel, expandExplorationRangeForCactus); the generated code
        //        that blocked was never saved, so the cause could not be read.
        if (mainThreadWatchdogStarted()) publishMainThreadCode({ label: getStallPhaseStack().join(' <- '), source: src });

        let filename = this.file_counter + '.js';
        // if (this.file_counter > 0) {
        //     let prev_filename = this.fp + (this.file_counter-1) + '.js';
        //     unlink(prev_filename, (err) => {
        //         console.log("deleted file " + prev_filename);
        //         if (err) console.error(err);
        //     });
        // } commented for now, useful to keep files for debugging
        this.file_counter++;
        
        let write_result = await this._writeFilePromise('.' + this.fp + filename, src);
        // fix40: unified bare-name API - all built-in functions injected as bare names
        // This is where we determine the environment the agent's code should be exposed to.
        // Note that the code may be able to modify the exposed objects.
        // Generated code gets interrupt-aware functions: once an interrupt is requested every call returns false at once
        const endowments = {};
        // fix44: __mcLog__ is a collision-safe binding for interrupt guards (user code cannot shadow it)
        endowments.__mcLog__ = skills.log;
        // fix64: one event-loop turn per loop iteration (see _injectLoopTurns); collision-safe like __mcLog__
        endowments.__loopTurn__ = () => new Promise(resolve => setImmediate(resolve));
        // fix74: the unmet-precondition marker's one writer, for repo-owned seeded primitives only. Internal like __mcLog__: not a
        //        skills.js export, so it is not in getBareAPI (the model never sees it), and generated code that calls it is
        //        rejected (writeCode: _apiGate "not declared"; saveSkill/repair: missingCalls "calls unknown skills"). A model
        //        that could mark its own failure "precondition unmet" would void its own stats (fix76 voids such runs).
        endowments[PRECONDITION_UNMET_BINDING] = markPreconditionUnmet;
        const skillKeysExec = bareApiFilter ? skillKeysForLint : allSkillKeys;
        const worldKeysExec = bareApiFilter ? worldKeysForLint : allWorldKeys;
        // Inject skills.* / world.* used by this bundle only when narrowing (full library otherwise)
        for (const k of skillKeysExec) {
            const f = skills[k];
            if (typeof f === 'function') {
                endowments[k] = k === 'log' ? f : (...a) => (a[0]?.interrupt_code ? Promise.resolve(false) : f(...a));
            }
        }
        for (const k of worldKeysExec) {
            const f = world[k];
            if (typeof f === 'function') endowments[k] = f;
        }
        // fix38: expose pathfinder goals so generated code can use GoalNear, GoalFollow, etc. (fix61: one source, SANDBOX_GOALS)
        Object.assign(endowments, { Vec3, goals: SANDBOX_GOALS, ...SANDBOX_GOALS,
            sleep: ms => new Promise(r => setTimeout(r, ms)),   // fix27: the only way to wait; setTimeout itself is not in scope
        });
        const compartment = makeCompartment(endowments);
        pushStallPhase('coder:ses-eval');
        let mainFn;
        try {
            mainFn = compartment.evaluate(src);
        } finally {
            popStallPhase();
        }
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        // fix45: return preludeLines for shadow warning exclusion
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy, preludeLines };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js'];
        for (let r of remove_strs) {
            if (code.startsWith(r)) {
                code = code.slice(r.length);
                return code;
            }
        }
        return code;
    }

    _writeFilePromise(filename, src) {
        // makes it so we can await this function
        return new Promise((resolve, reject) => {
            writeFile(filename, src, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}