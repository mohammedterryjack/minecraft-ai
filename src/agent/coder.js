import { writeFile, readFile, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import { Vec3 } from 'vec3';
import {ESLint} from "eslint";
import * as acorn from "acorn";
import pf from 'mineflayer-pathfinder';

// fix38: expose pathfinder goals to generated code (fail loud if missing)
const pathfinderGoals = pf.goals;
if (!pathfinderGoals || !pathfinderGoals.GoalNear) {
    throw new Error('[coder] FATAL: mineflayer-pathfinder goals not available - GoalNear and siblings will be undefined at runtime');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

    async generateCode(agent_history) {
        this.agent.bot.modes.pause('unstuck');
        lockdown();
        // this message history is transient and only maintained in this function
        let messages = agent_history.getHistory(); 
        messages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let code = null;
        let no_code_failures = 0;
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (this.agent.bot.interrupt_code)
                return null;
            const messages_copy = JSON.parse(JSON.stringify(messages));
            let res = await this.agent.prompter.promptCoding(messages_copy);
            if (this.agent.bot.interrupt_code)
                return null;
            let contains_code = res.indexOf('```') !== -1;
            if (!contains_code) {
                if (res.indexOf('!newAction') !== -1) {
                    messages.push({
                        role: 'assistant', 
                        content: res.substring(0, res.indexOf('!newAction'))
                    });
                    continue; // using newaction will continue the loop
                }
                
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system', 
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'}
                );
                console.warn("No code block generated. Trying again.");
                no_code_failures++;
                continue;
            }
            code = res.substring(res.indexOf('```')+3, res.lastIndexOf('```'));
            // fix34: formatting-only auto-fix before lint (whitespace, semicolons, quotes - nothing semantic)
            code = this._autoFixFormatting(code);
            const result = await this._stageCode(code);
            const executionModule = result.func;
            const lintResult = await this._lintCode(result.src_lint_copy);
            if (lintResult) {
                const message = 'Error: Code lint error:'+'\n'+lintResult+'\nPlease try again.';
                console.warn("Linting error:"+'\n'+lintResult+'\n');
                messages.push({ role: 'system', content: message });
                continue;
            }
            if (!executionModule) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }

            try {
                console.log('Executing code...');
                await executionModule.main(this.agent.bot);

                const code_output = this.agent.actions.getBotOutputSummary();
                const summary = "Agent wrote this code: \n```" + this._sanitizeCode(code) + "```\nCode Output:\n" + code_output;
                return summary;
            } catch (e) {
                if (this.agent.bot.interrupt_code)
                    return null;
                
                console.warn('Generated code threw error: ' + e.toString());
                console.warn('trying again...');

                const code_output = this.agent.actions.getBotOutputSummary();

                messages.push({
                    role: 'assistant',
                    content: res
                });
                messages.push({
                    role: 'system',
                    content: `Code Output:\n${code_output}\nCODE EXECUTION THREW ERROR: ${e.toString()}\n Please try again:`
                });
            }
        }
        return `Code generation failed after ${MAX_ATTEMPTS} attempts.`;
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
        // fix38: include pathfinder goals in sandbox (they are exposed in the compartment)
        const sandbox = new Set(['skills', 'world', 'log', 'sleep', 'Vec3', 'goals',
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
        for (const n of nodes) {
            if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'bot' && n.property.type === 'Identifier' && !(n.property.name in bot) && !assigned.has(n.property.name))
                errs.add(`bot.${n.property.name} does not exist on the live bot`);
            if (n.type === 'CallExpression') {
                if (n.callee.type === 'Identifier' && !declared.has(n.callee.name) && !sandbox.has(n.callee.name) && !(n.callee.name in globalThis))
                    errs.add(`${n.callee.name}() is not defined (not a skill, not declared in the code)`);
                for (const a of n.arguments) if (a.type === 'Literal' && typeof a.value === 'string' && /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(a.value) && !isName(a.value)) { const nm = nearMiss(a.value);
                    if (nm) errs.add(`'${a.value}' is not an item, block or entity name in this Minecraft version (did you mean '${nm}'?)`); }
            }
        }
        return errs.size ? `API gate: ${[...errs].slice(0, 8).join('; ')}` : null;
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
    // fix34: get the real API surface from module exports (not JSDoc docs)
    _getRealAPI() {
        if (this._realAPICache) return this._realAPICache;
        const realSkillsAPI = Object.keys(skills).filter(k => typeof skills[k] === 'function').map(k => `skills.${k}`);
        const realWorldAPI = Object.keys(world).filter(k => typeof world[k] === 'function').map(k => `world.${k}`);
        this._realAPICache = { set: new Set([...realSkillsAPI, ...realWorldAPI]), list: [...realSkillsAPI, ...realWorldAPI] };
        return this._realAPICache;
    }
    // fix34: find nearest real API call by edit distance; returns { match, dist } or null
    _nearestAPI(call) {
        const { list } = this._getRealAPI();
        const fnName = call.split('.').pop().toLowerCase();
        const prefix = call.startsWith('world.') ? 'world.' : 'skills.';
        const sameModule = list.filter(r => r.startsWith(prefix));
        let best = null, bestDist = Infinity;
        for (const r of sameModule) {
            const dist = this._lev(fnName, r.split('.').pop().toLowerCase());
            if (dist < bestDist) { best = r; bestDist = dist; }
        }
        return best ? { match: best, dist: bestDist } : null;
    }
    // fix34: extract skills.*/world.* calls from code using acorn (avoids false positives in strings/comments)
    _extractApiCalls(code) {
        let ast;
        try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); }
        catch (e) { return { calls: [], positions: [], error: e.message }; }
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
    async  _lintCode(code) {
        let result = '#### CODE ERROR INFO ###\n';
        // fix34: use acorn to extract actual API calls (not regex on strings/comments)
        const { calls, error: parseError } = this._extractApiCalls(code);
        if (parseError) {
            result += `Syntax error (cannot parse): ${parseError}\n`;
            return result;
        }
        const { set, list } = this._getRealAPI();
        const missingCalls = [...new Set(calls.filter(c => !set.has(c)))];
        if (missingCalls.length > 0) {
            result += 'These functions do not exist:\n';
            result += missingCalls.map(m => {
                const nearest = this._nearestAPI(m);
                const scored = list.map(r => ({ r, dist: this._lev(m.split('.').pop().toLowerCase(), r.split('.').pop().toLowerCase()) }))
                    .sort((a, b) => a.dist - b.dist);
                const close = scored.filter(s => s.dist <= 8).slice(0, 5).map(s => s.r);
                return `${m}  -> did you mean: ${close.length ? close.join(', ') : '(none close)'}`;
            }).join('\n');
            result += '\nOnly these functions exist: ' + list.join(', ');
            console.log(result)
            return result;
        }

        const eslint = new ESLint();
        const results = await eslint.lintText(code);
        const codeLines = code.split('\n');
        const exceptions = results.map(r => r.messages).flat();

        if (exceptions.length > 0) {
            exceptions.forEach((exc, index) => {
                if (exc.line && exc.column ) {
                    const errorLine = codeLines[exc.line - 1]?.trim() || 'Unable to retrieve error line content';
                    result += `#ERROR ${index + 1}\n`;
                    // Actionable feedback for empty catch blocks (Mo fail-loud principle)
                    if (exc.ruleId === 'no-empty' && /catch\s*\([^)]*\)\s*\{\s*\}/.test(errorLine)) {
                        result += `Message: EMPTY CATCH BLOCK - swallowing errors hides failures and breaks the repair loop.\n`;
                        result += `Why rejected: Mo fail-loud principle - every error must propagate so the skill library can learn what went wrong. An empty catch silently discards the failure, leaving no trace for diagnosis or repair.\n`;
                        result += `How to fix: Either rethrow the error, or log then rethrow:\n`;
                        result += `  WRONG:  } catch (e) {}\n`;
                        result += `  RIGHT:  } catch (e) { throw e; }\n`;
                        result += `  RIGHT:  } catch (e) { log(bot, \`Step failed: \${e.message}\`); throw e; }\n`;
                        result += `If the error is truly recoverable, log it and return a falsy value - never silently continue.\n`;
                    } else {
                        result += `Message: ${exc.message}\n`;
                    }
                    result += `Location: Line ${exc.line}, Column ${exc.column}\n`;
                    result += `Related Code Line: ${errorLine}\n`;
                    // fix36: add surrounding context to help identify which skill contains the error (especially for joined skill code)
                    const start = Math.max(0, exc.line - 4);
                    const end = Math.min(codeLines.length, exc.line + 2);
                    const context = codeLines.slice(start, end).map((l, i) => {
                        const ln = start + i + 1;
                        const marker = ln === exc.line ? '>>>' : '   ';
                        return `${marker} ${ln}: ${l}`;
                    }).join('\n');
                    result += `Context:\n${context}\n`;
                }
            });
            result += 'The code contains exceptions and cannot continue execution.';
        } else {
            return null;//no error
        }

        return result ;
    }
    // write custom code to file and import it
    // write custom code to file and prepare for evaluation
    async _stageCode(code) {
        code = this._sanitizeCode(code);
        let src = '';
        code = code.replaceAll('console.log(', 'log(bot,');
        code = code.replaceAll('log("', 'log(bot,"');

        console.log(`Staged code (library + generated; the raw model reply size is in the [timing] composer line) (${code.length} chars, ${code.split('\n').length} lines): """${code.length > 400 ? code.slice(-400) + '\n...[truncated]' : code}"""`);   // fix27: tail only (the new code is at the end)

        // this may cause problems in callback functions
        code = code.replaceAll(';\n', '; if(bot.interrupt_code) {log(bot, "Code interrupted.");return;}\n');
        for (let line of code.split('\n')) {
            // every loop iteration checks for an interrupt
            line = line.replace(/^(\s*(?:\}\s*)?(?:for|while)\s*\(.*\)\s*\{)\s*$/, '$1 if (bot.interrupt_code) {log(bot, "Code interrupted.");return;}');
            line = line.replace(/^(\s*do\s*\{)\s*$/, '$1 if (bot.interrupt_code) {log(bot, "Code interrupted.");return;}');
            src += `    ${line}\n`;
        }
        let src_lint_copy = this.code_lint_template.replace('/* CODE HERE */', src);
        src = this.code_template.replace('/* CODE HERE */', src);

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
        // This is where we determine the environment the agent's code should be exposed to.
        // It will only have access to these things, (in addition to basic javascript objects like Array, Object, etc.)
        // Note that the code may be able to modify the exposed objects.
        // generated code gets interrupt-aware skills: once an interrupt is requested every skill call returns false at once
        const guardedSkills = {};
        for (const [k, f] of Object.entries(skills))
            guardedSkills[k] = typeof f === 'function' ? (...a) => (a[0]?.interrupt_code ? Promise.resolve(false) : f(...a)) : f;
        // fix38: expose pathfinder goals so generated code can use GoalNear, GoalFollow, etc.
        const goals = {
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
        const compartment = makeCompartment({
            skills: guardedSkills,
            log: skills.log,
            world,
            Vec3,
            goals,
            GoalNear: goals.GoalNear,
            GoalFollow: goals.GoalFollow,
            GoalInvert: goals.GoalInvert,
            GoalBlock: goals.GoalBlock,
            GoalXZ: goals.GoalXZ,
            GoalNearXZ: goals.GoalNearXZ,
            GoalGetToBlock: goals.GoalGetToBlock,
            GoalLookAtBlock: goals.GoalLookAtBlock,
            GoalBreakBlock: goals.GoalBreakBlock,
            GoalCompositeAny: goals.GoalCompositeAny,
            GoalCompositeAll: goals.GoalCompositeAll,
            sleep: ms => new Promise(r => setTimeout(r, ms)),   // fix27: the only way to wait; setTimeout itself is not in scope
        });
        const mainFn = compartment.evaluate(src);
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js']
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