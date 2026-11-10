import { wordOverlapScore } from '../utils/text.js';
import settings from '../../settings.js';
// Voyager-style lifelong learning loop (after MineDojo/Voyager):
// automatic curriculum -> iterative code generation with env feedback -> self-verification critic -> skill library.
// Learning upgrades (Mo-approved):
//   - ADAM-style needs/produces graph (https://arxiv.org/abs/2410.22194)
//   - AWM repair/workflow memory (https://arxiv.org/abs/2409.07429)
//   - SkillWeaver-style idle practice (https://arxiv.org/abs/2504.07079)
import * as acorn from 'acorn';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync, statSync, copyFileSync, truncateSync, appendFileSync, readdirSync } from 'fs';
import { NeedsProducesGraph } from './needs_produces.js';
import { RepairMemory } from './repair_memory.js';
import { IdlePractice } from './idle_practice.js';
import { VitalsModel } from './vitals_model.js';   // fix58
import { checkNeedSource, needInterruptSource, isUnblamedInterruptKind, sampleBeta, pickUrgentCandidate } from './urgent_need.js';   // fix80
import { peekPreconditionUnmet, clearPreconditionUnmet, checkNeed, reachNeedForBlocks } from './precondition.js';   // fix76; fix81: structured needs (markPreconditionUnmet is called by seeded code)
import { SlotEffects } from './slot_effects.js';   // fix59
import { obtainPlanner } from './recipe_plan.js';   // fix81
import { itemSourceBlocks } from '../utils/item_sources.js';
import { stackableCounts, emptySlotsToFit, roomFor, surplusFromConsumption, inventoryStacks, capacityPlan } from './slot_room.js';   // fix84, fix92
// fix14: crash-safe writes (tmp file + rename)
export function writeAtomic(fp, text) { const tmp = `${fp}.tmp-${process.pid}`; writeFileSync(tmp, text); renameSync(tmp, fp); }
import * as world from './library/world.js';
import * as skills from './library/skills.js';
import { makeCompartment } from './library/lockdown.js';
import { getAllItems, getAllBlocks, getItemCraftingRecipes, isHostile, isDatapackHostile } from '../utils/mcdata.js';
import { cosineSimilarity } from '../utils/math.js';
import minecraftData from 'minecraft-data';
import { Ollama, CONTEXT_FULL } from '../models/ollama.js';
import { setCallDurationStore } from '../models/call_durations.js';
import { setMovementStore, learnedKinds, recordStep, recordCut, stepBound, noteUnbounded } from '../utils/movement_model.js';
import { signatureOf, depsOf, missingCalls, installViolations, newStats, recordRun, rate, gateLog, instrumentSrc, annotateTrace, traceText, blame, blameAll, parentsOf, thrownIn, declaredNames, skillSourceViolations, splitGeneratedCode, oneFunctionFeedback, entryCallFeedback, markerCallsMissing, markerGateNames, collapseRepeats, parsesAsScript, pastedLibrarySkills, groupVaryingLines, structuredTrace } from './skill_graph.js';
import { writeCodePromptDump } from '../models/code_prompt_dump.js';
import { getBareAPI, collectBareApiUsedInSource, PRECONDITION_UNMET_BINDING } from './coder.js';   // fix40: unified bare-name API helper
import { withStallPhase } from '../utils/event_loop_guard.js';
import { watchdogEvidencePath } from '../utils/main_thread_watchdog.js';
import { wrapBotForApiTiming } from '../utils/bot_api_timing.js';
import { logPromptBreakdown, extractBareCalls } from './prompt_utils.js';   // fix47: shared prompt utilities
import { recordConsumeEvidence, verifiedConsumes, recordEffectEvidence, verifiedEffects, count as invCount } from './consume_evidence.js';   // fix70, fix74
import { practiceWorld, causalChanges, effectVerdict, noteCausalSuccess } from './practice_rank.js';   // fix93
import { createInferenceCover } from './inference_cover.js';   // fix93
import { repairRetrySuffix, executableIdentity, repeatedRejection, builtInsCalled, repairLessonInHistory } from './repair_attempt.js';   // fix93
import { voyagerCodingInstructions } from './prompt_cut.js';   // fix93
import { edibleNames, entityDroppers, planFoodAcquisition, hungerDeficitClosed } from './food_backchain.js';   // fix93
// fix70: how much of a repair's evidence a [psn] log line shows (a log excerpt; the full evidence stays on the queue entry)
const LOG_EVIDENCE_CHARS = 160;
// fix79: _attribute's verdict when the run met every contract and the goal failed only because the route sent it to a skill with no
//        learned evidence of producing the goal items: the route is blamed, not the skill
export const MISROUTED = 'misrouted';
// fix70: the API-lint failure in the repair evidence the code model sees. One definition for the startup re-lint and the
// repair-time re-lint, so both evidences are the same text. fix96: the whole lint text (it was cut at 600 chars).
const apiLintEvidence = (name, lint) => `${name} does not lint against the current built-in API, so it cannot run: ${String(lint).replace(/\s+/g, ' ')}`;
const LOCAL = { model: 'qwen3:4b-instruct-2507-q4_K_M', url: 'http://192.168.1.215:11434', params: { format: 'json', options: { num_ctx: 8192, num_predict: 512 } } };   // fix38: raised from 150 to 512 - short JSON replies still need room for reasoning; truncation fails loudly (fix31)
export const CALLS = { local: 0, code: 0, replay: 0 };

// fix68b: PSN parent is __syncParent inside instrumentSrc (no AsyncLocalStorage — CVE-2025-59466)

// fix12: HOME is the single source of truth for the bot's base (town centre, hut, leash, red-zone teleport).
// Moved from the old base to the grove where the bot ended up; the hut there is built by the home_hut milestone.
// fix14: HOME lives in ONE file, bots/icefox2000/home.json ({x, y, z, groundVerified}); missing/invalid file = startup error (no fallback).
// y is corrected once from the real ground height when the bot is near home (see _checkHomeGround) and saved back to the file.
const HOME_FILE = './bots/icefox2000/home.json';
const HOME = JSON.parse(readFileSync(HOME_FILE, 'utf8'));
if (![HOME.x, HOME.y, HOME.z].every(Number.isFinite)) throw new Error(`[home] ${HOME_FILE} must hold numeric x, y, z`);
const TOWN = HOME;
const VILLAGE = { x: -800, z: 500 };
const MAX_ATTEMPTS = 4;
const PLAYER_QUIET_MS = 90 * 1000;   // pause after any player message
const HUT = { get x() { return HOME.x; }, get y() { return HOME.y + 1; }, get z() { return HOME.z; } };   // HUT.y - 1 = floor/feet level (interior HOME±2, walls at ±3)
// fix27: fixed milestone ordering removed; the curriculum learns what to do next

// tolerant JSON: strip fences, fix stray backslashes / trailing commas, then fall back to field regexes
// fix31: local (Ollama format=json) replies must be complete JSON with the required keys - no salvage, fail loudly
export function parseLocalJSON(text, keys) {
    let o; try { o = JSON.parse(String(text)); } catch (e) { throw new Error('local model reply is not valid JSON: ' + String(text).slice(0, 200)); }
    const miss = keys.filter(k => !(k in o)); if (miss.length) throw new Error(`local model reply lacks ${miss.join(', ')}: ` + String(text).slice(0, 200));
    return o;
}
export function parseJSON(text) {
    const raw = String(text).replace(/```(?:json)?/g, '');
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
        for (const cand of [m[0], m[0].replace(/\\(?!["\\/bfnrtu])/g, '\\\\').replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001f]+/g, ' ')]) {
            try { return JSON.parse(cand); } catch (e) {}
        }
    }
    const out = {};
    for (const k of ['task', 'context', 'reasoning', 'critique']) {
        const f = raw.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
        if (f) out[k] = f[1];
    }
    const b = raw.match(/"success"\s*:\s*(true|false)/);
    if (b) out.success = b[1] === 'true';
    if (!Object.keys(out).length) throw new Error('no JSON in model reply: ' + raw.slice(0, 200));
    return out;
}
// fix38: extract FAILED lines + head/tail for execution feedback (FAILED lines must never be truncated away)
// fix96: nothing is cut. The FAILED/ERROR section repeated lines the output already holds and the head/tail cut dropped the
//        middle; the feedback is now the whole output with identical consecutive lines written once with their count.
export function extractFeedback(output) {
    if (arguments.length !== 1) throw new Error(`[fix96] extractFeedback takes the output only (nothing is cut), got ${arguments.length} arguments`);
    return collapseRepeats(String(output === undefined || output === null ? '' : output).split('\n')).join('\n');
}
// fix97: the code-retry prompt is this text. compose-retry #78 (fix96 1c2f9c0, Collect 1 stripped_birch_wood) sent
// the prompt in CODE_RETRY_78 (test/fixtures/code_retry_observation.js): 181705 chars, retry section 170464 (94%),
// Ollama prompt_eval_count 58984 against num_ctx 8192.
// The section was attempt 1's execution output, the 789-call trace, the inventory-full fact and the behaviour log,
// each repeating the same lines. collapseRepeats only merges consecutive identical lines, so 60 identical
// collectLogs FAILs interleaved with other calls, and pathfinder lines that differ by coordinates, all stayed.
// This builds the same facts once. Lines that differ only by numbers are one template: each numeric slot is an
// exact run, an arithmetic range, or the value list, so every value can be read back. When that grouping would
// change the order, each row keeps the index it had. A line already printed
// verbatim is not pasted again. A longer line is not the same line. Nothing is sliced.
export function codeRetryFeedback({ cut, output, trace, critique, invFull, behaviorLog }) {
    if (typeof critique !== 'string') throw new Error('[fix97] code retry feedback needs the critic text');
    if (typeof output !== 'string') throw new Error('[fix97] code retry feedback needs the execution output');
    if (typeof behaviorLog !== 'string') throw new Error('[fix97] code retry feedback needs the behaviour log');
    if (!(trace === null || Array.isArray(trace))) throw new Error('[fix97] code retry feedback needs the execution trace, or null when the attempt produced none');
    if (invFull !== null && invFull !== undefined && typeof invFull !== 'string') throw new Error('[fix97] code retry inventory fact must be text or null');
    const covered = new Set();
    const cover = (text) => { for (const line of String(text).split('\n')) { const t = line.trim(); if (t) covered.add(t); } };
    const traceTextOut = Array.isArray(trace) ? structuredTrace(trace) : '';
    cover(traceTextOut);
    const inv = typeof invFull === 'string' ? invFull : '';
    if (inv.length) cover(inv);
    if (cut) { cover(String(cut)); cover(`Attempt ${cut}`); }
    const fresh = (text) => {
        const kept = [];
        for (const line of String(text).split('\n')) {
            const t = line.trim();
            if (!t || covered.has(t)) continue;
            kept.push(line);
        }
        for (const line of kept) covered.add(line.trim());
        return groupVaryingLines(kept.join('\n'));
    };
    const outputFacts = fresh(output);
    const behaviorFacts = fresh(behaviorLog);
    const parts = [];
    if (cut) parts.push(`Attempt ${cut}`);
    if (traceTextOut) parts.push(`Execution trace:\n${traceTextOut}`);
    if (outputFacts) parts.push(`Execution output:\n${outputFacts}`);
    if (critique.length) parts.push(`Critic: ${critique}`);
    if (inv.length) parts.push(`Inventory fact: ${inv}`);
    if (behaviorFacts) parts.push(`Chat/behaviour log:\n${behaviorFacts}`);
    return parts.join('\n');
}
let NAMES = null;
function knownNames() {
    if (!NAMES) NAMES = new Set([...getAllItems().map(i => i.name), ...getAllBlocks().map(b => b.name)]);
    return NAMES;
}
// returns an error string if the task names things that do not exist / cannot be obtained
export function validateTask(task) {
    const t = task.toLowerCase();
    if (/\b(cave_|void_)?air(_block)?\b/.test(t)) return 'air is not a block you can mine or collect';
    if (!/^(mine|collect|gather|craft|smelt|obtain|get|chop|cook)\b/.test(t)) return null; // build/explore tasks: free text
    const names = knownNames();
    const bad = (t.match(/\b[a-z]+(?:_[a-z]+)+\b/g) || []).filter(n => !names.has(n));
    if (bad.length) return `unknown item/block names: ${bad.join(', ')} (use exact Minecraft ids like oak_log, cobblestone, iron_ingot)`;
    return null;
}
// "Mine 5 birch_log" / "Craft 1 stone_pickaxe" -> {item, count}
// real crafting recipes (from minecraft-data) for every item id named in a text, so the local models stop inventing them
// fix96: every recipe form, nothing cut (it showed 3 forms, "...N more", and at most 6 items). Forms that differ only in
//         one ingredient (the wood type of planks, the colour of wool) are written once with the alternatives listed, so
//         the text is short and every form is still there.
export function recipeFormsText(id, recipes) {
    const forms = [], seen = new Set();
    for (const [ing, r] of recipes) {
        const f = { n: r.craftedCount, ing: Object.entries(ing) };
        const k = JSON.stringify([f.n, [...f.ing].sort()]);
        if (!seen.has(k)) { seen.add(k); forms.push(f); }
    }
    // every way to read a form as "one varying ingredient + the rest": the largest such family is written as one line,
    // then the next among the forms left; a form in no family of two is written on its own
    const families = new Map();
    forms.forEach((f, fi) => f.ing.forEach(([name, c], i) => {
        const rest = f.ing.filter((_, j) => j !== i).map(([n2, c2]) => `${c2} ${n2}`).sort();
        const k = JSON.stringify([f.n, c, rest]);
        if (!families.has(k)) families.set(k, { n: f.n, c, rest, members: [] });
        families.get(k).members.push({ fi, name });
    }));
    const done = new Set(), out = [];
    for (;;) {
        let best = null;
        for (const fam of families.values()) {
            const left = fam.members.filter(m => !done.has(m.fi));
            if (left.length > 1 && (!best || left.length > best.left.length)) best = { fam, left };
        }
        if (!best) break;
        for (const m of best.left) done.add(m.fi);
        out.push([`${best.fam.c} ${best.left.map(m => m.name).join('|')}`, ...best.fam.rest].join(' + ') + ` -> ${best.fam.n} ${id}`);
    }
    forms.forEach((f, fi) => { if (!done.has(fi)) out.push(f.ing.map(([n, c]) => `${c} ${n}`).join(' + ') + ` -> ${f.n} ${id}`); });
    return `${id}: ${out.join(' | ')}`;
}
function recipeFacts(text) {
    const ids = [...new Set((String(text).toLowerCase().match(/\b[a-z]+(?:_[a-z]+)*\b/g) || []))];
    const out = [];
    for (let id of ids) {
        if (id.endsWith('es') && id !== 'glasses') { const t = id === 'torches' ? 'torch' : id.slice(0, -1); if (getItemCraftingRecipes(t)) id = t; }
        else if (id.endsWith('s') && getItemCraftingRecipes(id.slice(0, -1))) id = id.slice(0, -1);
        const rs = getItemCraftingRecipes(id);
        if (!rs?.length) continue;
        out.push(recipeFormsText(id, rs));
    }
    return out.length ? 'RECIPES (from minecraft-data, authoritative):\n' + [...new Set(out)].join('\n') : '';
}
// fix47: parse number words using words-to-numbers library (MIT)
import { wordsToNumbers } from 'words-to-numbers';
export function parseNumberWord(word) {
    if (!word) return null;
    const lower = word.toLowerCase().trim();
    // Try direct numeric parse first
    const num = parseInt(lower, 10);
    if (!isNaN(num)) return num;
    // Use words-to-numbers library for word-to-number conversion
    try {
        const result = wordsToNumbers(lower);
        if (typeof result === 'number' && !isNaN(result)) return result;
        // Library returns string if no conversion, try parsing it
        const parsed = parseInt(result, 10);
        if (!isNaN(parsed)) return parsed;
    } catch (e) {
        // Library threw - not a valid number word
    }
    return null;
}

// A stored task is the goal sentence, or "kind: sentence" (craftItem: Craft 1 iron_pickaxe,
// collectSurface: Collect 32 dirt). The kind is one identifier, the label the curriculum wrote;
// the sentence is the goal. countGoal, smeltGoal, ensureGoal, and reachGoal all read the sentence,
// and parseVerboseGoal and _resolveGoal call those parsers.
function goalSentence(task) {
    if (typeof task !== 'string') return task;
    const m = task.match(/^([A-Za-z_][A-Za-z0-9_]*):\s+([\s\S]+)$/);
    return m ? m[2] : task;
}
function countGoal(task) {
    task = goalSentence(task);
    // fix47: support both numeric ("5") and word ("five") counts
    const m = task.match(/^(mine|collect|gather|craft|smelt|obtain|get|chop|cook)\s+(\d+|[a-z]+)\s+([a-z_ ]+)/i);
    if (!m) return null;
    const verb = m[1].toLowerCase();
    const countParsed = parseNumberWord(m[2]);
    if (countParsed === null) return null;  // not a valid number
    // fix51: item = longest leading word run that is a registry item/block ("iron pickaxe" -> iron_pickaxe, never "iron")
    // fix49: fail loud if VERSION is not set (no fallback)
    if (!VERSION) throw new Error(`[fix49] LOUD FAIL: countGoal called but VERSION is null - bot version must be set before parsing goals`);
    const md = minecraftData(VERSION);
    const words = m[3].toLowerCase().trim().split(/[\s_]+/);
    const inReg = n => Boolean(md.itemsByName[n] || md.blocksByName[n]);
    let item = null;
    for (let k = words.length; k > 0 && !item; k--) {
        const cand = words.slice(0, k).join('_');
        if (inReg(cand)) item = cand;
        else if (cand.endsWith('s') && inReg(cand.slice(0, -1))) item = cand.slice(0, -1);
        else if (cand.endsWith('es') && inReg(cand.slice(0, -2))) item = cand.slice(0, -2);
    }
    if (!item) return null;
    // mining a block counts its loot drops too (iron_ore -> raw_iron, coal_ore -> coal, stone -> cobblestone)
    let items = [item];
    if (['mine', 'collect', 'gather', 'chop', 'get', 'obtain'].includes(verb)) {
        for (const d of (md.blockLoot?.[item]?.drops || [])) if (!items.includes(d.item)) items.push(d.item);
    }
    return { count: countParsed, item, items, verb };
}
// fix52: registry version known at module load from settings.minecraft_version (the version the bot connects as),
// so goals parsed before spawn (_polyMerge -> _findReplay -> countGoal in the constructor) have a registry.
// bot.version overwrites it after spawn. Fail loud if settings names a version minecraft-data does not know.
function registryVersion(v) {
    if (!minecraftData(v)) throw new Error(`[fix52] LOUD FAIL: settings.minecraft_version "${v}" has no minecraft-data registry`);
    return v;
}
let VERSION = registryVersion(settings.minecraft_version);
// fix46: test-only setter for VERSION (parseVerboseGoal requires VERSION to be set)
export function _setVersionForTest(v) { VERSION = v; }
// How many of an item each recipe consumes. Built once per registry; itemFacts reads it for the item being grounded.
const recipeUseCounts = new WeakMap();

// fix49: parse "ensure X" goals - places a block/item nearby (furnace, crafting_table, chest, etc.)
// The goal item must be placed, not just in inventory - so satisfaction requires the item to exist as a block nearby
// Uses observed state (findBlock) to check satisfaction, not skill name patterns
function ensureGoal(task) {
    task = goalSentence(task);
    const m = task.match(/^ensure\s+([a-z_]+)\b/i);
    if (!m) return null;
    const item = m[1].toLowerCase().replace(/ /g, '_');
    // fix49: fail loud if VERSION not set - no fallback
    if (!VERSION) {
        throw new Error(`[fix49] LOUD FAIL: ensureGoal called but VERSION is null - bot version must be set before parsing goals`);
    }
    // validate item exists in registry (no hard-coded list)
    const md = minecraftData(VERSION);
    if (!md.itemsByName[item] && !md.blocksByName[item]) return null;
    return { count: 1, item, items: [item], verb: 'ensure' };
}

// fix83: "reach <block>" - a source block the bot needs is not within reach (collectBlock found none); verified by the block
//        being observed nearby (observe().nearby_blocks), like an ensure goal, but it is FOUND, not placed: its failure needs
//        are not "place it" (that would chain reach -> place -> collect -> reach)
function reachGoal(task) {
    task = goalSentence(task);
    const m = task.match(/^reach\s+([a-z_]+)$/i);
    if (!m) return null;
    if (!VERSION) throw new Error('[fix83] LOUD FAIL: reachGoal called but VERSION is null - bot version must be set before parsing goals');
    const item = m[1].toLowerCase();
    if (!minecraftData(VERSION).blocksByName[item]) return null;
    return { count: 1, item, items: [item], verb: 'reach' };
}

// "Smelt 6 raw_iron into 6 iron_ingot" -> verify by output gained
function smeltGoal(task) {
    task = goalSentence(task);
    const m = task.match(/^(?:smelt|cook)\s+(\d+)\s+([a-z_]+)\s+into\s+(\d+)\s+([a-z_]+)/i);
    return m ? { count: parseInt(m[1]), outputCount: parseInt(m[3]), input: m[2].toLowerCase(), verb: 'smelt', item: m[4].toLowerCase(), items: [m[4].toLowerCase()] } : null;
}

// fix55: required params of a skill besides bot (from its signature; params with defaults are optional)
function requiredArgs(e) {
    const sig = signatureOf(e.code, e.name), m = sig.match(/\(([^)]*)\)/);
    if (!m) throw new Error(`[fix55] LOUD FAIL: cannot read the parameter list of skill ${e.name} from signature "${sig}"`);
    return m[1].split(',').slice(1).map(x => x.trim()).filter(x => x && !x.includes('='));
}
// fix55: the whole text is one JS identifier (acorn's own identifier tables; syntax only, no name lists)
function isBareIdentifier(t) {
    const cps = [...t].map(ch => ch.codePointAt(0));
    return cps.length > 0 && acorn.isIdentifierStart(cps[0], true) && cps.every(cp => acorn.isIdentifierChar(cp, true));
}

// fix46: parse verbose goal strings like "craftItem: Craft 1 iron_pickaxe using 1 iron_ingot..."
// Uses minecraft-data registry to validate item names (no hard-coded tables per owner rules)
// Returns {item, count, items} or null if unparseable; logs loudly if VERSION is missing
// Prefers structured {item, count} on goals - parsing is only for legacy text
export function parseVerboseGoal(task) {
    if (!task || typeof task !== 'string') return null;
    const t = task.toLowerCase();
    
    // Try standard parsers first
    const std = smeltGoal(task) || countGoal(task);
    if (std) return std;
    
    // fix46: VERSION is the single source (set from bot.version when task starts) - fail loud if null
    if (!VERSION) {
        console.error(`[fix46] LOUD FAIL: parseVerboseGoal called but VERSION is null - bot version must be set before parsing goals`);
        return null;
    }
    
    let md;
    try { md = minecraftData(VERSION); } 
    catch (e) { 
        console.error(`[fix46] LOUD FAIL: minecraft-data unavailable for version ${VERSION}: ${e.message}`);
        return null;
    }
    
    // fix46: generic plural handling against registry (no hard-coded torches/glasses)
    // Try: name as-is, then minus 's', then minus 'es' - keep whichever is in registry
    const resolveItem = (name) => {
        const lower = name.toLowerCase();
        // Try exact match first
        if (md.itemsByName[lower] || md.blocksByName[lower]) return lower;
        // Try minus 's'
        if (lower.endsWith('s')) {
            const singular = lower.slice(0, -1);
            if (md.itemsByName[singular] || md.blocksByName[singular]) return singular;
        }
        // Try minus 'es'
        if (lower.endsWith('es')) {
            const singular = lower.slice(0, -2);
            if (md.itemsByName[singular] || md.blocksByName[singular]) return singular;
        }
        return null;
    };
    
    // Extract all potential "count item" pairs from the text
    // fix47: support both numeric ("5") and word ("five") counts
    const candidates = [];
    const patternNumeric = /\b(\d+)\s+([a-z][a-z0-9_]*)\b/gi;
    let m;
    while ((m = patternNumeric.exec(t))) {
        const count = parseInt(m[1]);
        const resolved = resolveItem(m[2]);
        if (resolved) {
            candidates.push({ count, item: resolved, pos: m.index });
        }
    }
    // Also try number words (one, two, three, etc.) - match word followed by item
    // Common number words pattern (words-to-numbers handles the actual parsing)
    const numberWordPattern = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\s+([a-z][a-z0-9_]*)\b/gi;
    while ((m = numberWordPattern.exec(t))) {
        const count = parseNumberWord(m[1]);
        if (count !== null) {
            const resolved = resolveItem(m[2]);
            if (resolved) {
                candidates.push({ count, item: resolved, pos: m.index });
            }
        }
    }
    
    // fix51: try camelCase skill names like "craftIronHelmet" -> iron_helmet (count defaults to 1)
    // Try every contiguous span of camel-parts against minecraft-data names, longest first
    if (candidates.length === 0) {
        const camelParts = task.match(/[A-Z]?[a-z0-9]+/g);
        if (camelParts && camelParts.length >= 1) {
            // Try all contiguous spans, longest first (greedy)
            for (let len = camelParts.length; len > 0; len--) {
                for (let start = 0; start <= camelParts.length - len; start++) {
                    const span = camelParts.slice(start, start + len);
                    const itemName = span.map(p => p.toLowerCase()).join('_');
                    const resolved = resolveItem(itemName);
                    if (resolved) {
                        console.log(`[fix51] parsed camelCase "${task}" -> ${resolved} (count 1)`);
                        return { count: 1, item: resolved, items: [resolved] };
                    }
                }
            }
        }
    }
    
    if (candidates.length === 0) {
        // fix51: enhanced LOUD logging - include full goal text and log to file for analysis
        console.log(`[fix46] LOUD: parseVerboseGoal failed for "${task}": no valid item name found in registry`);
        mkdirSync('./bots', { recursive: true });
        appendFileSync(`./bots/parseVerboseGoal_failures.jsonl`, JSON.stringify({ at: new Date().toISOString(), task, version: VERSION }) + '\n');
        return null;
    }
    
    // Pick the first valid candidate (typically the goal item in "Craft 1 iron_pickaxe using...")
    const best = candidates[0];
    
    // fix46: removed verb list and blockLoot expansion (no silent catch, no hard-coded verbs)
    // Return just {item, count, items} - verb is not needed for satisfaction check
    return { count: best.count, item: best.item, items: [best.item] };
}

function gainedFor(goal, before, after) {
    return goal.items.reduce((a, it) => a + (after.inventory[it] || 0) - (before.inventory[it] || 0), 0);
}
function extractCode(text) {
    const m = String(text).match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
    return m ? m[1].trim() : null;
}

// fix28: size-based log rotation: mindcraft.log -> .1 -> .2 -> .3 (oldest dropped), then truncate in place
function rotateLog(fp, max, keep) {
    try { if (!existsSync(fp) || statSync(fp).size < max) return;
        for (let i = keep; i >= 1; i--) { const src = i === 1 ? fp : `${fp}.${i - 1}`; if (existsSync(src)) copyFileSync(src, `${fp}.${i}`); }
        truncateSync(fp, 0); console.log(`[log] rotated ${fp} (> ${Math.round(max / 1e6)} MB; keeping ${keep})`);
    } catch (e) { console.log('[log] rotation failed: ' + e.message); }
}
// fix75: what makes two step errors "the same": the error's class and message and the frame that raised it
export function stepErrorSignature(e) {
    if (!(e instanceof Error)) return `non-Error ${typeof e}: ${String(e)}`;
    const top = String(e.stack).split('\n').find(l => l.trimStart().startsWith('at '));
    return `${e.name}: ${e.message} @ ${top === undefined ? '(no stack frame)' : top.trim()}`;
}

// fix91b: a blocker names exactly one of item (string) or anyOf (a non-empty array of non-empty strings).
//         recipe_plan cheapest() plans `count` of one member; it does not add the members together.
function readBlockerNames(entry, msg) {
    const hasItem = typeof entry.item === 'string';
    const hasAny = Object.hasOwn(entry, 'anyOf');
    if (hasItem === hasAny) throw new Error(msg);
    if (hasItem) return { item: entry.item };
    if (!Array.isArray(entry.anyOf)) throw new Error(msg);
    if (entry.anyOf.length === 0) throw new Error(msg);
    const anyOf = [];
    for (const name of entry.anyOf) {
        if (typeof name !== 'string') throw new Error(msg);
        if (name.length === 0) throw new Error(msg);
        anyOf.push(name);
    }
    return { anyOf };
}

// fix81 boot check. fix91b: item XOR anyOf. A stored anyOf need has no item key (JSON drops undefined).
export function assertProgressBlocker(b) {
    const msg = `[fix81] progress.blockers entry is not a structured need { item | anyOf, count, reason, task }: ${JSON.stringify(b)}`;
    if (b === null) throw new Error(msg);
    if (typeof b !== 'object') throw new Error(msg);
    if (!Number.isInteger(b.count)) throw new Error(msg);
    if (typeof b.reason !== 'string') throw new Error(msg);
    readBlockerNames(b, msg);
}

export class Voyager {
    constructor(agent) {
        this.agent = agent;
        this.dir = `./bots/${agent.name}/skills`;
        mkdirSync(this.dir, { recursive: true });
        this.indexFile = `${this.dir}/index.json`;
        this.progressFile = `${this.dir}/progress.json`;
        this.skills = existsSync(this.indexFile) ? JSON.parse(readFileSync(this.indexFile, 'utf8')) : [];
        this._unverifiedConsumesNoted = new Set();   // fix70: skills whose evidence-less consumes was logged once (see _shouldSkipPractice)
        this._unjudgeableNoted = new Set();   // fix74: skills logged once as not practisable (nothing can judge their run)
        this._lastStepErrSig = null;   // fix75: signature of the previous step's error (null after a step that did not throw)
        this.installRejections = [];   // fix88: rejection records for a skill that is not in the library yet (no entry to hang repairHistory on)
        this._installRejection = null;   // fix88: evidence from the saveSkill call in progress, so the code loop can feed it back
        // fix49: ensure every skill has effects/consumes/stats (older skill files may not have them)
        for (const s of this.skills) {
            if (!s.effects) s.effects = [];
            if (!s.consumes) s.consumes = {};
            if (!s.stats) s.stats = newStats();
            // fix74: effects are read directly everywhere (no `|| []`); a candidate is created with them (saveSkill HOLD, fix25)
            if (s.candidate && !Array.isArray(s.candidate.effects)) throw new Error(`[psn] skill ${s.name}: candidate has no effects array (${JSON.stringify(s.candidate.effects)})`);
        }
        this.progress = existsSync(this.progressFile) ? JSON.parse(readFileSync(this.progressFile, 'utf8'))
            : { completed: [], failed: [], enabled: true, goalStats: {}, goalFailStates: [] };
        // fix49: ensure goalStats exists (older progress files may not have it)
        if (!this.progress.goalStats) this.progress.goalStats = {};
        // fix90: each goal outcome tagged with the state it was observed in (inventory + nearby blocks).
        // Older progress files do not have the array; it starts empty.
        if (!Object.hasOwn(this.progress, 'goalFailStates')) this.progress.goalFailStates = [];
        if (!Array.isArray(this.progress.goalFailStates)) throw new Error(`[fix90] progress.goalFailStates must be an array, got ${JSON.stringify(this.progress.goalFailStates)}`);
        // fix81: structured needs of failed goals (curriculum BLOCKERS) and game-data producer edges (untried until a run proves them).
        //        A blocker in the old fix47 { tool, block } shape cannot be resolved by item: refuse it loudly (the live file has none).
        //        fix91b: an anyOf need has no item. Writing { item: undefined } drops the key in JSON and the next boot exits.
        //        Accept item XOR anyOf; anything else still throws.
        if (!Object.hasOwn(this.progress, 'blockers')) this.progress.blockers = [];
        for (const b of this.progress.blockers) assertProgressBlocker(b);
        if (!Object.hasOwn(this.progress, 'recipeEdges')) this.progress.recipeEdges = {};
        // fix97: a task whose code or curriculum prompt does not fit the context. Persisted, so a restart does not rebuild it.
        if (!Object.hasOwn(this.progress, 'contextBlocked')) this.progress.contextBlocked = {};
        if (this.progress.contextBlocked === null || typeof this.progress.contextBlocked !== 'object' || Array.isArray(this.progress.contextBlocked)) throw new Error(`[fix97] progress.contextBlocked must be an object, got ${JSON.stringify(this.progress.contextBlocked)}`);
        // fix95: when each task last completed (ms). A decomposition is stale only when its parent completed AFTER it was
        //        decomposed. Older progress files have no map; it starts empty (no completion is known to postdate a decomposition).
        if (!Object.hasOwn(this.progress, 'completedAt')) this.progress.completedAt = {};
        if (this.progress.completedAt === null || typeof this.progress.completedAt !== 'object' || Array.isArray(this.progress.completedAt)) throw new Error(`[fix95] progress.completedAt must be an object, got ${JSON.stringify(this.progress.completedAt)}`);
        // fix58: learned vitals relations (food level -> hp regen, skill -> food/hp change), persisted with progress
        if (!this.progress.vitals) this.progress.vitals = { regen: {}, runs: {}, foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } } };
        if (!this.progress.vitals.foodSamples) this.progress.vitals.foodSamples = { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } };
        this.vitals = new VitalsModel(this.progress.vitals);
        // fix59: learned per-skill inventory-slot effect (replaces the fix39 free-space name regex/list)
        if (!this.progress.slots) this.progress.slots = { runs: {} };
        this.slotEffects = new SlotEffects(this.progress.slots);
        // fix60: learned local-model call durations (bound a hung Ollama call), persisted with progress
        if (!this.progress.callDurations) this.progress.callDurations = {};
        setCallDurationStore(this.progress.callDurations);
        // fix66: learned time per block / per progress gap (movement no-progress checks), persisted with progress
        if (!this.progress.movement) this.progress.movement = {};
        setMovementStore(this.progress.movement);
        this.running = false;
        this.abort = false;
        this.lastPlayerMsg = 0;
        this.lastTaskEnd = 0;
        
        // ADAM-style needs/produces graph (learned item relationships)
        this.npGraph = new NeedsProducesGraph(agent.name);
        
        // AWM repair/workflow memory (repair lessons and workflows)
        this.repairMemory = new RepairMemory(agent.name, async (text) => this._embed(text));
        
        // SkillWeaver-style idle practice
        this.idlePractice = new IdlePractice(agent.name);
        
        // fix38: Chest memory - persist seen chest positions and contents (learned path, not hard-coded)
        const chestMemFile = `./bots/${agent.name}/chest_memory.json`;
        this.chestMemoryFile = chestMemFile;
        this.chestMemory = existsSync(chestMemFile) ? JSON.parse(readFileSync(chestMemFile, 'utf8')) : {};
        this._setupChestTracking();
        if (!globalThis.__voyagerGuard) {
            globalThis.__voyagerGuard = true;
            const onErr = (kind) => (err) => this._onProcessError(kind, err);
            process.on('uncaughtException', onErr('UNCAUGHT EXCEPTION'));
            process.on('unhandledRejection', onErr('UNHANDLED REJECTION'));
        }
        if (!globalThis.__logRotate) { const timer = setInterval(() => rotateLog('./logs/mindcraft.log', 25e6, 3), 60e3); timer.unref(); globalThis.__logRotate = timer; rotateLog('./logs/mindcraft.log', 25e6, 3); }   // fix28: the rotator must not hold the process open
        this._migrateToBarenames();  // fix40: one-time migration from skills.*/world.* to bare names
        this._seedPrimitives();
        this._relink();
        this._assertOneFunctionSources();   // fix82
        this._polyMerge();
        this._extractShared();
        this._reportWatchdogKill(watchdogEvidencePath(`./bots/${agent.name}`));   // fix96
        this._settleDeadTrials(watchdogEvidencePath(`./bots/${agent.name}`));   // fix65: a run that killed the previous process counts
        // fix50: assert no prefixed calls in prompt sources (fail loud at load time)
        if (this.agent?.prompter?.profile) {
            Voyager.assertNoPromptPrefixes(this.agent.prompter.profile, this.repairMemory);
        }
    }
    // fix40/41: migration from skills.*/world.* to bare names
    // Rewrites all saved skill code to use bare function names instead of skills.X/world.Y
    // fix41: uses Object.keys for names (not extractSig), adds catch-all, re-runs on leftovers, also rewrites s.candidate.code
    // fix42: MUST NOT create self-recursion by rewriting skills.NAME/world.NAME to NAME inside function NAME
    _migrateToBarenames() {
        // fix50: shared regex and field extractor for ALL code fields that can feed composer/repair prompts
        const LEFTOVER_RE = /\b(?:skills|world)\.\w+/;
        // fix50: extract ALL code strings from a skill entry (code, candidate.code, prev.code, handwritten_original.code, variants[*].code, repairHistory[*] code)
        const extractCodeFields = (s) => {
            const fields = [];
            if (s.code) fields.push({ path: 'code', value: s.code });
            if (s.candidate?.code) fields.push({ path: 'candidate.code', value: s.candidate.code });
            if (s.prev?.code) fields.push({ path: 'prev.code', value: s.prev.code });
            if (s.handwritten_original?.code) fields.push({ path: 'handwritten_original.code', value: s.handwritten_original.code });
            if (Array.isArray(s.variants)) {
                for (let i = 0; i < s.variants.length; i++) {
                    const v = s.variants[i];
                    if (typeof v === 'object' && v?.code) fields.push({ path: `variants[${i}].code`, value: v.code });
                }
            }
            if (Array.isArray(s.repairHistory)) {
                for (let i = 0; i < s.repairHistory.length; i++) {
                    const rh = s.repairHistory[i];
                    if (rh?.code) fields.push({ path: `repairHistory[${i}].code`, value: rh.code });
                    if (rh?.fixSnippet) fields.push({ path: `repairHistory[${i}].fixSnippet`, value: rh.fixSnippet });
                }
            }
            return fields;
        };
        const hasLeftovers = () => this.skills.some(s => extractCodeFields(s).some(f => LEFTOVER_RE.test(f.value)));
        if (this.progress.migratedToBarenames && !hasLeftovers()) return;  // fully migrated
        if (this.progress.migratedToBarenames) {
            console.log('[fix41] migratedToBarenames was true but leftovers remain - rerunning migration');
        }
        // fix41: collect rewrite names from Object.keys where typeof function (not extractSig)
        const skillFnNames = Object.keys(skills).filter(k => typeof skills[k] === 'function' && k !== 'log');
        const worldFnNames = Object.keys(world).filter(k => typeof world[k] === 'function');
        const allNames = new Set([...skillFnNames, ...worldFnNames]);
        // fix42: derive seeded names from SEEDED_PRIMITIVES source of truth (not a hard-coded list)
        const seededNames = new Set(Voyager.SEEDED_PRIMITIVES.map(p => p.name));
        const needsReheal = new Set();
        // fix42: rewrite helper - detects self-call and marks seeded for reheal instead of creating recursion
        const rewriteCode = (code, skillFnName) => {
            if (!code) return { code, changes: 0 };
            let changes = 0;
            for (const name of allNames) {
                // fix42: detect self-call: skills.NAME or world.NAME inside function NAME
                if (name === skillFnName) {
                    const selfCallSkills = new RegExp(`\\bskills\\.${name}\\s*\\(`).test(code);
                    const selfCallWorld = new RegExp(`\\bworld\\.${name}\\s*\\(`).test(code);
                    if (selfCallSkills || selfCallWorld) {
                        if (seededNames.has(name)) {
                            console.log(`[fix42] SELF-CALL DETECTED: function ${skillFnName} calls ${selfCallSkills ? 'skills' : 'world'}.${name}; marking for seed reheal`);
                            needsReheal.add(name);
                        } else {
                            console.error(`[fix42] SELF-CALL BLOCKED: function ${skillFnName} calls ${selfCallSkills ? 'skills' : 'world'}.${name} - rewrite would cause infinite recursion; skipping`);
                        }
                        continue;
                    }
                }
                const re = new RegExp(`\\bskills\\.${name}\\s*\\(`, 'g');
                const before = code;
                code = code.replace(re, `${name}(`);
                if (code !== before) changes++;
            }
            for (const name of allNames) {
                if (name === skillFnName) continue;  // already handled above
                const re = new RegExp(`\\bworld\\.${name}\\s*\\(`, 'g');
                const before = code;
                code = code.replace(re, `${name}(`);
                if (code !== before) changes++;
            }
            // catch-all for ANY remaining patterns (unknown helpers)
            let before = code;
            code = code.replace(/\bskills\.(\w+)\s*\(/g, '$1(');
            if (code !== before) changes++;
            before = code;
            code = code.replace(/\bworld\.(\w+)\s*\(/g, '$1(');
            if (code !== before) changes++;
            // fix47: remove shadow patterns like "const log = skills.log" / "const foo = world.bar"
            before = code;
            code = code.replace(/\bconst\s+(\w+)\s*=\s*(?:skills|world)\.(\w+)\s*[;\n]/g, (match, localName, apiName) => {
                if (localName === apiName) return '';  // Remove redundant shadow
                return `const ${localName} = ${apiName};\n`;  // Keep alias but use bare name
            });
            if (code !== before) changes++;
            return { code, changes };
        };
        let migrated = 0, totalChanges = 0, candidateChanges = 0;
        for (const s of this.skills) {
            let skillChanged = false;
            // Extract function name from skill code
            const fnMatch = s.code?.match(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
            const skillFnName = fnMatch ? fnMatch[1] : null;
            // Rewrite s.code
            if (s.code) {
                const r = rewriteCode(s.code, skillFnName);
                if (r.changes > 0) {
                    s.code = r.code;
                    totalChanges += r.changes;
                    skillChanged = true;
                }
            }
            // fix41: also rewrite s.candidate.code (gate trials run candidate.code in SES)
            if (s.candidate?.code) {
                const candFnMatch = s.candidate.code.match(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
                const candFnName = candFnMatch ? candFnMatch[1] : null;
                const r = rewriteCode(s.candidate.code, candFnName);
                if (r.changes > 0) {
                    s.candidate.code = r.code;
                    candidateChanges += r.changes;
                    skillChanged = true;
                }
            }
            // fix50: also rewrite s.prev.code (rollback source for promoted skills)
            if (s.prev?.code) {
                const prevFnMatch = s.prev.code.match(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
                const prevFnName = prevFnMatch ? prevFnMatch[1] : null;
                const r = rewriteCode(s.prev.code, prevFnName);
                if (r.changes > 0) {
                    s.prev.code = r.code;
                    console.log(`[fix50] migrate ${s.name}.prev: ${r.changes} changes`);
                    skillChanged = true;
                }
            }
            // fix50: also rewrite s.handwritten_original.code (restoreHandwritten source)
            if (s.handwritten_original?.code) {
                const hoFnMatch = s.handwritten_original.code.match(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
                const hoFnName = hoFnMatch ? hoFnMatch[1] : null;
                const r = rewriteCode(s.handwritten_original.code, hoFnName);
                if (r.changes > 0) {
                    s.handwritten_original.code = r.code;
                    console.log(`[fix50] migrate ${s.name}.handwritten_original: ${r.changes} changes`);
                    skillChanged = true;
                }
            }
            // fix50: also rewrite variants[*].code (if any variant objects have code)
            if (Array.isArray(s.variants)) {
                for (let i = 0; i < s.variants.length; i++) {
                    const v = s.variants[i];
                    if (typeof v === 'object' && v?.code) {
                        const vFnMatch = v.code.match(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
                        const vFnName = vFnMatch ? vFnMatch[1] : null;
                        const r = rewriteCode(v.code, vFnName);
                        if (r.changes > 0) {
                            v.code = r.code;
                            console.log(`[fix50] migrate ${s.name}.variants[${i}]: ${r.changes} changes`);
                            skillChanged = true;
                        }
                    }
                }
            }
            // fix50: also rewrite repairHistory[*] code strings (code and fixSnippet fields)
            if (Array.isArray(s.repairHistory)) {
                for (let i = 0; i < s.repairHistory.length; i++) {
                    const rh = s.repairHistory[i];
                    if (rh?.code) {
                        const rhFnMatch = rh.code.match(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
                        const rhFnName = rhFnMatch ? rhFnMatch[1] : null;
                        const r = rewriteCode(rh.code, rhFnName);
                        if (r.changes > 0) {
                            rh.code = r.code;
                            console.log(`[fix50] migrate ${s.name}.repairHistory[${i}].code: ${r.changes} changes`);
                            skillChanged = true;
                        }
                    }
                    if (rh?.fixSnippet && LEFTOVER_RE.test(rh.fixSnippet)) {
                        const r = rewriteCode(rh.fixSnippet, null);
                        if (r.changes > 0) {
                            rh.fixSnippet = r.code;
                            console.log(`[fix50] migrate ${s.name}.repairHistory[${i}].fixSnippet: ${r.changes} changes`);
                            skillChanged = true;
                        }
                    }
                }
            }
            if (skillChanged) {
                console.log(`[fix41] migrate ${s.name}: code changes=${totalChanges > 0 ? 'yes' : 'no'}, candidate changes=${s.candidate ? 'yes' : 'n/a'}`);
                writeAtomic(`${this.dir}/${s.name}.js`, `// ${s.description}\n${s.code}\n`);
                migrated++;
            }
        }
        // fix50: post-migration scan - THROW if any prefixed patterns remain (fail loud, no soft paths)
        const leftovers = [];
        for (const s of this.skills) {
            for (const f of extractCodeFields(s)) {
                const matches = f.value.match(/\b(?:skills|world)\.[A-Za-z_]\w*/g);
                if (matches) leftovers.push(`${s.name}.${f.path}: ${matches.join(', ')}`);
            }
        }
        if (leftovers.length > 0) {
            throw new Error(`[fix50] LEFTOVER PREFIXED PATTERNS after migration (will fail at runtime):\n${leftovers.join('\n')}`);
        }
        // fix47: also migrate standalone .js files in the skills directory
        let fileMigrated = 0;
        try {
            const files = readdirSync(this.dir).filter(f => f.endsWith('.js'));
            for (const file of files) {
                const filePath = `${this.dir}/${file}`;
                let content = readFileSync(filePath, 'utf8');
                const fnMatch = content.match(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
                const fnName = fnMatch ? fnMatch[1] : file.replace('.js', '');
                const r = rewriteCode(content, fnName);
                if (r.changes > 0) {
                    writeFileSync(filePath, r.code);
                    fileMigrated++;
                    console.log(`[fix47] migrated standalone file ${file}: ${r.changes} changes`);
                }
            }
        } catch (e) {
            throw new Error(`[fix47] standalone file migration FAILED: ${e.message}`);
        }
        if (migrated > 0 || fileMigrated > 0) {
            this._saveSkills();
            console.log(`[fix41] MIGRATION COMPLETE: ${migrated} skills updated, ${totalChanges} code changes, ${candidateChanges} candidate changes, ${fileMigrated} files migrated`);
        }
        // fix42: pass needsReheal to _seedPrimitives
        if (needsReheal.size > 0) {
            this._needsReheal = needsReheal;
            console.log(`[fix42] ${needsReheal.size} skill(s) marked for seed reheal: ${[...needsReheal].join(', ')}`);
        }
        // fix41: only set flag when zero leftovers remain
        if (!hasLeftovers()) {
            this.progress.migratedToBarenames = true;
            this._saveProgress();
            console.log('[fix41] migratedToBarenames set to true - no leftovers remain');
        } else {
            console.warn('[fix41] WARNING: some skills.*/world.* patterns remain after migration');
        }
    }
    // fix50: static method to assert no prefixed calls in profile prompt sources (coding, coding_examples, conversation_examples)
    // THROWS if any prefixed pattern found - fail loud, no soft paths
    static assertNoPromptPrefixes(profile, repairMemory = null) {
        const PREFIX_RE = /\b(?:skills|world)\.\w+\s*\(/g;
        const violations = [];
        const check = (text, source) => {
            if (!text) return;
            const matches = text.match(PREFIX_RE);
            if (matches) violations.push({ source, matches: [...new Set(matches)] });
        };
        // Check coding prompt
        if (profile?.coding) check(profile.coding, 'profile.coding');
        // Check coding_examples
        if (Array.isArray(profile?.coding_examples)) {
            for (let i = 0; i < profile.coding_examples.length; i++) {
                const ex = profile.coding_examples[i];
                if (Array.isArray(ex)) {
                    for (let j = 0; j < ex.length; j++) {
                        if (ex[j]?.content) check(ex[j].content, `profile.coding_examples[${i}][${j}].content`);
                    }
                }
            }
        }
        // Check conversation_examples
        if (Array.isArray(profile?.conversation_examples)) {
            for (let i = 0; i < profile.conversation_examples.length; i++) {
                const ex = profile.conversation_examples[i];
                if (Array.isArray(ex)) {
                    for (let j = 0; j < ex.length; j++) {
                        if (ex[j]?.content) check(ex[j].content, `profile.conversation_examples[${i}][${j}].content`);
                    }
                }
            }
        }
        // Check repair memory (AWM lessons)
        if (repairMemory?.repairs) {
            for (let i = 0; i < repairMemory.repairs.length; i++) {
                const r = repairMemory.repairs[i];
                if (r?.fixSnippet) check(r.fixSnippet, `repairMemory.repairs[${i}].fixSnippet`);
            }
        }
        if (violations.length > 0) {
            const details = violations.map(v => `  ${v.source}: ${v.matches.join(', ')}`).join('\n');
            throw new Error(`[fix50] PREFIXED CALLS in prompt sources (will fail at runtime):\n${details}`);
        }
    }

    /**
     * Build the list of skill names to pass to instrumentSrc: all members of closureSet, ordered callee-before-caller
     * using acorn-extracted call edges (bare name or skills./world. prefix). Cycles fall back to lexicographic order.
     */
    static _tracedSkillNamesForInstrument(voyager, closureSet, over = {}) {
        if (!(closureSet instanceof Set)) throw new Error('[voyager] _tracedSkillNamesForInstrument: closureSet must be a Set');
        const nodes = [...closureSet].filter(n => typeof n === 'string');
        const builtIns = new Set();
        /** @type {Map<string, Set<string>>} */
        const edges = new Map();
        const inDeg = new Map();
        for (const name of nodes) {
            inDeg.set(name, 0);
            edges.set(name, new Set());
        }
        for (const name of nodes) {
            const entry = voyager.skills.find(s => s.name === name);
            const code = Object.prototype.hasOwnProperty.call(over, name) ? over[name] : entry?.code;
            if (typeof code !== 'string') continue;
            let ast;
            try {
                ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
            } catch (e) {
                throw new Error(`[voyager] _tracedSkillNamesForInstrument: parse failed for skill "${name}": ${e && e.message ? e.message : String(e)}`);
            }
            const walk = (node) => {
                if (!node || typeof node.type !== 'string') return;
                if (node.type === 'CallExpression') {
                    const c = node.callee;
                    let calleeName = null;
                    if (c?.type === 'Identifier') calleeName = c.name;
                    else if (c?.type === 'MemberExpression' && !c.computed && c.object?.type === 'Identifier' && (c.object.name === 'skills' || c.object.name === 'world') && c.property?.type === 'Identifier') {
                        calleeName = c.property.name;
                    }
                    // fix68: async built-in actions the closure calls are traced by name (goToPosition, goToGoal...); this
                    // used to happen only when saveSkill had put built-ins into a skill's deps, which _relink strips on restart
                    if (calleeName && !closureSet.has(calleeName) && Voyager._isAsyncBuiltIn(calleeName)) builtIns.add(calleeName);
                    if (calleeName && closureSet.has(calleeName) && calleeName !== name) {
                        const set = edges.get(name);
                        if (!set.has(calleeName)) {
                            set.add(calleeName);
                            inDeg.set(calleeName, (inDeg.get(calleeName) || 0) + 1);
                        }
                    }
                }
                for (const k in node) {
                    const v = node[k];
                    if (Array.isArray(v)) v.forEach(walk);
                    else if (v && typeof v.type === 'string') walk(v);
                }
            };
            walk(ast);
        }
        const ready = new Set(nodes.filter(n => (inDeg.get(n) || 0) === 0));
        const out = [];
        while (ready.size) {
            const n = [...ready].sort()[0];
            ready.delete(n);
            out.push(n);
            for (const d of edges.get(n) || []) {
                const prev = inDeg.get(d);
                if (prev === undefined) continue;
                const next = prev - 1;
                inDeg.set(d, next);
                if (next === 0) ready.add(d);
            }
        }
        if (out.length !== nodes.length) {
            console.warn('[voyager] _tracedSkillNamesForInstrument: cycle in call graph; using sorted closure order');
            return [...nodes.slice().sort(), ...[...builtIns].sort()];
        }
        return [...out, ...[...builtIns].sort()];
    }
    /** fix68: a built-in that acts (returns a promise) is traced; a sync built-in is a query (getInventoryCounts, blockAt
     *  lookups) and is not: the harness reads state with them, and tracing every query would fill the trace. Decided by
     *  the function itself, not a name list. */
    static _isAsyncBuiltIn(name) {
        const f = Object.prototype.hasOwnProperty.call(skills, name) ? skills[name] : Object.prototype.hasOwnProperty.call(world, name) ? world[name] : null;
        return typeof f === 'function' && f.constructor.name === 'AsyncFunction';
    }

    // fix33: seed primitives into the skill library so they are blamable/repairable (learned path, not hard-coded)
    // These are skills from skills.js that need to be in the skill graph to enable learning (e.g. water escape)
    // fix42: SEEDED_PRIMITIVES moved to static property so _migrateToBarenames can derive seeded names from it
    _seedPrimitives() {
        const SEEDED_PRIMITIVES = Voyager.SEEDED_PRIMITIVES;  // fix42: use static source of truth
        let seeded = 0, rehealed = 0;
        const forceReheal = this._needsReheal || new Set();
        for (const prim of SEEDED_PRIMITIVES) {
            const existing = this.skills.find(s => s.name === prim.name);
            if (existing) {
                // fix42: always reheal if:
                // - seeded:true but code differs (fix36 case)
                // - seeded is NOT set (e.g. primitive:true without seeded) and code differs
                // - marked for reheal by migration (self-call wrapper detection)
                // fix45: also reheal if prim has a seeded contract and it differs from existing.contract
                const contractDiffers = prim.contract && JSON.stringify(existing.contract) !== JSON.stringify(prim.contract);
                const needsReheal = forceReheal.has(prim.name) || existing.code !== prim.code || contractDiffers;
                if (needsReheal) {
                    const reason = forceReheal.has(prim.name) ? 'self-call wrapper' : contractDiffers ? 'contract updated' : existing.seeded ? 'code updated' : 'seeded flag missing';
                    console.log(`[psn] rehealing seeded primitive ${prim.name}: ${reason}`);
                    existing.code = prim.code;
                    existing.deps = prim.deps;
                    existing.description = prim.description;
                    existing.seeded = true;
                    existing.saved = new Date().toISOString();
                    // fix45: restore seeded contract if present (overwrites any learned contract that may have material-tier hard-codes)
                    if (prim.contract) {
                        existing.contract = { ...prim.contract, seeded: true };
                    }
                    writeAtomic(`${this.dir}/${prim.name}.js`, `// ${prim.description}\n${prim.code}\n`);
                    rehealed++;
                } else if (!existing.seeded) {
                    existing.seeded = true;
                    rehealed++;
                }
                continue;
            }
            const entry = {
                name: prim.name,
                description: prim.description,
                task: prim.task,
                code: prim.code,
                deps: prim.deps,
                seeded: true,
                stats: newStats(),
                effects: [],  // fix49: initialize effects
                consumes: {},  // fix49: initialize consumes
                saved: new Date().toISOString(),
            };
            // fix45: copy seeded contract if present
            if (prim.contract) {
                entry.contract = { ...prim.contract, seeded: true };
            }
            this.skills.push(entry);
            writeAtomic(`${this.dir}/${prim.name}.js`, `// ${prim.description}\n${prim.code}\n`);
            seeded++;
            console.log(`[psn] seeded primitive ${prim.name}: ${prim.description.slice(0, 60)}...`);
        }
        if (seeded || rehealed) this._saveSkills();
        if (rehealed) console.log(`[psn] rehealed ${rehealed} seeded primitive(s) with updated code`);
    }
    // fix82: a library source (incumbent or candidate) that is not exactly one top-level function of its own name is a hidden
    //        global (or a call that runs on staging) in every bundle that stages it; a library holding one fails loud at load.
    //        Entries saved before fix82 are reset by evidence (scripts/fix82_one_function_manifest.json), not here.
    _assertOneFunctionSources() {
        const bad = [];
        for (const s of this.skills) for (const [which, src] of [['code', s.code], ['candidate', s.candidate ? s.candidate.code : null]]) {
            if (src === null) continue;
            if (typeof src !== 'string') throw new Error(`[fix82] skill ${s.name}: ${which} is not a string`);
            const v = skillSourceViolations(src, s.name);
            if (v.length) bad.push(`${s.name}.${which}: ${v.join('; ')}`);
        }
        if (bad.length) throw new Error(`[fix82] FATAL: ${bad.length} library source(s) are not one top-level function (each is a hidden global of every bundle that stages it): ${bad.join(' | ')}`);
    }
    // fix11: recompute every skill's dependency edges from its code at startup (catches hand edits of skill files)
    // fix39: seeded primitives keep their original deps (typically []) so they can't form cycles
    // through learned skills. Basic actions like depositToChest/tossItem must not depend on learned
    // skills like ensureChest - that creates cycles and blocks inventory freeing.
    _relink() {
        const names = new Set(this.skills.map(s => s.name)); let n = 0;
        for (const s of this.skills) {
            // fix39: seeded primitives are basic building blocks - never recalculate their deps
            // This prevents cycles like ensureCraftingTable -> depositToChest -> ensureChest -> ensureCraftingTable
            if (s.seeded) continue;
            const d = depsOf(s.code, s.name, names);
            if (JSON.stringify([...d].sort()) !== JSON.stringify([...(s.deps || [])].sort())) { console.log(`[psn] relink ${s.name}: deps [${(s.deps || []).join(', ')}] -> [${d.join(', ')}]`); s.deps = d; n++; }
            if (!Array.isArray(s.deps)) s.deps = d;
        }
        // fix47/fix88: self-recursion and dependency cycles, the same installViolations the save gate uses. No skip.
        const failSelf = (self) => {
            if (self.length === 0) return;
            const msg = `[psn] SELF-RECURSION DETECTED in ${self.length} skill(s): ${self.join(', ')} - these will cause stack overflow at runtime`;
            console.error(msg);
            throw new Error(msg);
        };
        let found = this._libraryViolations();
        failSelf(found.self);
        if (found.cycles.length > 0) {
            // fix51: one-time data migration - demote promoted skills that create cycles back to prev/handwritten_original
            let demoted = 0;
            for (const cycle of found.cycles) {
                for (const skillName of cycle) {
                    const s = this.skills.find(x => x.name === skillName);
                    if (!s || s.seeded || s.primitive) continue;
                    // If this skill has a prev or handwritten_original, demote to it
                    if (s.prev || s.handwritten_original) {
                        const restore = s.handwritten_original || s.prev;
                        console.log(`[fix51] DEMOTING ${skillName} back to prev version (cycle: ${cycle.join(' -> ')})`);
                        s.code = restore.code;
                        s.description = restore.description;
                        s.deps = restore.deps;
                        delete s.candidate;
                        s.demoted = false;
                        demoted++;
                    }
                }
            }
            if (demoted > 0) {
                this._saveSkills();
                // Recalculate deps and re-check cycles after demoting
                for (const s of this.skills) {
                    if (s.seeded) continue;
                    const d = depsOf(s.code, s.name, names);
                    s.deps = d;
                }
                found = this._libraryViolations();
                failSelf(found.self);
                if (found.cycles.length === 0) {
                    console.log(`[fix51] demoted ${demoted} skill(s), cycles resolved`);
                } else {
                    const cycleStrs = found.cycles.map(c => c.join(' -> ')).join('; ');
                    const msg = `[psn] DEPENDENCY CYCLES PERSIST after demoting ${demoted} skill(s): ${cycleStrs}`;
                    console.error(msg);
                    throw new Error(msg);
                }
            } else {
                const cycleStrs = found.cycles.map(c => c.join(' -> ')).join('; ');
                const msg = `[psn] DEPENDENCY CYCLES DETECTED: ${cycleStrs}`;
                console.error(msg);
                throw new Error(msg);
            }
        }
        console.log(`[psn] relink: ${this.skills.length} skills, ${n} edge set(s) changed`);
        if (n) this._saveSkills();
    }
    // fix88: every stored skill as a candidate against the library. Self-calls and cycles come from installViolations.
    _libraryViolations() {
        const self = [];
        const cycles = [];
        const seen = new Set();
        // the same cycle is found once per member, starting at whichever node was visited first; rotate to one key
        const canon = (path) => {
            const nodes = path.slice(0, -1);
            if (nodes.length === 0) throw new Error('[fix88] cycle path is empty');
            let min = 0;
            for (let i = 1; i < nodes.length; i++) if (nodes[i] < nodes[min]) min = i;
            return [...nodes.slice(min), ...nodes.slice(0, min), nodes[min]];
        };
        for (const s of this.skills) {
            if (typeof s.code !== 'string') throw new Error(`[psn] relink: skill ${s.name} has no code`);
            if (!Array.isArray(s.deps)) throw new Error(`[psn] relink: skill ${s.name} has no deps array`);
            for (const v of installViolations({ name: s.name, code: s.code, deps: s.deps }, this.skills)) {
                if (v.kind === 'self') self.push(s.name);
                else if (v.kind === 'cycle') {
                    const key = canon(v.path).join(' -> ');
                    if (!seen.has(key)) { seen.add(key); cycles.push(canon(v.path)); }
                } else throw new Error(`[fix88] unknown violation kind ${JSON.stringify(v.kind)}`);
            }
        }
        return { self, cycles };
    }
    // PolySkill-style: a learned skill whose task is covered by a parameterised skill becomes a variant of it
    // (code kept on disk for rollback; hidden from the catalogue/fuzzy replay so the parameterised one is used)
    _polyMerge() {
        let n = 0;
        for (const s of this.skills) {
            if (s.primitive || s.handwritten || s.mergedInto || !s.task) continue;
            const r = this._findReplay(s.task);
            const tgt = r && this.skills.find(x => x.name === r.name);
            if (!tgt || tgt.name === s.name || !(tgt.handwritten || tgt.primitive)) continue;
            // only pure variants: a real item id, and no extra behaviour in the name (e.g. craftAndPlaceChestInHut stays its own skill)
            const g = countGoal(s.task);  // fix52: VERSION set at load, no catch-and-continue
            // fix49: fail loud if VERSION not set (no fallback) - countGoal already threw if null
            let valid = true; if (g) { const md = minecraftData(VERSION); valid = !!md.itemsByName[g.item] || !!md.blocksByName[g.item]; }
            const extra = s.name.split(/(?=[A-Z])/).map(w => w.toLowerCase()).filter(w => !['craft','mine','get','obtain','collect','gather','smelt','one','two','three','four','five','six','seven','eight'].includes(w) && !(g?.item || '').split('_').some(p => p.startsWith(w) || w.startsWith(p)));
            if (!valid || extra.length) continue;
            s.mergedInto = tgt.name; s.variantCall = r.call; n++;
            (tgt.variants ||= []).includes(s.name) || tgt.variants.push(s.name);
            gateLog(`MERGE variant ${s.name} ("${s.task.slice(0, 60)}") -> ${r.call.replace(/^await /, '')}`);
        }
        if (n) this._saveSkills();
    }
    // LILO/ASI-style: find code fragments (5 normalised lines) repeated across >=3 skills; offered to the code model as
    // candidates for a shared skill (which then goes through the normal saveSkill gate)
    _extractShared() {
        const norm = c => c.split('\n').map(l => l.replace(/\/\/.*$/, '').trim()).filter(l => l.length > 3 && !/^[{}()\];,]*$/.test(l));
        const seen = new Map();
        for (const s of this.skills) {
            if (s.mergedInto || s.demoted) continue;
            const L = norm(s.code || ''), local = new Set();
            for (let i = 0; i + 5 <= L.length; i++) local.add(L.slice(i, i + 5).join('\n'));
            for (const f of local) { if (!seen.has(f)) seen.set(f, new Set()); seen.get(f).add(s.name); }
        }
        const groups = new Map();   // collapse overlapping windows that share the same skill set
        for (const [f, set] of seen) if (set.size >= 3) { const k = [...set].sort().join(','); if (!groups.has(k)) groups.set(k, f); }
        this.sharedHints = [...groups.entries()].sort((a, b) => b[0].split(',').length - a[0].split(',').length).slice(0, 3)
            .map(([k, f]) => ({ skills: k.split(','), fragment: f }));
        for (const h of this.sharedHints) console.log(`[lilo] repeated fragment in ${h.skills.length} skills (${h.skills.join(', ')}): ${h.fragment.split('\n')[0].slice(0, 80)}`);
        if (!this.sharedHints.length) console.log('[lilo] no code fragment repeated across 3+ skills');
    }

    // fix20: repair / decompose queues persisted in progress.json (survive restarts)
    get _repairQueue() { return this.progress.repairQueue; }
    set _repairQueue(q) { this.progress.repairQueue = q; this._saveProgress(); }
    get _decomposeQueue() { return this.progress.decomposeQueue || null; }
    set _decomposeQueue(q) { this.progress.decomposeQueue = q; this._saveProgress(); }
    // fix20 (PSN maturity gating): V(s) = Laplace-smoothed success rate; P(update) = (1-eps)*sigmoid(gamma*(0.6-V)) + eps
    // fix32 (PSN): V = Beta(s+1, f+1) mean minus its std u (few runs -> high u -> low V -> more updates), steepness 5
    _maturity(e) { const s = e.stats || newStats(), n = s.success + s.fail, a = s.success + 1, b = s.fail + 1; const m = a / (a + b), u = Math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1))); const V = m - u; const p = (1 - 0.1) / (1 + Math.exp(-5 * (0.6 - V))) + 0.1; return { V, p, n, u }; }
    _updateAllowed(e, why) { const { V, p, n } = this._maturity(e), r = Math.random(), ok = r < p; gateLog(`maturity ${e.name}: V=${V.toFixed(2)} (u=${this._maturity(e).u.toFixed(2)}, ${n} runs) P(update)=${p.toFixed(2)} draw=${r.toFixed(2)} -> ${ok ? 'UPDATE ALLOWED' : 'FROZEN (mature skill kept)'} [${why}]`); return ok; }
    // fix20 (PSN repair memory): rolling buffer of the last 5 repair proposals per skill
    _pushRepair(e, p) {
        if (e.repairHistory === undefined) e.repairHistory = [];
        else if (!Array.isArray(e.repairHistory)) throw new Error(`[psn] ${e.name}.repairHistory is not an array`);
        e.repairHistory = [...e.repairHistory, { at: new Date().toISOString(), ...p }].slice(-5);
    }
    _noteProposal(e, p) { this._pushRepair(e, p); this._saveSkills(); }
    // fix47: simple hash for skill deduplication - changes when code or contract changes
    _skillHash(skill) {
        if (!skill) return 'null';
        const content = (skill.code || '') + '|' + (skill.contract?.text || '');
        // djb2 hash - simple and fast
        let hash = 5381;
        for (let i = 0; i < content.length; i++) {
            hash = ((hash << 5) + hash) ^ content.charCodeAt(i);
        }
        return (hash >>> 0).toString(36);
    }
    // fix47: repair dedup key (target, skill hash, evidence). The hash is in the key, so a changed skill is a new repair.
    _repairSig(target, evidence) {
        const skill = this.skills.find(s => s.name === target);
        const hash = this._skillHash(skill);
        return `${target}:${hash}:${(evidence || '').slice(0, 100).replace(/\s+/g, ' ')}`;
    }
    // fix87: a contract repair that already came back with the same pre/post for this evidence, and the skill hash has not changed
    _sameContractRepairRejected(e, evidence) {
        const sigs = this.progress.failedRepairSigs;
        if (sigs === undefined) return false;
        const sig = this._repairSig(e.name, evidence);
        if (!Object.hasOwn(sigs, sig)) return false;
        const rec = sigs[sig];
        if (!rec || typeof rec.hash !== 'string') throw new Error(`[fix87] rejected repair of ${e.name} (${sig}) has no hash`);
        return rec.hash === this._skillHash(e);
    }
    // fix47: log repair outcomes (ok/rejected/rollback) for observability
    _proposalOutcome(e, outcome, sig = null) { 
        const h = e.repairHistory; 
        if (h?.length && !h[h.length - 1].outcome) { h[h.length - 1].outcome = outcome; }
        console.log(`[repair-outcome] ${e.name}: ${outcome}`);
        // fix47: track failed signatures for hash-based deduplication (no time window)
        // Dedup until skill code/contract changes (hash is part of signature)
        if (outcome && /reject|fail|lint|duplicate|abort/i.test(outcome) && sig) {
            this.progress.failedRepairSigs ||= {};
            this.progress.failedRepairSigs[sig] = { at: Date.now(), hash: this._skillHash(e) };
            this._saveProgress();
        }
    }
    // ---------- fix22: learned skill contracts (PSN pre/postconditions) ----------
    // Each library skill carries { pre, post, text }: JS predicates over c = { args, ret, pre, post, delta } learned by the code model
    // from the skill's description, code and observed effects; evaluated after every traced call against real bot state.
    // fix43: added eq (equipment state) for idempotent equip contracts
    static CONTRACT_SPEC = `A contract is two JavaScript arrow functions over one argument c, each returning true when satisfied:
  c.args  = the call's arguments after bot (numbers/strings; objects are null)
  c.ret   = the call's return value (primitive, or null for objects)
  c.pre / c.post = bot state before / after the call: { pos:{x,y,z}, hp (0-${skills.VITALS_MAX.health}), food (0-${skills.VITALS_MAX.food}), sky (sky light 0-15 at head height; 0 = underground or enclosed), alive (bool), dim (dimension string), inv:{item:count}, free (empty inventory slots), eq:{heldItem,offHand,helmet,chestplate,leggings,boots} }
  pos is a plain {x,y,z}. It is not a Vec3 and has no methods. Distance is c.dist(a, b), never c.post.pos.dist(...).
  eq.heldItem is the item's name (a string) or null, the same shape as a skill that returns that name. It is not an item object and has no .type.
  c.delta = inventory change {item: +n/-n}
  c.dist(a, b) = euclidean distance between two {x,y,z}
  c.game.item(name) / c.game.block(name) = true when name is an item / a block in the game data; c.game.drops(block) = names of the items that block drops; c.game.harvestTools(block) = the tools that block drops with, or null when the game data lists none
NEVER enumerate item, block or kind names in a list (e.g. ['birch_log', 'spruce_log'].includes(c.args[1])): a hand-written list leaves out real values (oak_log) and every call with one of them is refused. Derive membership from c.game (game data) or from the observed state (c.pre / c.post).
A postcondition must not require a held or returned item that a named block's harvestTools omit. harvestTools(block) is null when the block drops by hand: requiring a tool for it is wrong.
A numeric literal is a count the code itself writes, or a game-data fact (an item's stack size, a recipe count, the armour slot group). It is never a count copied from a comment, a string, or the inventory at the time the skill was written. Comments and strings in the code are not numbers. Inventory counts change; read them from c.pre.inv.
pre: what must hold before the call for it to be able to succeed (use "c => true" if nothing). A precondition reads c.pre and c.args only. It must not read c.post: that is the state after the call.
post: what the call promises afterwards when it reports success (state the observable effect: arrived near target, item gained, still alive, not stranded underground, etc.). If the call returns false/null it already reported failure, so post may return true in that case. post must return a boolean; undefined is not a boolean.
IMPORTANT for equip skills: postconditions should check c.post.eq (equipment state) rather than c.delta for idempotency - already-equipped items should satisfy the postcondition without requiring an inventory change.
Use only c; no other globals.`;
    // fix26: endow contract compartment with bare API surface (same as live SES) so contracts that
    // reference getInventoryCounts, getAllFreeSpaces, etc. don't crash with "is not a function"
    // This is for robustness - contracts SHOULD only use c, but malformed contracts shouldn't silently fail
    _getContractEndowments() {
        if (this._contractEndowments) return this._contractEndowments;
        const endowments = {};
        // Add all world.* functions as bare names
        for (const [k, f] of Object.entries(world)) {
            if (typeof f === 'function') endowments[k] = f;
        }
        // Add all skills.* functions as bare names (except log which needs special handling)
        for (const [k, f] of Object.entries(skills)) {
            if (typeof f === 'function' && k !== 'log') endowments[k] = f;
        }
        this._contractEndowments = endowments;
        return endowments;
    }
    // fix83: game data for contracts (c.game), read from the live registry when a contract asks
    _contractGame() {
        const reg = () => this.agent.bot.registry;
        return {
            item: n => typeof n === 'string' && Object.hasOwn(reg().itemsByName, n),
            block: n => typeof n === 'string' && Object.hasOwn(reg().blocksByName, n),
            drops: n => {
                if (typeof n !== 'string' || !Object.hasOwn(reg().blocksByName, n)) return [];
                return reg().blocksByName[n].drops.map(d => reg().items[typeof d === 'number' ? d : d.drop.id].name);
            },
            // fix84: null when the block is unknown or the game data gives it no tool list (it drops by hand)
            harvestTools: n => {
                if (typeof n !== 'string' || !Object.hasOwn(reg().blocksByName, n)) return null;
                const ht = reg().blocksByName[n].harvestTools;
                if (!ht) return null;
                return Object.keys(ht).map(id => {
                    const it = reg().items[id];
                    if (!it) throw new Error(`[fix84] harvestTools id ${id} of ${n} is not an item`);
                    return it.name;
                });
            },
        };
    }
    _contractCtx(fields) { return { ...fields, dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), game: this._contractGame() }; }
    _compileContract(src) { const f = makeCompartment(this._getContractEndowments()).evaluate(`(${src})`); if (typeof f !== 'function') throw new Error('not a function'); return f; }
    // fix86: a learned contract is checked against the real snapshot shape (plain pos, string heldItem, c.dist).
    //        c.post.pos.dist and c.post.eq.heldItem.type are not on that shape, so they cannot be learned.
    _contractShapeProblem(src, counts) {
        const { root, param } = this._parseContract(src);
        if (param === null) return null;
        const pos = { x: 0, y: 64, z: 0 };
        const eq = { heldItem: 'iron_axe', offHand: null, helmet: null, chestplate: null, leggings: null, boots: null };
        const state = { pos, hp: skills.VITALS_MAX.health, food: skills.VITALS_MAX.food, oxygen: skills.VITALS_MAX.health, sky: 15, alive: true, dim: 'overworld', inv: {}, free: 0, eq };
        const args = counts && Array.isArray(counts.samples) ? counts.samples : [];
        const list = counts && counts.params && counts.params.length ? counts.params.join(', ') : 'none';
        const sample = { args, ret: true, pre: state, post: state, delta: {}, dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), game: { item: () => true, block: () => true, drops: () => [], harvestTools: () => null } };
        const problems = [];
        const unwrap = n => (n && n.type === 'ChainExpression' ? n.expression : n);
        const check = (node, calling) => {
            const path = this._contractPath(unwrap(node), param);
            if (!path || path.includes('*')) return;
            let cur = sample, map = false;
            for (let i = 0; i < path.length; i++) {
                const key = path[i], last = i === path.length - 1;
                if (map) {
                    if (!last || calling) problems.push(`c.${path.join('.')} is not on the contract state (a count is a number)`);
                    return;
                }
                if (Array.isArray(cur)) {
                    const idx = Number(key), numeric = String(idx) === key && Number.isInteger(idx);
                    if (key !== 'length' && !numeric) { problems.push(`c.${path.join('.')} is not on the contract state`); return; }
                    // No parameter list (the contract is checked on its own) is not arity 0. A learned skill's list is.
                    if (numeric && counts && idx >= counts.arity && !counts.rest) {
                        problems.push(`c.args[${idx}] is past arity ${counts.arity}; parameters after bot are (${list})`);
                        return;
                    }
                    if (!last || calling) { problems.push(`c.${path.join('.')} is not on the contract state (an argument is a primitive)`); return; }
                    return;
                }
                const missing = cur === null || cur === undefined || (typeof cur !== 'object' ? !(key in Object(cur)) : !Object.hasOwn(cur, key) && !(key in cur));
                if (missing) {
                    const where = path.slice(0, i).join('.');
                    const kind = cur === null ? 'null' : typeof cur;
                    problems.push(`c.${path.join('.')} is not on the contract state shape (${where ? `c.${where} is a ${kind}` : 'c'} has no ${key})`);
                    return;
                }
                const next = cur[key];
                if (last) {
                    if (calling && typeof next !== 'function') problems.push(`c.${path.join('.')} is not a function on the contract state shape`);
                    return;
                }
                map = key === 'inv' || key === 'delta';
                cur = next;
            }
        };
        this._walkAst(root.body, node => {
            if (node.type === 'CallExpression') { const callee = unwrap(node.callee); if (callee.type === 'MemberExpression') check(callee, true); }
            else if (node.type === 'MemberExpression') check(node, false);
        });
        return [...new Set(problems)].join('; ') || null;
    }
    // fix86: string returns in the skill body, used as probes when no traced run has been recorded yet
    static returnedLiterals(code) {
        let ast;
        try { ast = acorn.parse(code, { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); }
        catch (e) { throw new Error(`[fix86] cannot parse skill code for return values: ${e.message}`); }
        const out = [];
        const walk = node => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'ReturnStatement' && node.argument && node.argument.type === 'Literal' && typeof node.argument.value === 'string') out.push(node.argument.value);
            for (const v of Object.values(node)) {
                if (Array.isArray(v)) { for (const x of v) walk(x); }
                else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
            }
        };
        walk(ast);
        return out;
    }
    _returnProbes(skill) {
        if (!skill) return [];
        if (Array.isArray(skill.observedRuns) && skill.observedRuns.length) return skill.observedRuns;
        if (typeof skill.code !== 'string') return [];
        return Voyager.returnedLiterals(skill.code).map(rv => ({ rv, heldItem: rv }));
    }
    _validContract(ct, skill) {
        if (!ct || typeof ct.post !== 'string' || typeof ct.pre !== 'string') return 'missing pre/post string';
        // fix43: include eq (equipment state) in test state for contract validation
        const eq = { heldItem: null, offHand: null, helmet: null, chestplate: null, leggings: null, boots: null };
        const s = { pos: { x: 0, y: 64, z: 0 }, hp: skills.VITALS_MAX.health, food: skills.VITALS_MAX.food, sky: 15, alive: true, dim: 'overworld', inv: {}, free: 0, eq };   // fix59: max from VITALS_MAX
        // fix83: an enumerated list of names is not a contract (live collectLogs, learned by the free fallback model 2026-11-05
        //        18:59:15 GMT: ['birch_log', ..., 'warped_stem'].includes(c.args[1]) refused collectLogs(2, 'oak_log') x36)
        for (const k of ['pre', 'post']) { const lists = Voyager.contractNameLists(ct[k]); if (lists.length) return `${k} enumerates names ${lists.join(', ')}; derive membership from c.game (game data) or the observed state, never a list`; }
        // fix84: a single name is not a list, so fix83 accepts `heldItem === 'iron_shovel'` for iron_ore. harvestTools does not.
        //        The game data is the version's (the same source countGoal uses); a contract is checked before a bot exists.
        const reg = minecraftData(VERSION);
        if (!reg || !reg.blocksByName || !reg.items) throw new Error(`[fix84] _validContract: no game data for version ${JSON.stringify(VERSION)}`);
        const tools = Voyager.contractToolMismatches([ct.pre, ct.post], reg);
        if (tools !== null) return tools;
        const postRead = Voyager.contractPreReadsPost(ct.pre);
        if (postRead !== null) return `pre reads c.${postRead} (state after the call); a precondition may read c.pre and c.args only`;
        const counts = skill && typeof skill.code === 'string' ? Voyager.skillArgCounts(skill) : null;
        if (skill && typeof skill.code === 'string' && !counts) return `${skill.name} has no function; c.args has no parameter list`;
        for (const k of ['pre', 'post']) {
            if (counts) {
                const args = Voyager.contractArgProblems(ct[k], skill);
                if (args.length) return `${k}: ${args.map(p => p.text).join('; ')}`;
                for (const i of Voyager.contractArgIndexes(ct[k])) {
                    if (!Number.isInteger(i) || i < 0) continue;
                    if (i >= counts.arity) continue;
                    if (counts.known[i]) continue;
                    return `${k}: parameter ${counts.names[i]} has no sample for c.args[${i}] (${counts.params[i]}). It has no literal default and the body does not compare it to a literal.`;
                }
            }
            const shape = this._contractShapeProblem(ct[k], counts);
            if (shape) return `${k}: ${shape}`;
        }
        const c = this._contractCtx({ args: counts ? counts.samples : [], ret: true, pre: s, post: s, delta: {} });
        try { for (const k of ['pre', 'post']) { const r = this._compileContract(ct[k])(c); if (typeof r !== 'boolean') return `${k} returned ${r === undefined ? 'undefined' : JSON.stringify(r)} (${typeof r}), not a boolean`; } } catch (e) { return `throws: ${e.message}`; }
        // fix86: an equip post is checked against the skill's traced successful returns (or a string it returns).
        //        heldItem is that string, not an item with .type. Posts that also read delta/inv are about the inventory, not this probe.
        const fields = this._extractPostFields(ct.post);
        if (skill && typeof skill.code === 'string') {
            const copied = Voyager.copiedInventoryHits({ ...skill, contract: ct }, reg);
            for (const k of ['pre', 'post']) {
                const hit = copied.filter(h => h.where === k);
                if (hit.length) return `${k} uses ${hit.map(h => h.n).join(', ')}, which compares the inventory count of ${hit.map(h => h.item).join(', ')} to a literal that is not its goal quantity and not game data`;
            }
        }
        const probes = fields.eq.includes('heldItem') && !fields.delta.length && !fields.inv.length ? this._returnProbes(skill) : [];
        for (const p of probes) {
            if (!p || !Object.hasOwn(p, 'rv') || !Object.hasOwn(p, 'heldItem')) throw new Error(`[fix86] return probe for ${skill.name} is missing rv or heldItem`);
            const post = { ...s, eq: { ...eq, heldItem: p.heldItem } };
            const ctx = this._contractCtx({ args: counts ? counts.samples : [], ret: p.rv, pre: s, post, delta: {} });
            let r;
            try { r = this._compileContract(ct.post)(ctx); }
            catch (e) { return `post throws on the skill's return ${JSON.stringify(p.rv)}: ${e.message}`; }
            if (r !== true) return `post is ${r === undefined ? 'undefined' : JSON.stringify(r)} for the skill's return ${JSON.stringify(p.rv)}; heldItem is ${JSON.stringify(p.heldItem)} (the item name, a string, the same shape as that return)`;
        }
        return null;
    }
    // fix83: what a violated contract was given, for the model's feedback: the call with its real arguments (NaN, not JSON's
    //        null) and every argument that is a number but not a finite one (arithmetic on a missing value, e.g. an item count the
    //        inventory does not list). Facts only; the code is not rewritten.
    static contractCallFacts(name, argv, k, src) {
        const txt = argv.map(x => typeof x === 'number' || x === undefined ? String(x) : JSON.stringify(x)).join(', ');
        const bad = argv.map((x, i) => [x, i]).filter(([x]) => typeof x === 'number' && !Number.isFinite(x)).map(([x, i]) => `argument ${i + 1} is ${x} (a number computed from a missing value: check what it was computed from)`);
        return `${name}(${txt}) does not satisfy its ${k}condition ${src}${bad.length ? `; ${bad.join('; ')}` : ''}`;
    }
    // fix83: the string-literal arrays (2+ names) in a contract source: an enumerated allowlist, e.g. ['birch_log', 'spruce_log']
    static contractNameLists(src) {
        const ast = acorn.parse(`(${String(src)})`, { ecmaVersion: 'latest' }), out = [];
        const walk = n => {
            if (!n || typeof n.type !== 'string') return;
            if (n.type === 'ArrayExpression' && n.elements.length >= 2 && n.elements.every(e => e !== null && e.type === 'Literal' && typeof e.value === 'string')) out.push(`[${n.elements.map(e => `'${e.value}'`).join(', ')}]`);
            for (const v of Object.values(n)) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v); }
        };
        walk(ast);
        return out;
    }
    // A skill is a module, including top-level await, the same parse coder.js uses. A contract is the parenthesized
    // expression _compileContract evaluates. One mode each. Comments are not nodes. A string's value is not a number.
    static parseSkill(src) {
        const text = String(src);
        try { return acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); }
        catch (e) { throw new Error(`[fix97] skill does not parse as a module: ${e instanceof Error ? e.message : String(e)}`); }
    }
    static parseContract(src) {
        const text = String(src);
        try { return acorn.parse(`(${text})`, { ecmaVersion: 'latest' }); }
        catch (e) { throw new Error(`[fix97] contract does not parse: ${e instanceof Error ? e.message : String(e)}`); }
    }
    static walkAst(ast, visit) {
        const walk = n => {
            if (!n || typeof n.type !== 'string') return;
            visit(n);
            for (const v of Object.values(n)) {
                if (Array.isArray(v)) { for (const x of v) walk(x); }
                else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
            }
        };
        walk(ast);
    }
    static numericLiterals(ast) {
        const out = [];
        Voyager.walkAst(ast, n => { if (n.type === 'Literal' && typeof n.value === 'number') out.push(n.value); });
        return out;
    }
    // camelCase words, plus adjacent pairs joined with '_', so ensureStorageChestNearby yields chest and equipIronAxe yields iron_axe.
    static nameTokens(identifier) {
        const parts = String(identifier).split(/(?=[A-Z])/).map(w => w.toLowerCase()).filter(w => /^[a-z0-9_]+$/.test(w));
        const out = parts.slice();
        for (let i = 0; i + 1 < parts.length; i++) out.push(`${parts[i]}_${parts[i + 1]}`);
        return out;
    }
    static namesInAst(ast) {
        const names = [];
        Voyager.walkAst(ast, n => {
            if (n.type === 'Literal' && typeof n.value === 'string') names.push(n.value);
            if (n.type === 'TemplateElement' && n.value && typeof n.value.cooked === 'string' && /^[a-z0-9_]+$/.test(n.value.cooked.trim())) names.push(n.value.cooked.trim());
            if (n.type === 'MemberExpression' && !n.computed && n.property && n.property.type === 'Identifier') names.push(n.property.name);
        });
        return names;
    }
    static functionIds(ast) {
        const ids = [];
        Voyager.walkAst(ast, n => {
            if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && n.id && n.id.type === 'Identifier') ids.push(n.id.name);
        });
        return ids;
    }
    // Counts the prompt showed when the skill was generated. A later consumeEvidence measurement is not that snapshot.
    static observedCountEntries(skill) {
        const out = [];
        if (Object.hasOwn(skill, 'promptCounts')) {
            const counts = skill.promptCounts;
            if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) throw new Error(`[fix97] ${skill.name}.promptCounts must be an item-to-count object`);
            for (const [item, n] of Object.entries(counts)) {
                if (typeof n !== 'number') throw new Error(`[fix97] ${skill.name}.promptCounts.${item} is not a number`);
                out.push({ item, n, source: 'promptCounts' });
            }
        }
        return out;
    }
    // The task's own target, from the same parsers the curriculum and the goal resolver use.
    // "Craft 4 birch_planks" and "collectSurface: Collect 32 dirt" name a quantity to produce.
    // The kind label is that parser's grammar (goalSentence), not a scan of the surrounding prose.
    static goalQuantities(task) {
        if (typeof task !== 'string' || task.length === 0) return [];
        const out = [];
        const g = countGoal(task);
        if (g) for (const item of g.items) out.push({ item, n: g.count });
        const sm = smeltGoal(task);
        if (sm) {
            out.push({ item: sm.input, n: sm.count });
            out.push({ item: sm.item, n: sm.outputCount });
        }
        const placed = ensureGoal(task);
        if (placed) out.push({ item: placed.item, n: placed.count });
        const reached = reachGoal(task);
        if (reached) out.push({ item: reached.item, n: reached.count });
        return out;
    }
    // 0 and 1 are absent and one. A stack size, a recipe result, or a recipe's use of the item is game data for that count.
    static countIsGameFact(registry, item, n) {
        if (n === 0 || n === 1) return true;
        return Voyager.itemFacts(registry, item).some(f => f.n === n && (f.kind === 'stack' || f.kind === 'recipeResult' || f.kind === 'ingredient'));
    }
    // A comparison of an inventory count of item X to a numeric literal. The count is c.pre.inv.X, c.post.inv.X, c.delta.X,
    // or a getInventoryCounts binding. A computed member's index (c.args[2]) is not a side of the comparison.
    static contractInventoryComparisons(src) {
        const ast = Voyager.parseContract(src);
        const root = ast.body[0].expression;
        const param = root.params && root.params.length && root.params[0].type === 'Identifier' ? root.params[0].name : null;
        const COMPARE = new Set(['<', '<=', '>', '>=', '==', '===', '!=', '!==']);
        const hits = [];
        const literalOf = (node) => {
            if (!node) return null;
            if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
            if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value;
            return null;
        };
        const itemOf = (node) => {
            const path = Voyager.memberPath(node, param);
            if (!path) return null;
            if (path.length === 3 && (path[0] === 'pre' || path[0] === 'post') && path[1] === 'inv' && path[2] !== '*') return path[2];
            if (path.length === 2 && path[0] === 'delta' && path[1] !== '*') return path[1];
            return null;
        };
        const walk = (n) => {
            if (!n || typeof n.type !== 'string') return;
            if (n.type === 'BinaryExpression' && COMPARE.has(n.operator)) {
                const ln = literalOf(n.left), rn = literalOf(n.right);
                if (ln !== null) { const item = itemOf(n.right); if (item) hits.push({ n: ln, item, op: n.operator }); }
                if (rn !== null) { const item = itemOf(n.left); if (item) hits.push({ n: rn, item, op: n.operator }); }
            }
            for (const v of Object.values(n)) {
                if (Array.isArray(v)) { for (const x of v) walk(x); }
                else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
            }
        };
        walk(root);
        return hits;
    }
    // A comparison whose literal equals the observed count of an item, and whose other side is that item's inventory count.
    // Comments and strings are not literals. `const need = 55; counts.oak_log >= need` and `const n = counts.oak_log; n >= 55`
    // are the same comparison: the binding is resolved in its scope before the two sides are compared.
    static copiedCountComparisons(code, entries, registry, facts) {
        if (!registry || !registry.itemsByName) throw new Error('[fix97] copied-count check needs the game data registry');
        if (entries !== null && !Array.isArray(entries)) throw new Error('[fix97] copied-count check needs the observed counts');
        const ast = Voyager.parseSkill(code);
        const COMPARE = new Set(['<', '<=', '>', '>=', '==', '===', '!=', '!==']);
        const hits = [];
        const keeps = new Set();
        const slotNs = new Set();
        const invPairs = new Set();
        const realItem = (item) => Object.hasOwn(registry.itemsByName, item);
        const scopes = [];
        const functionScopes = [];
        const push = () => { scopes.push(new Map()); };
        const lookup = (name) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); return null; };
        const bind = (name, value, kind) => {
            const target = kind === 'var' ? functionScopes[functionScopes.length - 1] : scopes[scopes.length - 1];
            target.set(name, value);
        };
        const empty = () => ({ n: null, items: new Set(), invMap: false, invItem: null });
        const copy = (b) => ({ n: b.n, items: new Set(b.items), invMap: b.invMap === true, invItem: b.invItem || null });
        const inventoryCall = (node) => {
            if (!node || node.type !== 'CallExpression') return false;
            const c = node.callee;
            if (c.type === 'Identifier' && c.name === 'getInventoryCounts') return true;
            if (c.type === 'MemberExpression' && !c.computed && c.property && c.property.type === 'Identifier' && c.property.name === 'getInventoryCounts') return true;
            return false;
        };
        const propName = (node) => {
            if (!node.computed && node.property.type === 'Identifier') return node.property.name;
            if (node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
            return null;
        };
        const resolve = (node) => {
            if (!node) return empty();
            if (node.type === 'Literal' && typeof node.value === 'number') return { n: node.value, items: new Set(), invMap: false, invItem: null };
            if (node.type === 'Identifier') {
                const b = lookup(node.name);
                if (b) return copy(b);
                return empty();
            }
            if (node.type === 'ChainExpression') return resolve(node.expression);
            if (node.type === 'CallExpression' && inventoryCall(node)) return { n: null, items: new Set(), invMap: true, invItem: null };
            if (node.type === 'MemberExpression') {
                const obj = resolve(node.object);
                const prop = propName(node);
                if (obj.invMap && prop) return { n: null, items: new Set([prop]), invMap: false, invItem: prop };
                return { n: null, items: new Set(Voyager.namesInAst(node)), invMap: false, invItem: null };
            }
            if (node.type === 'CallExpression') return { n: null, items: new Set(Voyager.namesInAst(node)), invMap: false, invItem: null };
            return { n: null, items: new Set(Voyager.namesInAst(node)), invMap: false, invItem: null };
        };
        // `(count || 0) - N` is the amount discarded. N is how many to keep. The `|| 0` is not part of a comparison.
        const keptCount = (node) => {
            if (!node || node.type !== 'LogicalExpression' || (node.operator !== '||' && node.operator !== '??')) return null;
            if (!node.right || node.right.type !== 'Literal' || node.right.value !== 0) return null;
            return resolve(node.left);
        };
        const consider = (expr) => {
            if (!expr || expr.type !== 'BinaryExpression') return;
            const L = resolve(expr.left), R = resolve(expr.right);
            const kept = expr.operator === '-' ? (L.invItem ? L : keptCount(expr.left)) : null;
            if (kept && kept.invItem && typeof R.n === 'number' && realItem(kept.invItem)) keeps.add(`${kept.invItem}\0${R.n}`);
            if (!COMPARE.has(expr.operator)) return;
            if (L.invItem && typeof R.n === 'number' && realItem(L.invItem)) invPairs.add(`${L.invItem}\0${R.n}`);
            else if (typeof R.n === 'number' && !L.invItem) slotNs.add(R.n);
            if (R.invItem && typeof L.n === 'number' && realItem(R.invItem)) invPairs.add(`${R.invItem}\0${L.n}`);
            else if (typeof L.n === 'number' && !R.invItem) slotNs.add(L.n);
            const pairs = [];
            if (L.invItem && typeof R.n === 'number') pairs.push([L.invItem, R.n]);
            if (R.invItem && typeof L.n === 'number') pairs.push([R.invItem, L.n]);
            for (const [item, n] of pairs) {
                if (!realItem(item)) continue;
                if (Voyager.countIsGameFact(registry, item, n)) continue;
                if (entries === null) {
                    hits.push({ n, item, source: 'inventory', quote: null, op: expr.operator });
                    continue;
                }
                for (const e of entries) {
                    if (e.n !== n || e.item !== item) continue;
                    hits.push({ n, item, source: e.source, quote: e.quote || null, op: expr.operator });
                }
            }
        };
        const walk = (n) => {
            if (!n || typeof n.type !== 'string') return;
            if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
                push();
                functionScopes.push(scopes[scopes.length - 1]);
                for (const p of n.params || []) {
                    if (p.type === 'AssignmentPattern') {
                        walk(p.right);
                        if (p.left.type === 'Identifier') bind(p.left.name, resolve(p.right), 'let');
                    } else if (p.type === 'Identifier') bind(p.name, empty(), 'let');
                }
                walk(n.body);
                functionScopes.pop();
                scopes.pop();
                return;
            }
            if (n.type === 'BlockStatement') {
                push();
                for (const s of n.body) walk(s);
                scopes.pop();
                return;
            }
            if (n.type === 'VariableDeclaration') {
                for (const d of n.declarations) {
                    if (d.init) walk(d.init);
                    if (d.id && d.id.type === 'Identifier') bind(d.id.name, resolve(d.init), n.kind);
                }
                return;
            }
            if (n.type === 'AssignmentExpression') {
                walk(n.right);
                if (n.left.type === 'Identifier') {
                    const existing = lookup(n.left.name);
                    if (existing) {
                        const value = resolve(n.right);
                        existing.n = value.n;
                        existing.items = value.items;
                        existing.invMap = value.invMap;
                        existing.invItem = value.invItem;
                    }
                }
                return;
            }
            consider(n);
            for (const v of Object.values(n)) {
                if (Array.isArray(v)) { for (const x of v) walk(x); }
                else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
            }
        };
        push();
        functionScopes.push(scopes[0]);
        walk(ast);
        if (facts && typeof facts === 'object') {
            facts.keeps = keeps;
            facts.slotNs = slotNs;
            facts.invPairs = invPairs;
        }
        return hits;
    }
    // An inventory comparison of item X to a literal is a copied count when that literal is not X's goal
    // quantity (countGoal / smeltGoal / ensureGoal / reachGoal, including a leading kind: label), not a
    // minecraft-data stack or recipe count for X, and not 0 or 1. The task prose is not a source of counts.
    // Structured name:count state is what snapshotThresholdFeedback pairs, from promptCounts, not from a sentence.
    static copiedInventoryHits(skill, registry) {
        if (!skill || typeof skill.name !== 'string') throw new Error('[fix97] copied-count check needs the skill name');
        if (!registry || !registry.itemsByName) throw new Error('[fix97] copied-count check needs the game data registry');
        const goals = Voyager.goalQuantities(skill.task);
        const isGoal = (item, n) => goals.some(g => g.item === item && g.n === n);
        const facts = {};
        const pairKey = (item, n) => `${item}\0${n}`;
        const isItem = (item) => Object.hasOwn(registry.itemsByName, item);
        const hits = [];
        // A keep is `count - N` passed to a discard: N is how many of that item to leave, not a count that was observed.
        // A contract ceiling (`<` / `<=`) is the same kind of cap when the code compares N to something that is not
        // that item's inventory count, and never compares the item itself to N. A call argument is not that comparison.
        const take = (h, where) => {
            if (!isItem(h.item)) return;
            if (isGoal(h.item, h.n)) return;
            if (Voyager.countIsGameFact(registry, h.item, h.n)) return;
            if (facts.keeps && facts.keeps.has(pairKey(h.item, h.n))) return;
            if (where !== 'code' && (h.op === '<' || h.op === '<=') && facts.slotNs && facts.slotNs.has(h.n) && !(facts.invPairs && facts.invPairs.has(pairKey(h.item, h.n)))) return;
            hits.push({ n: h.n, item: h.item, op: h.op, where, source: 'inventory' });
        };
        if (typeof skill.code === 'string') {
            for (const h of Voyager.copiedCountComparisons(skill.code, null, registry, facts)) take(h, 'code');
        }
        if (skill.contract && typeof skill.contract === 'object') {
            for (const field of ['pre', 'post']) {
                const src = skill.contract[field];
                if (typeof src !== 'string') continue;
                for (const h of Voyager.contractInventoryComparisons(src)) take(h, field);
            }
        }
        return hits;
    }
    static snapshotThresholdFeedback(code, counts) {
        if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('[fix97] snapshot check needs the prompt inventory counts');
        const registry = minecraftData(VERSION);
        if (!registry || !registry.itemsByName) throw new Error(`[fix97] snapshot check needs game data for ${VERSION}`);
        const entries = Object.entries(counts).map(([item, n]) => {
            if (typeof n !== 'number') throw new Error(`[fix97] prompt count of ${item} is not a number`);
            return { item, n, source: 'promptCounts' };
        });
        return Voyager.copiedCountComparisons(code, entries, registry).map(h => `\`${h.item} ${h.op} ${h.n}\` copies ${h.item}'s count from the state in this prompt. That count is what is held right now. Read it with getInventoryCounts(bot) when the function runs.`);
    }
    // c.args is the call's arguments after bot. required is how many of those have no default. arity is all of them
    // when the function has no rest parameter. A sample is a literal default or a literal the body compares the
    // parameter to. A missing sample is not filled in.
    static skillArgCounts(skill) {
        if (!skill || typeof skill.code !== 'string' || typeof skill.name !== 'string') throw new Error('[fix97] skillArgCounts needs the skill name and code');
        const ast = Voyager.parseSkill(skill.code);
        let fn = null;
        Voyager.walkAst(ast, n => {
            if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && n.id && n.id.name === skill.name) fn = n;
        });
        if (!fn) return null;
        const params = fn.params.slice(1);
        let rest = false, required = 0, arity = 0;
        const listed = [];
        const names = [];
        const samples = [];
        const known = [];
        for (const p of params) {
            if (p.type === 'RestElement') {
                rest = true;
                listed.push(skill.code.slice(p.start, p.end));
                break;
            }
            arity += 1;
            listed.push(skill.code.slice(p.start, p.end));
            const sample = Voyager.parameterSample(fn, p);
            names.push(sample.name);
            known.push(sample.found);
            samples.push(sample.found ? sample.value : undefined);
            if (p.type !== 'AssignmentPattern') required += 1;
        }
        return { required, arity, rest, params: listed, names, samples, known };
    }
    static literalOf(node) {
        if (!node) return null;
        if (node.type === 'Literal') return { value: node.value };
        if (node.type === 'UnaryExpression' && (node.operator === '+' || node.operator === '-') && node.argument && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
            return { value: node.operator === '-' ? -node.argument.value : node.argument.value };
        }
        if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
            return { value: node.quasis[0].value.cooked };
        }
        return null;
    }
    static parameterSample(fn, param) {
        const nameNode = param.type === 'AssignmentPattern' ? param.left : param;
        if (!nameNode || nameNode.type !== 'Identifier') return { found: false, name: '?' };
        const name = nameNode.name;
        if (param.type === 'AssignmentPattern') {
            const lit = Voyager.literalOf(param.right);
            if (lit) return { found: true, name, value: lit.value };
        }
        const binds = (p) => {
            if (!p) return false;
            if (p.type === 'RestElement') return binds(p.argument);
            if (p.type === 'AssignmentPattern') return binds(p.left);
            return p.type === 'Identifier' && p.name === name;
        };
        const COMPARE = new Set(['===', '==', '!==', '!=', '<', '<=', '>', '>=']);
        let found = null;
        const walk = (node) => {
            if (!node || typeof node.type !== 'string' || found) return;
            if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
                if ((node.params || []).some(binds)) return;
            }
            if (node.type === 'BinaryExpression' && COMPARE.has(node.operator)) {
                let lit = null;
                if (node.left.type === 'Identifier' && node.left.name === name) lit = Voyager.literalOf(node.right);
                else if (node.right.type === 'Identifier' && node.right.name === name) lit = Voyager.literalOf(node.left);
                if (lit) { found = lit; return; }
            }
            for (const v of Object.values(node)) {
                if (Array.isArray(v)) { for (const x of v) walk(x); }
                else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
            }
        };
        walk(fn.body);
        return found ? { found: true, name, value: found.value } : { found: false, name };
    }
    static contractArgIndexes(src) {
        const ast = Voyager.parseContract(src);
        const root = ast.body[0].expression;
        const param = root.params && root.params.length && root.params[0].type === 'Identifier' ? root.params[0].name : null;
        const indexes = [];
        if (!param) return indexes;
        const walk = (n) => {
            if (!n || typeof n.type !== 'string') return;
            if (n.type === 'MemberExpression' && n.computed && n.property && n.property.type === 'Literal' && typeof n.property.value === 'number') {
                const path = Voyager.memberPath(n.object, param);
                if (path && path.length === 1 && path[0] === 'args' && Number.isInteger(n.property.value)) indexes.push(n.property.value);
            }
            for (const v of Object.values(n)) {
                if (Array.isArray(v)) { for (const x of v) walk(x); }
                else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
            }
        };
        walk(root);
        return indexes;
    }
    // A c.args.length literal is legal from the required count through the arity, and at or above the required
    // count when the function has a rest parameter.
    static argsLengthAllowed(counts, n) {
        if (!counts || typeof n !== 'number') return false;
        if (counts.rest) return n >= counts.required;
        return n >= counts.required && n <= counts.arity;
    }
    // c.args is the arguments after bot. An index at or past arity cannot hold unless the function has a rest
    // parameter. c.args.length may be any count from the required count through the arity.
    static contractArgProblems(src, skill) {
        const counts = Voyager.skillArgCounts(skill);
        if (!counts) throw new Error(`[fix97] ${skill.name} has no function; c.args has no parameter list`);
        const ast = Voyager.parseContract(src);
        const root = ast.body[0].expression;
        const param = root.params && root.params.length && root.params[0].type === 'Identifier' ? root.params[0].name : null;
        if (!param) return [];
        const COMPARE = new Set(['<', '<=', '>', '>=', '==', '===', '!=', '!==']);
        const list = counts.params.length ? counts.params.join(', ') : 'none';
        const problems = [];
        const seen = new Set();
        const push = (id, problem) => { if (seen.has(id)) return; seen.add(id); problems.push(problem); };
        const walk = (n) => {
            if (!n || typeof n.type !== 'string') return;
            if (n.type === 'MemberExpression' && n.computed && n.property && n.property.type === 'Literal' && typeof n.property.value === 'number') {
                const path = Voyager.memberPath(n.object, param);
                if (path && path.length === 1 && path[0] === 'args') {
                    const i = n.property.value;
                    if (!Number.isInteger(i) || i < 0 || (!counts.rest && i >= counts.arity)) {
                        push(`index:${i}`, { kind: 'index', index: i, text: `${skill.name} parameters after bot are (${list}); c.args[${i}] is past arity ${counts.arity}` });
                    }
                }
            }
            if (n.type === 'BinaryExpression' && COMPARE.has(n.operator)) {
                const lengthSide = (node) => {
                    const path = Voyager.memberPath(node, param);
                    return path && path.length === 2 && path[0] === 'args' && path[1] === 'length';
                };
                if (lengthSide(n.left) || lengthSide(n.right)) {
                    const other = lengthSide(n.left) ? n.right : n.left;
                    const nLit = other && other.type === 'Literal' && typeof other.value === 'number' ? other.value : null;
                    if (!Voyager.argsLengthAllowed(counts, nLit)) {
                        const shown = nLit === null ? 'a non-literal' : String(nLit);
                        const range = counts.rest
                            ? `a count from the required count ${counts.required} up`
                            : `a count from the required count ${counts.required} through the arity ${counts.arity}`;
                        push(`length:${shown}`, { kind: 'length', n: nLit, text: `${skill.name} parameters after bot are (${list}); c.args.length compared to ${shown}, not ${range}` });
                    }
                }
            }
            for (const v of Object.values(n)) {
                if (Array.isArray(v)) { for (const x of v) walk(x); }
                else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
            }
        };
        walk(root);
        return problems;
    }
    static memberPath(node, param) {
        if (!node || !param) return null;
        const unwrap = n => (n && n.type === 'ChainExpression' ? n.expression : n);
        const keys = [];
        let n = unwrap(node);
        while (n && n.type === 'MemberExpression') {
            if (!n.computed) keys.unshift(n.property.name);
            else if (n.property.type === 'Literal') keys.unshift(String(n.property.value));
            else keys.unshift('*');
            n = unwrap(n.object);
        }
        if (!n || n.type !== 'Identifier' || n.name !== param) return null;
        return keys;
    }
    // Each numeric literal in a contract, and the member path of the comparison it is a side of.
    static contractLiteralUses(src) {
        const ast = Voyager.parseContract(src);
        const root = ast.body[0].expression;
        const param = root.params && root.params.length && root.params[0].type === 'Identifier' ? root.params[0].name : null;
        const COMPARE = new Set(['<', '<=', '>', '>=', '==', '===', '!=', '!==']);
        const uses = [];
        const walk = (n, parent, grand) => {
            if (!n || typeof n.type !== 'string') return;
            if (n.type === 'Literal' && typeof n.value === 'number') {
                let path = null;
                const cmp = parent && parent.type === 'BinaryExpression' && COMPARE.has(parent.operator) ? parent
                    : parent && parent.type === 'UnaryExpression' && parent.operator === '-' && grand && grand.type === 'BinaryExpression' && COMPARE.has(grand.operator) ? grand
                    : null;
                if (cmp) {
                    const side = cmp.left === parent || cmp.left === n ? cmp.right : cmp.left;
                    path = Voyager.memberPath(side, param);
                }
                uses.push({ n: n.value, path });
            }
            for (const v of Object.values(n)) {
                if (Array.isArray(v)) { for (const x of v) walk(x, n, parent); }
                else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, n, parent);
            }
        };
        walk(root, null, null);
        return uses;
    }
    static _registryItem(registry, name) {
        if (!registry || !registry.itemsByName || !registry.blocksByName) throw new Error('[fix97] game data registry required');
        return Object.hasOwn(registry.itemsByName, name) ? registry.itemsByName[name] : null;
    }
    // Distinct counts of this item id used as an ingredient, across every recipe. The result id's own recipe is not the
    // only one: a stick's recipe produces 4 sticks from planks, and fences consume 2 sticks.
    static recipesUsing(registry) {
        let map = recipeUseCounts.get(registry);
        if (map) return map;
        map = new Map();
        const recipes = registry.recipes;
        if (recipes && typeof recipes === 'object') {
            for (const recs of Object.values(recipes)) {
                if (!Array.isArray(recs)) continue;
                for (const r of recs) {
                    const cells = [];
                    if (Array.isArray(r.ingredients)) cells.push(...r.ingredients);
                    if (Array.isArray(r.inShape)) for (const row of r.inShape) if (Array.isArray(row)) cells.push(...row);
                    const tally = new Map();
                    for (const cell of cells) {
                        if (typeof cell !== 'number') continue;
                        tally.set(cell, (tally.has(cell) ? tally.get(cell) : 0) + 1);
                    }
                    for (const [id, count] of tally) {
                        if (!map.has(id)) map.set(id, new Set());
                        map.get(id).add(count);
                    }
                }
            }
        }
        recipeUseCounts.set(registry, map);
        return map;
    }
    // Facts of one item. Each fact names the field it can ground. A stack size is a count of that item, not every literal.
    static itemFacts(registry, name) {
        const facts = [];
        const item = Voyager._registryItem(registry, name);
        if (item) {
            if (typeof item.stackSize === 'number') facts.push({ n: item.stackSize, kind: 'stack', item: name, detail: `${name}.stackSize ${item.stackSize}` });
            if (typeof item.maxDurability === 'number') facts.push({ n: item.maxDurability, kind: 'durability', item: name, detail: `${name}.maxDurability ${item.maxDurability}` });
            const food = registry.foodsByName && Object.hasOwn(registry.foodsByName, name) ? registry.foodsByName[name] : null;
            if (food && typeof food.foodPoints === 'number') facts.push({ n: food.foodPoints, kind: 'food', item: name, detail: `${name}.foodPoints ${food.foodPoints}` });
            if (food && typeof food.saturation === 'number') facts.push({ n: food.saturation, kind: 'food', item: name, detail: `${name}.saturation ${food.saturation}` });
            const recs = registry.recipes && Object.hasOwn(registry.recipes, item.id) ? registry.recipes[item.id] : null;
            if (Array.isArray(recs)) {
                for (const r of recs) {
                    if (r.result && typeof r.result.count === 'number') facts.push({ n: r.result.count, kind: 'recipeResult', item: name, detail: `${name} recipe result count ${r.result.count}` });
                    const cells = [];
                    if (Array.isArray(r.ingredients)) cells.push(...r.ingredients);
                    if (Array.isArray(r.inShape)) for (const row of r.inShape) if (Array.isArray(row)) cells.push(...row);
                    const tally = new Map();
                    for (const cell of cells) {
                        if (typeof cell !== 'number') continue;
                        const prev = tally.has(cell) ? tally.get(cell) : 0;
                        tally.set(cell, prev + 1);
                    }
                    for (const [id, count] of tally) {
                        const ing = registry.items[id];
                        if (!ing || typeof ing.name !== 'string') continue;
                        facts.push({ n: count, kind: 'ingredient', item: ing.name, detail: `${name} recipe uses ${count} ${ing.name}` });
                    }
                }
            }
            const used = Voyager.recipesUsing(registry).get(item.id);
            if (used) {
                for (const count of used) {
                    if (facts.some(f => f.kind === 'ingredient' && f.item === name && f.n === count)) continue;
                    facts.push({ n: count, kind: 'ingredient', item: name, detail: `a recipe uses ${count} ${name}` });
                }
            }
        }
        const block = Object.hasOwn(registry.blocksByName, name) ? registry.blocksByName[name] : null;
        if (block && Array.isArray(block.states)) {
            for (const st of block.states) {
                if (!st || st.name !== 'age' || st.type !== 'int' || !Array.isArray(st.values) || st.values.length === 0) continue;
                const mature = Number(st.values[st.values.length - 1]);
                if (Number.isInteger(mature)) facts.push({ n: mature, kind: 'age', item: name, detail: `${name} mature age ${mature}` });
            }
        }
        return facts;
    }
    static countPath(path, item) {
        if (!path) return false;
        if (path.length === 2 && path[0] === 'delta' && path[1] === item) return true;
        if (path.length === 3 && (path[0] === 'pre' || path[0] === 'post') && path[1] === 'inv' && path[2] === item) return true;
        return false;
    }
    static factMatches(fact, path) {
        if (fact.kind === 'stack' || fact.kind === 'recipeResult' || fact.kind === 'ingredient') {
            if (Voyager.countPath(path, fact.item)) return true;
            if (fact.kind === 'stack' && fact.fromFunctionName && path && path.length === 1 && path[0] === 'ret') return true;
        }
        if (fact.kind === 'durability' && path && path.includes('durability')) return true;
        if (fact.kind === 'food' && path && path.length === 2 && (path[0] === 'pre' || path[0] === 'post') && path[1] === 'food') return true;
        if (fact.kind === 'age' && path && path[path.length - 1] === 'age') return true;
        if (fact.kind === 'slotGroup' && fact.complete && path && path.length === 1 && path[0] === 'ret') return true;
        return false;
    }
    static slotGroupFacts(registry, names) {
        const facts = [];
        const windows = Array.isArray(registry.windowsArray) ? registry.windowsArray : [];
        for (const w of windows) {
            if (!w || !Array.isArray(w.slots)) continue;
            const groups = w.slots.filter(s => s && typeof s.size === 'number' && typeof s.index === 'number');
            for (const g of groups) {
                const members = w.slots.filter(s => s && typeof s.name === 'string' && typeof s.index === 'number' && typeof s.size !== 'number' && s.index >= g.index && s.index < g.index + g.size);
                if (members.length !== g.size) continue;
                const complete = members.every(s => names.has(s.name));
                if (!complete) continue;
                facts.push({ n: g.size, kind: 'slotGroup', item: g.name, complete: true, detail: `${w.name} ${g.name} group size ${g.size} (${members.map(s => s.name).join(', ')})` });
            }
        }
        return facts;
    }
    static skillFacts(registry, skill, contractSrc) {
        const skillAst = Voyager.parseSkill(skill.code);
        const names = new Set(Voyager.namesInAst(skillAst));
        if (typeof contractSrc === 'string') for (const name of Voyager.namesInAst(Voyager.parseContract(contractSrc))) names.add(name);
        const ids = Voyager.functionIds(skillAst);
        if (typeof skill.name === 'string') ids.push(skill.name);
        const functionItems = new Set();
        for (const id of ids) for (const token of Voyager.nameTokens(id)) {
            if (Object.hasOwn(registry.itemsByName, token) || Object.hasOwn(registry.blocksByName, token)) functionItems.add(token);
        }
        for (const token of functionItems) names.add(token);
        const facts = [];
        for (const name of names) {
            for (const fact of Voyager.itemFacts(registry, name)) {
                if (fact.kind === 'stack' && functionItems.has(fact.item)) fact.fromFunctionName = true;
                facts.push(fact);
            }
        }
        for (const fact of Voyager.slotGroupFacts(registry, names)) facts.push(fact);
        return facts;
    }
    static pathText(path) {
        return path && path.length ? `c.${path.join('.')}` : 'a value that is not a field of c';
    }
    // 0 and 1 are the contract encoding (absent, one argument), not a game threshold.
    static unsupportedContractDetails(src, skill, registry) {
        if (!skill || typeof skill.code !== 'string') throw new Error('[fix97] unsupportedContractNumbers: skill code required');
        const entries = Voyager.observedCountEntries(skill);
        const copied = Voyager.copiedCountComparisons(skill.code, entries, registry);
        const copiedNums = new Set(copied.map(h => h.n));
        const codeNumbers = new Set(Voyager.numericLiterals(Voyager.parseSkill(skill.code)).filter(n => !copiedNums.has(n)));
        const observedNums = new Set(entries.map(e => e.n));
        const evidenceNumbers = new Set(Voyager.recordedNumbers({
            consumes: skill.consumes, effects: skill.effects, consumeEvidence: skill.consumeEvidence,
            effectEvidence: skill.effectEvidence, observedRuns: skill.observedRuns, stats: skill.stats,
        }).filter(n => !observedNums.has(n)));
        const facts = Voyager.skillFacts(registry, skill, src);
        const hits = [];
        const argCounts = Voyager.skillArgCounts(skill);
        for (const use of Voyager.contractLiteralUses(src)) {
            const n = use.n;
            if (n === 0 || n === 1) continue;
            if (argCounts && use.path && use.path.length === 2 && use.path[0] === 'args' && use.path[1] === 'length' && Voyager.argsLengthAllowed(argCounts, n)) continue;
            const matched = facts.filter(f => f.n === n && Voyager.factMatches(f, use.path));
            if (matched.length) continue;
            const pathItem = use.path && use.path.length ? use.path[use.path.length - 1] : null;
            const observed = entries.filter(e => e.n === n && (pathItem === e.item || (use.path && use.path.includes(e.item))));
            if (observed.length) {
                const e = observed[0];
                hits.push({ n, path: use.path, verdict: `${skill.name} compares ${Voyager.pathText(use.path)} to ${n}, and ${n} is the ${e.source} count of ${e.item}. A threshold equal to the count observed when the skill was generated is not a game-data fact.` });
                continue;
            }
            if (codeNumbers.has(n) || evidenceNumbers.has(n)) continue;
            const sameNumber = facts.filter(f => f.n === n);
            const elsewhere = sameNumber.length ? ` ${sameNumber.map(f => f.detail).join('; ')} grounds ${sameNumber.map(f => f.kind === 'slotGroup' ? 'c.ret when every slot in that group is named' : f.kind === 'stack' && f.fromFunctionName ? `a count of ${f.item}, or c.ret because the function is named for ${f.item}` : `a ${f.kind} field of ${f.item}`).join('; ')}, not ${Voyager.pathText(use.path)}.` : '';
            hits.push({ n, path: use.path, verdict: `${skill.name} literal ${n} on ${Voyager.pathText(use.path)} is not a code literal, not recorded evidence, and not a minecraft-data fact of that field.${elsewhere}` });
        }
        return hits;
    }
    static unsupportedContractNumbers(src, skill, registry) {
        return Voyager.unsupportedContractDetails(src, skill, registry).map(h => h.n);
    }
    static contextTokenCounts(err) {
        if (!(err instanceof Error)) throw new Error('[fix97] context overflow is not an Error');
        if (Number.isInteger(err.requestTokens) && Number.isInteger(err.contextTokens)) {
            const replyTokens = Object.hasOwn(err, 'replyTokens') ? err.replyTokens : null;
            if (replyTokens !== null && !Number.isInteger(replyTokens)) throw new Error(`[fix97] context overflow reply token count is not an integer: ${err.message}`);
            return { requestTokens: err.requestTokens, contextTokens: err.contextTokens, replyTokens };
        }
        const fit = err.message.match(/prompt does not fit: (\d+) tokens, context (\d+) tokens/);
        if (fit) return { requestTokens: Number(fit[1]), contextTokens: Number(fit[2]), replyTokens: null };
        const reached = err.message.match(/prompt \((\d+) tokens\) \+ reply \((\d+) tokens\) reached the context \((\d+) tokens\)/);
        if (reached) return { requestTokens: Number(reached[1]), contextTokens: Number(reached[3]), replyTokens: Number(reached[2]) };
        const request = err.message.match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/);
        if (request) return { requestTokens: Number(request[1]), contextTokens: Number(request[2]), replyTokens: null };
        throw new Error(`[fix97] CONTEXT_FULL has no token counts: ${err.message}`);
    }
    // Numbers actually stored on the skill (counts, maxima), not the digits of their JSON text.
    static recordedNumbers(value) {
        const out = [];
        const walk = v => {
            if (typeof v === 'number') out.push(v);
            else if (Array.isArray(v)) v.forEach(walk);
            else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(value);
        return out;
    }
    // fix84: a postcondition that requires a held or returned item the named block's harvestTools omit
    // (equipBestToolForIronOre: heldItem === 'iron_shovel' while iron_ore drops only with a pickaxe). A single
    // string is not an enumerated list, so fix83's contractNameLists does not see it.
    static contractToolMismatches(sources, registry) {
        if (!Array.isArray(sources)) throw new Error('[fix84] contractToolMismatches: sources required');
        if (!registry || !registry.blocksByName || !registry.items) throw new Error('[fix84] contractToolMismatches: registry required');
        const blocks = new Set(), tools = new Set();
        const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
        const pathOf = (node, param) => {
            if (param === null) return null;
            const keys = [];
            let n = node;
            while (n && n.type === 'MemberExpression') {
                if (!n.computed) keys.unshift(n.property.name);
                else if (n.property.type === 'Literal') keys.unshift(String(n.property.value));
                else keys.unshift('*');
                n = n.object;
            }
            if (!n || n.type !== 'Identifier' || n.name !== param) return null;
            return keys;
        };
        for (const src of sources) {
            const ast = acorn.parse(`(${String(src)})`, { ecmaVersion: 'latest' });
            const root = ast.body[0].expression;
            const param = root.params && root.params[0] && root.params[0].type === 'Identifier' ? root.params[0].name : null;
            const walk = n => {
                if (!n || typeof n.type !== 'string') return;
                if (n.type === 'Literal' && typeof n.value === 'string' && Object.hasOwn(registry.blocksByName, n.value)) blocks.add(n.value);
                if ((n.type === 'BinaryExpression' && (n.operator === '===' || n.operator === '=='))) {
                    const sides = [[n.left, n.right], [n.right, n.left]];
                    for (const [lit, other] of sides) {
                        if (lit.type !== 'Literal' || typeof lit.value !== 'string') continue;
                        const p = pathOf(other, param);
                        if (p !== null && (eq(p, ['post', 'eq', 'heldItem']) || eq(p, ['pre', 'eq', 'heldItem']) || eq(p, ['ret']))) tools.add(lit.value);
                    }
                }
                for (const v of Object.values(n)) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v); }
            };
            walk(ast);
        }
        const msgs = [];
        for (const tool of [...tools].sort()) {
            for (const block of [...blocks].sort()) {
                const ht = registry.blocksByName[block].harvestTools;
                if (!ht) { msgs.push(`post expects '${tool}' for block '${block}', whose harvestTools list none (it drops by hand)`); continue; }
                const names = Object.keys(ht).map(id => {
                    const it = registry.items[id];
                    if (!it) throw new Error(`[fix84] harvestTools id ${id} of ${block} is not an item`);
                    return it.name;
                });
                if (!names.includes(tool)) msgs.push(`post expects '${tool}' for block '${block}', whose harvestTools are ${names.join(', ')}`);
            }
        }
        return msgs.length ? msgs.join('; ') : null;
    }
    // fix85: a precondition that reads c.post is judging the state after the call (equipBestToolForAxe). Returns the member path, or null.
    static contractPreReadsPost(src) {
        const ast = acorn.parse(`(${String(src)})`, { ecmaVersion: 'latest' });
        const root = ast.body[0].expression;
        const param = root.params && root.params[0] && root.params[0].type === 'Identifier' ? root.params[0].name : null;
        if (param === null) return null;
        const pathOf = node => {
            const keys = [];
            let n = node;
            while (n && n.type === 'MemberExpression') {
                if (!n.computed) keys.unshift(n.property.name);
                else if (n.property.type === 'Literal') keys.unshift(String(n.property.value));
                else keys.unshift('*');
                n = n.object;
            }
            if (!n || n.type !== 'Identifier' || n.name !== param) return null;
            return keys;
        };
        let found = null;
        const walk = n => {
            if (!n || typeof n.type !== 'string' || found) return;
            if (n.type === 'MemberExpression') {
                const p = pathOf(n);
                if (p !== null && p[0] === 'post') found = p.join('.');
            }
            for (const v of Object.values(n)) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v); }
        };
        walk(root);
        return found;
    }
    // fix51: parse a contract with acorn; returns { root, param, src } where root is the contract function node
    _parseContract(contractSrc) {
        const src = String(contractSrc);
        const ast = acorn.parse(`(${src})`, { ecmaVersion: 'latest' });
        const root = ast.body[0].expression;
        if (!root.params) throw new Error(`contract is not a function: ${src}`);
        const param = root.params.length ? root.params[0] : null;
        if (param && param.type !== 'Identifier') throw new Error(`contract parameter is not an identifier: ${src}`);
        return { root, param: param ? param.name : null, src: `(${src})` };
    }
    // fix51: member path rooted at the contract parameter, e.g. c.post.inv.stone -> ['post','inv','stone']; dynamic keys -> '*'
    _contractPath(node, param) {
        const keys = [];
        let n = node;
        while (n.type === 'MemberExpression') {
            if (!n.computed) keys.unshift(n.property.name);
            else if (n.property.type === 'Literal') keys.unshift(String(n.property.value));
            else keys.unshift('*');
            n = n.object;
        }
        if (n.type !== 'Identifier' || n.name !== param) return null;
        return keys;
    }
    _walkAst(node, visit) {
        if (!node || typeof node.type !== 'string') return;
        visit(node);
        for (const v of Object.values(node)) {
            if (Array.isArray(v)) { for (const x of v) this._walkAst(x, visit); }
            else if (v && typeof v === 'object' && typeof v.type === 'string') this._walkAst(v, visit);
        }
    }
    // fix51: extract fields the postcondition reads (acorn AST over MemberExpressions on the contract parameter)
    // Returns { delta: ['stone', '*'], pos, hp, food, inv: [...], eq: [...], dist, ret }
    _extractPostFields(postSrc) {
        const fields = { delta: [], pos: false, hp: false, food: false, inv: [], eq: [], dist: false, ret: false };
        const { root, param } = this._parseContract(postSrc);
        if (param === null) return fields;
        this._walkAst(root.body, node => {
            if (node.type !== 'MemberExpression') return;
            const p = this._contractPath(node, param);
            if (!p) return;
            if (p[0] === 'delta' && p.length === 2) fields.delta.push(p[1]);
            else if (p[0] === 'dist' && p.length === 1) fields.dist = true;
            else if (p[0] === 'ret' && p.length === 1) fields.ret = true;
            else if ((p[0] === 'post' || p[0] === 'pre') && p.length >= 2) {
                if (p[1] === 'pos') fields.pos = true;
                else if (p[1] === 'hp') fields.hp = true;
                else if (p[1] === 'food') fields.food = true;
                else if (p[1] === 'inv' && p.length === 3) fields.inv.push(p[2]);
                else if (p[1] === 'eq' && p.length === 3) fields.eq.push(p[2]);
            }
        });
        fields.delta = [...new Set(fields.delta)]; fields.inv = [...new Set(fields.inv)]; fields.eq = [...new Set(fields.eq)];
        return fields;
    }
    // fix51: observation-based contract mismatch detection
    // When post fails, check if post references fields that didn't change while other fields did change
    // This detects contracts that don't match what the skill actually does, without using name patterns
    _detectContractMismatch(e, r, postFailed) {
        if (!postFailed || !e?.contract?.post || !r.s0 || !r.s1) return null;
        const fields = this._extractPostFields(e.contract.post);
        
        // Compute what actually changed (r.delta is always set by __wrap in skill_graph.js)
        const deltaEmpty = Object.keys(r.delta).length === 0;
        const posMoved = r.s0.pos && r.s1.pos && 
            (Math.abs(r.s1.pos.x - r.s0.pos.x) > 1 || Math.abs(r.s1.pos.y - r.s0.pos.y) > 1 || Math.abs(r.s1.pos.z - r.s0.pos.z) > 1);
        const hpChanged = r.s0.hp !== r.s1.hp;
        const foodChanged = r.s0.food !== r.s1.food;
        const eqChanged = JSON.stringify(r.s0.eq) !== JSON.stringify(r.s1.eq);
        
        // Build observed changes summary
        const changed = [];
        const unchanged = [];
        if (posMoved) changed.push('position'); else unchanged.push('position');
        if (!deltaEmpty) changed.push(`delta(${Object.keys(r.delta).join(',')})`); else unchanged.push('delta');
        if (hpChanged) changed.push('hp');
        if (foodChanged) changed.push('food');
        if (eqChanged) changed.push('equipment');
        
        // Detect mismatch: post checks fields that didn't change, but other fields did change
        const postChecksDelta = fields.delta.length > 0;
        const postChecksPos = fields.pos || fields.dist;
        
        // Case: post checks delta but delta is empty, and position changed
        if (postChecksDelta && deltaEmpty && posMoved && !postChecksPos) {
            return `postcondition checks delta fields [${fields.delta.join(',')}] but delta was empty; position changed. Contract doesn't match skill behavior. Changed: ${changed.join(', ')}; Unchanged: ${unchanged.join(', ')}`;
        }
        // Case: post checks position but position didn't change, and delta changed
        if (postChecksPos && !posMoved && !deltaEmpty && !postChecksDelta) {
            return `postcondition checks position but position didn't change; delta changed [${Object.keys(r.delta).join(',')}]. Contract doesn't match skill behavior. Changed: ${changed.join(', ')}; Unchanged: ${unchanged.join(', ')}`;
        }
        // Case: post checks specific delta items that aren't in actual delta, but other things changed
        if (postChecksDelta && !fields.delta.includes('*')) {
            const checkedButMissing = fields.delta.filter(item => !r.delta[item]);
            if (checkedButMissing.length === fields.delta.length && changed.length > 0) {
                return `postcondition checks delta items [${fields.delta.join(',')}] but none were in actual delta; other state changed. Changed: ${changed.join(', ')}; Unchanged: ${unchanged.join(', ')}`;
            }
        }
        return null;
    }
    // fix51: analyze why a contract failed: walk comparison nodes (acorn) whose side reads the contract parameter and report actual values
    _analyzeContractFailure(contractSrc, c, r) {
        const { root, param, src } = this._parseContract(contractSrc);
        const parts = [];
        const COMPARE = new Set(['<', '<=', '>', '>=', '==', '===', '!=', '!==']);
        if (param !== null) this._walkAst(root.body, node => {
            if (node.type !== 'BinaryExpression' || !COMPARE.has(node.operator)) return;
            const expected = src.slice(node.right.start, node.right.end);
            const lhs = node.left;
            if (lhs.type === 'CallExpression') {
                const cp = this._contractPath(lhs.callee, param);
                if (cp && cp.length === 1 && cp[0] === 'dist') parts.push(`dist(pre.pos,post.pos)=${c.dist(c.pre.pos, c.post.pos).toFixed(1)} (expected ${node.operator}${expected})`);
                return;
            }
            if (lhs.type !== 'MemberExpression') return;
            const p = this._contractPath(lhs, param);
            if (!p || p.includes('*')) return;
            let v = c;
            for (const k of p) { if (v === null || v === undefined) break; v = v[k]; }
            parts.push(`c.${p.join('.')}=${v === undefined ? 'undefined' : JSON.stringify(v)} (expected ${node.operator}${expected})`);
        });
        if (parts.length === 0) {
            const deltaKeys = Object.keys(c.delta);
            const deltaStr = deltaKeys.length ? deltaKeys.map(k => `${k}:${c.delta[k]}`).join(',') : 'empty';
            return `delta={${deltaStr}}, ret=${c.ret}, alive=${c.post.alive}`;
        }
        return parts.join('; ');
    }
    // fix58: every traced skill run with pre/post snapshots teaches that skill's observed food/hp change
    _learnVitalsEffects(trace) {
        for (const r of trace) { if (r.intr || !r.s0 || !r.s1 || !r.s0.alive || !r.s1.alive) continue; this.vitals.noteRun(r.name, r.s0, r.s1); }
    }
    // fix59: same traced runs teach each skill's observed inventory-slot effect (post.free - pre.free)
    _learnSlotEffects(trace) {
        for (const r of trace) { if (r.intr || !r.s0 || !r.s1 || !r.s0.alive || !r.s1.alive) continue; this.slotEffects.noteRun(r.name, r.s0, r.s1); }
    }
    _recovery() { const bot = this.agent.bot; return this.vitals.recovery(bot.health, skills.getVitalsMax(bot).health, bot.food); }
    // fix76: learned hunger outlook (food vs regen floor / decay), including at full HP
    _hunger() { const bot = this.agent.bot, m = skills.getVitalsMax(bot); return this.vitals.hunger(bot.health, m.health, bot.food, m.food); }
    // fix80: shared step-boundary urgent-need pre-emption (vitals hunger now; fix77 threat plugs into the same
    // Thompson slot). Hunger is boundary-only until food-drop rate and per-skill durations are learned; mid-action
    // cuts stay with fix77's threat path. Kind 'need' is never blamed on a skill or the goal backoff.
    _playableFoodRaisers() {
        const out = [];
        for (const r of this.vitals.foodRaisers()) {
            const e = this.skills.find(s => s.name === r.name);
            if (!e) continue;
            if (e.demoted) continue;
            if (e.mergedInto) continue;
            out.push({ entry: e, raiser: r });
        }
        return out;
    }
    _hungerServeState() {
        const bot = this.agent.bot, m = skills.getVitalsMax(bot);
        const raw = this.vitals.hungerServe(bot.food, m.food, bot.health, m.health);
        const playable = this._playableFoodRaisers();
        const best = playable.length > 0 ? playable[0] : null;
        const K = best !== null ? best.raiser.food : null;
        // Only belowRegen is servable (fitsGain dropped: no HP-harm evidence above the floor in VitalsModel).
        return {
            servable: raw.servable, belowRegen: raw.belowRegen, deficit: raw.deficit,
            best, K, regenLossHp: raw.regenLossHp, firstRise: raw.firstRise,
            food: bot.food, foodMax: m.food, hp: bot.health, hpMax: m.health,
        };
    }
    _hungerServeBy(st) {
        const floor = st.firstRise !== null ? `learned regen food floor ${st.firstRise.f}` : 'no regen food floor learned yet';
        const why = `food ${st.food}/${st.foodMax} below ${floor}`;
        const raiser = st.best !== null ? `${st.best.entry.name} +${VitalsModel.reportedFoodPerRun(st.K)} food/run` : 'none playable';
        return `hunger ${why}; raiser ${raiser}; regenLossHp ${st.regenLossHp}`;
    }
    // Learned HP at stake if we continue `taskName`, from death evidence on that task (deathSpots.tasks).
    // Each death = full observed hpMax lost. No death evidence → 0 (task protects no HP in the data).
    _taskHpStake(taskName) {
        if (typeof taskName !== 'string') throw new Error(`[fix80] _taskHpStake needs a task string, got ${JSON.stringify(taskName)}`);
        if (taskName.length === 0) throw new Error('[fix80] _taskHpStake: empty task');
        const spots = this.progress.deathSpots;
        let deaths = 0;
        if (spots !== null && spots !== undefined && typeof spots === 'object') {
            for (const c of Object.values(spots)) {
                if (c === null) continue;
                if (c === undefined) continue;
                if (!Array.isArray(c.tasks)) continue;
                for (const t of c.tasks) {
                    if (t === taskName) deaths++;
                }
            }
        }
        if (deaths === 0) return 0;
        const hpMax = skills.getVitalsMax(this.agent.bot).health;
        const { s, f } = this._goalOutcomes(taskName);
        const outcomes = s + f;
        // Death rate among observed outcomes (deaths count even if not yet folded into goalStats).
        const denom = outcomes > deaths ? outcomes : deaths;
        return hpMax * (deaths / denom);
    }
    // Thompson candidates in HP units. Hunger: raiser success × regenLossHp. Task: success posterior × learned death-HP stake.
    // Threat seam (fix77): push { id:'threat', value: hitChance * learnedDamage, ... }. No fixed priority order.
    _urgentCandidates(st) {
        const candidates = [];
        if (st.servable) {
            let s = 0, f = 0;
            if (st.best !== null && st.best.entry.stats) {
                s = st.best.entry.stats.success;
                f = st.best.entry.stats.fail;
                if (typeof s !== 'number') throw new Error(`[fix80] raiser stats.success/fail must be numbers`);
                if (typeof f !== 'number') throw new Error(`[fix80] raiser stats.success/fail must be numbers`);
            }
            const draw = sampleBeta(s + 1, f + 1);
            // fix89: a need that has failed is worth its Thompson draw times its learned posterior success
            // (the same (s+1)/(n+2) a goal's backoff uses). Fresh needs (no failures) keep multiplier 1.
            const needPosterior = this._goalBackoffMultiplier('need:hunger');
            candidates.push({
                id: 'hunger', kind: 'need', value: draw * st.regenLossHp * needPosterior,
                draw, st, by: this._hungerServeBy(st),
            });
        }
        let taskName = null;
        if (Array.isArray(this.progress.subgoals) && this.progress.subgoals.length > 0) {
            taskName = this.progress.subgoals[0].task;
        } else if (this._decomposeQueue) {
            taskName = this._decomposeQueue.task;
        }
        if (taskName !== null && taskName !== undefined) {
            const { s, f } = this._goalOutcomes(taskName);
            const draw = sampleBeta(s + 1, f + 1);
            const stake = this._taskHpStake(taskName);
            candidates.push({ id: 'task', kind: 'task', value: draw * stake, draw, stake, taskName });
        } else {
            candidates.push({ id: 'task', kind: 'task', value: 0, draw: 0, stake: 0, taskName: null });
        }
        // fix77: ThreatModel candidates append here, same value units (expected HP loss).
        return candidates;
    }
    // fix89: a need serve that already chained subgoals for what it lacks. Those subgoals ARE the serve;
    //        replaying the raiser again would starve them. True while any of that chain is still queued.
    _needServePending(label) {
        const d = this.progress.decomposed;
        if (d === null) return false;
        if (d === undefined) return false;
        if (!Object.hasOwn(d, label)) return false;
        const rec = d[label];
        if (rec === null) throw new Error(`[fix89] decomposed[${JSON.stringify(label)}] must be an object`);
        if (typeof rec !== 'object') throw new Error(`[fix89] decomposed[${JSON.stringify(label)}] must be an object`);
        if (!Array.isArray(rec.subs)) throw new Error(`[fix89] decomposed[${JSON.stringify(label)}].subs must be an array`);
        const q = this.progress.subgoals;
        if (!Array.isArray(q)) return false;
        for (const t of rec.subs) {
            for (const s of q) {
                if (s.task === t) return true;
            }
        }
        return false;
    }
    // One step-boundary serve. Returns true when this step was consumed serving a need.
    async _serveUrgent() {
        // A need:* label is excluded from pre-emption (Mindcraft mode.active analogue).
        if (typeof this.currentTask === 'string' && this.currentTask.startsWith('need:')) return false;
        try {
            return await this._serveUrgentBody();
        } finally {
            // Clear the need label when the serve finishes (success, fail, or throw) so the next step can serve again.
            // Leaving need:hunger stuck would skip every later _serveUrgent (re-entry check) — a livelock.
            if (this.currentTask === 'need:hunger') this.currentTask = null;
        }
    }
    async _serveUrgentBody() {
        // Fail loud: voyager with a live bot must have vitals + numeric food/health. Unit stubs must wire them.
        if (this.vitals === null) throw new Error('[fix80] _serveUrgent: vitals is null');
        if (this.vitals === undefined) throw new Error('[fix80] _serveUrgent: vitals is undefined');
        if (this.agent === null) throw new Error('[fix80] _serveUrgent: agent is null');
        if (this.agent === undefined) throw new Error('[fix80] _serveUrgent: agent is undefined');
        const bot = this.agent.bot;
        if (bot === null) throw new Error('[fix80] _serveUrgent: agent.bot is null');
        if (bot === undefined) throw new Error('[fix80] _serveUrgent: agent.bot is undefined');
        if (typeof bot.food !== 'number') throw new Error(`[fix80] _serveUrgent: bot.food must be a number, got ${JSON.stringify(bot.food)}`);
        if (typeof bot.health !== 'number') throw new Error(`[fix80] _serveUrgent: bot.health must be a number, got ${JSON.stringify(bot.health)}`);

        const st = this._hungerServeState();
        if (!st.servable) return false;
        const candidates = this._urgentCandidates(st);
        const winner = pickUrgentCandidate(candidates);
        if (winner.id !== 'hunger') return false;
        if (!(winner.value > 0)) return false;   // no HP-harm evidence → leave the step to the task/curriculum
        // fix89: the backchain from the last failed serve is the work that obtains the missing input
        if (this._needServePending('need:hunger')) {
            console.log('[urgent-need] hunger backchain still queued; leaving the step to that work');
            return false;
        }
        // fix89: runs were measured and none of them publish a food raise. That is learned, not "no raiser yet",
        //        so this is not a cold start: other work runs.
        if (st.best === null && Object.keys(this.vitals.s.runs).length > 0 && this.vitals.foodRaisers().length === 0) {
            console.log('[urgent-need] measured skill runs do not raise food; leaving the step to other work');
            return false;
        }

        const nSub = Array.isArray(this.progress.subgoals) ? this.progress.subgoals.length : 0;
        const hasDec = Boolean(this._decomposeQueue);
        console.log(`[urgent-need] serving hunger (value=${winner.value.toFixed(3)}, by=${winner.by}); subgoals=${nSub} decompose=${hasDec} deferred untouched`);

        const before = this.observe();
        const label = 'need:hunger';
        this.currentTask = label;
        this._curSub = null;   // never attribute subgoal completion to a need serve

        if (st.best !== null) {
            const route = { name: st.best.entry.name, call: `await ${st.best.entry.name}(bot);` };
            const rp = await this._replay(label, before, route);
            if (rp === null) throw new Error('[fix80] _replay returned nothing for a need raiser serve');
            if (rp === undefined) throw new Error('[fix80] _replay returned nothing for a need raiser serve');
            if (rp.ok) {
                console.log(`[urgent-need] served via learned raiser ${st.best.entry.name}`);
                this._afterSuccess();
                return true;
            }
            // fix89: a missing input is a structured need. Chain it (the same path a failed goal uses) instead of
            //        replaying the raiser. The next step leaves the step to that chain (_needServePending).
            if (Array.isArray(rp.needs) && rp.needs.length > 0) {
                const seen = this.observe();
                await this._judgeItems(seen, this._needItems(rp.needs), true);
                if (await this._withChosenSearches(seen, () => this._chainNeeds(label, rp.needs, seen))) {
                    console.log(`[urgent-need] ${st.best.entry.name} lacked an input; backchained`);
                    return true;
                }
            }
            // Failure is evidence: _replay → _attribute → skill stats. Reason is required (no silent 'serve failed').
            // The outcome also feeds the need's learned posterior (_goalBackoffMultiplier), so a task with HP stake can outrank it.
            if (typeof rp.reason === 'string' && rp.reason.length > 0) {
                this._noteGoalState(label, false, rp.reason, before);
                this._recordGoalOutcome(label, false, rp.reason);
                console.log(`[urgent-need] raiser serve failed: ${rp.reason}; queues remain deferred`);
                return true;
            }
            if (typeof rp.unmetPrecondition === 'string' && rp.unmetPrecondition.length > 0) {
                console.log(`[urgent-need] raiser serve unmet precondition: ${rp.unmetPrecondition}; queues remain deferred`);
                return true;
            }
            throw new Error(`[fix80] need raiser serve failed without a reason: ${JSON.stringify(rp)}`);
        }

        // fix93: a learned food effect on a built-in (consume is not a library skill, so best is null).
        // Obtain an edible from game data, then the next serve runs the raiser. Do not cold-start a curriculum task.
        if (this.vitals.foodRaisers().length > 0) {
            return await this._serveLearnedFood(st, before);
        }

        // Cold start: no learned food raiser at all — propose, then run the NORMAL pursue path (replay then generate-code).
        // currentTask stays need:hunger so we do not re-enter; queues stay deferred.
        const hun = this._hunger();
        const hunText = this.vitals.hungerText(hun);
        const fact = hunText !== null ? hunText : winner.by;
        const note = `LEARNED vital need (pre-empts decompose/subgoal queues; they are deferred, not dropped): ${fact}. Propose ONE task that raises food using what the bot has.`;
        let proposal = await this.proposeTask({ ...before, note });
        if (proposal === null) throw new Error('[fix80] proposeTask returned nothing for a cold-start vital need');
        if (proposal === undefined) throw new Error('[fix80] proposeTask returned nothing for a cold-start vital need');
        if (typeof proposal !== 'object') throw new Error('[fix80] proposeTask returned nothing for a cold-start vital need');
        if (proposal.task === null) throw new Error('[fix80] cold-start proposeTask.task is null');
        if (proposal.task === undefined) throw new Error('[fix80] cold-start proposeTask.task is undefined');
        if (typeof proposal.task !== 'string') throw new Error(`[fix80] cold-start proposeTask.task must be a string, got ${JSON.stringify(proposal.task)}`);
        if (proposal.task.trim().length === 0) throw new Error('[fix80] cold-start proposeTask.task is empty');
        // fix90: the same gate the curriculum step uses. A goal that just failed in this state is backed off
        // by its posterior and the failure (goal, reason, state) is handed back to the next proposal.
        const accepted = await this._acceptPlannerTask(proposal, before);
        if (accepted === null) {
            // fix91: a rejection is not a serve. The step continues to whatever is queued.
            const n = this._queuedSubgoalCount();
            console.log(`[urgent-need] cold-start proposal rejected by the learned posterior in this state; not pursued; leaving the step to ${n} queued subgoal(s)`);
            return false;
        }
        const task = accepted.task;
        proposal = accepted.proposal;
        console.log(`[urgent-need] cold-start model proposal: ${task} (${proposal.reasoning}); pursuing via normal path under ${label}`);
        const acted = await this._pursueProposedTask(task, proposal, before);
        if (acted === true) return true;
        if (acted === false) {
            const n = this._queuedSubgoalCount();
            console.log(`[urgent-need] cold-start proposal "${task}" produced no action; leaving the step to ${n} queued subgoal(s)`);
            return false;
        }
        throw new Error(`[fix91] _pursueProposedTask returned ${JSON.stringify(acted)} for "${task}"; expected true or false`);
    }
    // fix93: built-in raiser. An edible already held is eaten and the deficit closes on measured food.
    // Otherwise the cheapest game-data plan is queued ahead of the raiser. The retry anchor this call
    // inserted is not left on the queue. Entries already queued stay, by object identity. Unrelated
    // queued work that disappears is reported.
    async _consumeItem(item) {
        return skills.consume(this.agent.bot, item);
    }
    async _serveLearnedFood(st, before) {
        const registry = this.agent.bot.registry;
        if (!registry) throw new Error('[fix93] bot.registry required to plan food from game data');
        const edibles = edibleNames(registry);
        await this._judgeItems(before, edibles, false);
        const inv = before.inventory;
        const plan = await this._withChosenSearches(before, (plannerOf) => {
            const planner = plannerOf();
            return planFoodAcquisition({
                edibles,
                inventory: inv,
                cheapest: (items, count, inventory) => planner.cheapest(items, count, inventory, true),
                prerequisites: (item, count, inventory) => planner.prerequisites(item, count, inventory),
                entityDroppersFor: (item) => entityDroppers(registry, item),
            });
        });
        if (plan.executable) {
            const beforeFood = this.agent.bot.food;
            const ate = await this._consumeItem(plan.item);
            if (ate !== true) throw new Error(`[fix93] LOUD: consume(${plan.item}) did not eat; returned ${JSON.stringify(ate)}`);
            const afterFood = this.agent.bot.food;
            const floor = st.firstRise === null ? null : st.firstRise.f;
            const closed = hungerDeficitClosed(beforeFood, afterFood, floor);
            console.log(`[urgent-need] consume ${plan.item}: food ${closed.beforeFood} -> ${closed.afterFood}; learned floor ${closed.floor}; closed=${closed.closed}`);
            if (!closed.closed) throw new Error(`[fix93] LOUD: food ${closed.afterFood} is still below the learned floor ${closed.floor} after consume(${plan.item})`);
            this._afterSuccess();
            return true;
        }
        const droppers = plan.entityDroppers.length ? plan.entityDroppers.join(', ') : 'none in game data';
        console.log(`[urgent-need] no edible held; plan ${plan.task} for ${plan.item} (${plan.how}); entity droppers: ${droppers}`);
        // fix100: the retry anchor _chainNeeds just inserted is the open-goal retry of this call. Remove that object.
        // A queued entry that was already there — including the hunger need being served — is a different object and stays.
        // Matching on the task string treated that need as unrelated work and threw, so the serve never stuck and the next
        // step planned the whole food tree again (the 09:07–09:31Z timeouts).
        const prior = Array.isArray(this.progress.subgoals) ? [...this.progress.subgoals] : [];
        const priorSet = new Set(prior);
        const chained = this._chainNeeds('need:hunger', plan.needs, before);
        if (chained !== true) throw new Error('[fix93] LOUD: food backchain did not queue a plan');
        if (!Array.isArray(this.progress.subgoals)) throw new Error('[fix93] food backchain left no subgoal queue');
        for (const entry of prior) {
            if (!this.progress.subgoals.includes(entry)) throw new Error(`[fix93] LOUD: food backchain dropped unrelated queued work ${JSON.stringify(entry.task)}`);
        }
        const anchors = [];
        for (const s of this.progress.subgoals) {
            if (!priorSet.has(s) && s.retry === true && s.prereq === true) anchors.push(s);
        }
        if (anchors.length !== 1) throw new Error(`[fix93] LOUD: food backchain inserted ${anchors.length} prerequisite retries; expected the one open-goal retry of this serve`);
        const anchor = anchors[0];
        this.progress.subgoals = this.progress.subgoals.filter(s => s !== anchor);
        console.log(`[urgent-need] queued ${plan.task} ahead of the food raiser; unrelated queue kept (${prior.length})`);
        return true;
    }

    // fix76: structural unmet-precondition classification (no message-text matching).
    // (1) seeded code called markPreconditionUnmet(bot) (sandbox binding __mcPreconditionUnmet__, fix74) -> kind === 'precondition'
    // (2) skill's learned vitals effect raises food, and food was already at the observed food cap
    _foodRaiseSaturated(skillName, foodAtStart) {
        if (typeof skillName !== 'string') throw new Error('[fix76] _foodRaiseSaturated: skillName required');
        if (!skillName) throw new Error('[fix76] _foodRaiseSaturated: skillName required');
        if (!this.vitals) return null;   // no vitals store yet → no learned food-raiser
        const e = this.vitals.s.runs[skillName];
        if (!e) return null;
        if (e.n < 1) return null;
        if (!(e.food / e.n > 0)) return null;
        // foodAtStart is required only once this skill is a learned food-raiser
        if (typeof foodAtStart !== 'number') throw new Error(`[fix76] foodAtStart required to test saturation of food-raiser ${skillName}, got ${foodAtStart}`);
        if (Number.isNaN(foodAtStart)) throw new Error(`[fix76] foodAtStart required to test saturation of food-raiser ${skillName}, got ${foodAtStart}`);
        const cap = skills.getVitalsMax(this.agent.bot).food;
        if (foodAtStart >= cap) return 'food_saturated';
        return null;
    }
    _classifyUnmetPrecondition(skillName, foodAtStart) {
        const bot = this.agent.bot;
        const marked = peekPreconditionUnmet(bot);
        if (marked) {
            clearPreconditionUnmet(bot);
            return 'precondition';
        }
        return this._foodRaiseSaturated(skillName, foodAtStart);
    }
    // fix81: a violated pre-contract names what it lacks: the registry items it READ from c.pre.inv (a Proxy records the
    //        reads; the contract is evaluated again on the same state) that the bot has none of. Presence is what an inventory
    //        read can show, so the count is one of any of them; the cheapest is chosen from the game data.
    _contractNeed(e, c, r) {
        const inv = c.pre.inv, reads = new Set(), reg = this.agent.bot.registry;
        const probe = new Proxy(inv, { get: (t, p) => { if (typeof p === 'string') reads.add(p); return t[p]; } });
        this._compileContract(e.contract.pre)({ ...c, pre: { ...c.pre, inv: probe } });
        const lacking = [...reads].filter(k => Object.hasOwn(reg.itemsByName, k) && !(Object.hasOwn(inv, k) && inv[k] > 0));
        if (lacking.length) { r.need = { anyOf: lacking, count: 1, reason: 'contract' }; console.log(`[contract] ${e.name} precondition lacks one of: ${lacking.join(', ')}`); }
    }
    // evaluate contracts on every traced library call; violations become contract failures in the trace
    _checkContracts(trace, taskOk) {
        const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        for (const r of trace) {
            if (r.intr || !r.s0 || !r.s1) continue;
            const e = this.skills.find(s => s.name === r.name);
            // fix86: a string return is the equipped item name. The next contract for this skill is checked against it.
            if (e && typeof r.rv === 'string') {
                if (!r.s1.eq || !Object.hasOwn(r.s1.eq, 'heldItem')) throw new Error(`[fix86] trace of ${e.name} has no eq.heldItem`);
                if (!Array.isArray(e.observedRuns)) e.observedRuns = [];
                if (!e.observedRuns.some(p => p.rv === r.rv && p.heldItem === r.s1.eq.heldItem)) e.observedRuns.push({ rv: r.rv, heldItem: r.s1.eq.heldItem });
            }
            if (!e?.contract) continue;
            const c = this._contractCtx({ args: r.argv, ret: r.rv, pre: r.s0, post: r.s1, delta: r.delta });
            for (const k of ['pre', 'post']) {
                // fix51: when skill explicitly returns false, skip postcondition checking
                // The skill already signaled failure; evaluating post would just mark VIOLATED for expected failure
                // This fixes craftSticks/tossClutter VIOLATED when they legitimately can't succeed
                if (k === 'post' && r.rv === false) continue;
                let ok;
                try { ok = this._compileContract(e.contract[k])(c); }
                catch (err) {
                    // fix86: c.post.pos.dist / similar throw TypeError. The contract is not the state shape; drop it.
                    if (err instanceof TypeError && err.message.includes('is not a function')) {
                        console.error(`[fix86] LOUD: ${e.name}.${k} calls a method the contract state does not have (${err.message}); deleting the contract`);
                        delete e.contract;
                        delete e.contractTried;
                        this._saveSkills();
                        break;
                    }
                    console.log(`!!! [contract] ${e.name}.${k} THREW: ${err.message}; queued contract repair`);
                    this._queueContractFix(e, `${k} threw: ${err.message}`);
                    continue;
                }
                if (ok !== false) { if (k === 'pre') r.preHeld = true; continue; }   // fix60: the callee's own precondition held in this state
                // fix89: undefined is the default return, not a success. A violated pre is "the contract is wrong" only
                //        when the call returned an explicit success (true, a string, a number other than 0). Otherwise
                //        the pre names a real lack and _contractNeed turns the inventory reads into a structured need.
                if (k === 'pre' && !r.fail && r.rv !== undefined && r.rv !== false && r.rv !== null) { console.log(`[contract] ${e.name} precondition violated but the call succeeded -> precondition is wrong; queued contract repair`); this._queueContractFix(e, `precondition ${e.contract.pre} was false but the call succeeded (ret ${r.ret})`); continue; }
                // fix45: when task passed and the skill's delta shows positive gain for its effects, don't attribute VIOLATED
                // The delta is the ground truth; if the contract formula disagrees, the contract is wrong, not the skill
                if (taskOk && k === 'post') {
                    const effects = e.effects;
                    const deltaGained = effects.some(eff => (r.delta?.[eff] || 0) > 0);
                    if (deltaGained) {
                        console.log(`[contract] fix45: ${e.name} postcondition disagreed but delta shows gain for effects [${effects.join(',')}]; queuing contract repair, not skill repair`);
                        this._queueContractFix(e, `postcondition ${e.contract.post} was false but delta shows gain (effects: ${effects.join(',')})`);
                        continue;
                    }
                }
                // fix51: observation-based contract mismatch detection (no name patterns)
                // If post checks fields that didn't change but other fields did, the contract doesn't match the skill
                if (k === 'post') {
                    const mismatch = this._detectContractMismatch(e, r, true);
                    if (mismatch) {
                        console.log(`[contract] MISMATCH ${e.name}: ${mismatch}`);
                        this._queueContractFix(e, mismatch);
                        continue;
                    }
                }
                r.ok = false; r.fail = true; if (k === 'pre') r.preFail = true;
                if (k === 'pre') this._contractNeed(e, c, r);   // fix81: which inventory item the violated precondition lacks
                r.ownFail = [...(r.ownFail || []), `${k === 'pre' ? 'PRECONDITION' : 'POSTCONDITION'} violated: ${Voyager.contractCallFacts(e.name, r.argv, k, e.contract[k])}${e.contract.text ? ` (${e.contract.text})` : ''} (post pos ${r.s1.pos ? [r.s1.pos.x, r.s1.pos.y, r.s1.pos.z].map(Math.round).join(',') : '?'}, sky ${r.s1.sky}, alive ${r.s1.alive})`];
                // fix51: enhanced VIOLATED logging with exact context for debugging
                const stateInfo = `pre.inv=${JSON.stringify(r.s0.inv)}, post.inv=${JSON.stringify(r.s1.inv)}, delta=${JSON.stringify(r.delta)}`;
                // fix51: analyze why the contract failed by evaluating sub-expressions
                const analysis = this._analyzeContractFailure(e.contract[k], c, r);
                console.log(`[contract] VIOLATED ${e.name}(${r.argv.join(',')}) ${k}condition: ${e.contract[k]}`);
                console.log(`[contract] VIOLATED analysis: ${analysis}`);
                console.log(`[contract] VIOLATED context: task=${this.currentTask}, ${stateInfo}`);
                // Log to file for next run analysis
                mkdirSync(`./bots/${this.agent.name}`, { recursive: true });
                appendFileSync(`./bots/${this.agent.name}/violated_contracts.jsonl`, JSON.stringify({ at: new Date().toISOString(), skill: e.name, field: k, contract: e.contract[k], args: r.argv, task: this.currentTask, analysis, state: { pre: r.s0, post: r.s1, delta: r.delta } }) + '\n');
                // the task outcome disagrees with the contract: the contract itself may be wrong -> it is repairable
                if (taskOk && k === 'post' && r.parent < 0) this._queueContractFix(e, `postcondition failed but the task check passed`);
            }
        }
    }
    // fix25 one-off: equipStonePickaxe was promoted with 1 pass (old rule); put the incumbent back and the promoted code back under trial
    _fix25Migrate() {
        const e = this.skills.find(s => s.name === 'equipStonePickaxe');
        if (e?.prev && (e.stats?.success || 0) < 2) {
            const c = { code: e.code, description: e.description, deps: e.deps, effects: e.effects, embedding: e.embedding, stats: e.stats, task: e.task };
            Object.assign(e, { code: e.prev.code, description: e.prev.description, deps: e.prev.deps, stats: e.prev.stats, saved: e.prev.saved });
            delete e.prev; e.candidate = c;
            writeAtomic(`${this.dir}/${e.name}.js`, `// ${e.description}\n${e.code}\n`);
            gateLog(`UNPROMOTE equipStonePickaxe: promoted with ${c.stats?.success || 0} pass(es) < 2; incumbent restored, new version back to candidate (${c.stats.success}/${c.stats.success + c.stats.fail})`);
        } else console.log(`[fix25] equipStonePickaxe: no unpromote needed (passes ${e?.stats?.success})`);
        const fb = this.skills.find(s => s.name === 'fillBucket'); if (fb && !fb.contract) { delete fb.contractTried; console.log('[fix25] fillBucket contract retry queued'); }
        this.progress.fix25 = true; this._saveProgress(); this._saveSkills();
    }
    // fix67: the built-in API changed (getBlockAtPosition's inferred frame -> getBlockAtOffset / getBlockAtAbsolute). A learned
    // skill written against an API that no longer exists cannot lint, so every bundle holding it fails "lint failed before run"
    // and no failure is ever blamed on it. Each learned skill is linted alone against the current API once per (API, skill
    // version); one that fails is queued for a normal repair with the lint text as evidence, so the code model rewrites it and
    // the trial gate decides (no hand edit, no rewrite rule). Clean results are remembered so restarts do not re-lint.
    _apiSignature() { return this._skillHash({ code: getBareAPI().sigs.join('\n') }); }
    // fix71: lint one learned skill alone against the current built-in API; the lint text, or null when it is clean
    async _apiLintOf(e) {
        const names = new Set(this.skills.map(s => s.name));
        const st = await this.agent.coder._stageCode(e.code, { ...this._coderStageOpts(e.code, names), lintOnly: true });
        return await this.agent.coder._lintCode(st.src_lint_copy, st.preludeLines);
    }
    async _queueApiLintRepairs() {
        const api = this._apiSignature();
        const prior = this.progress.apiLint;
        const clean = prior && prior.api === api ? prior.clean : {};
        const seeded = new Set(Voyager.SEEDED_PRIMITIVES.map(p => p.name));   // repo-owned, linted by the tests
        let linted = 0; const broken = [];
        for (const e of this.skills) {
            if (seeded.has(e.name) || e.mergedInto) continue;
            const h = this._skillHash(e);
            if (clean[e.name] === h) continue;
            const lint = await this._apiLintOf(e);
            linted++;
            if (!lint) { clean[e.name] = h; continue; }
            delete clean[e.name];
            broken.push(e.name);
            const evidence = apiLintEvidence(e.name, lint);
            // fix71: the lint result rides on the queue entry (API hash + skill hash), so _repair can tell the maturity gate
            // that this version's track record was earned under an API it no longer runs on
            const apiLint = { api, hash: h };
            const rq = [...(this._repairQueue || [])];
            const queued = rq.find(x => x.target === e.name && x.kind !== 'contract_fix');
            if (queued) {
                if (queued.apiLint?.api === api && queued.apiLint?.hash === h) { console.log(`[api-lint] ${e.name} does not lint against the current API; its repair is already queued with that evidence`); continue; }
                queued.apiLint = apiLint; queued.evidence = `${evidence}; ${queued.evidence}`;
                this._repairQueue = rq;
                console.log(`[api-lint] ${e.name} does not lint against the current API; the queued ${queued.kind} repair now carries that evidence`);
                continue;
            }
            rq.push({ target: e.name, leaf: e.name, path: [e.name], kind: 'callee_fix', swallowed: false, task: 'lint against the current built-in API',
                evidence, trace: '', depth: 0, apiLint });
            this._repairQueue = rq;
            console.log(`[api-lint] QUEUED REPAIR of ${e.name}: it does not lint against the current built-in API`);
        }
        this.progress.apiLint = { api, clean };
        this._saveProgress();
        console.log(`[api-lint] API ${api}: linted ${linted} learned skill(s), ${broken.length} need repair${broken.length ? ` (${broken.join(', ')})` : ''}`);
        return broken;
    }
    _queueContractFix(e, why) {
        // fix87: an identical pre/post repair is terminal for this evidence. The queue item is consumed when it runs;
        //        the next step's check would unshift another one. failedRepairSigs (hash + evidence, no timer) is the
        //        rejection, so that unshift does not happen.
        if (this._sameContractRepairRejected(e, why)) {
            console.log(`!!! [contract] LOUD: contract repair of ${e.name} not re-queued; this evidence was already rejected (${why})`);
            return;
        }
        const rq = [...(this._repairQueue || [])];
        if (rq.some(x => x.target === e.name && x.kind === 'contract_fix')) return;
        rq.unshift({ target: e.name, leaf: e.name, path: [e.name], kind: 'contract_fix', swallowed: false, evidence: why, task: 'contract check', trace: '', depth: 99 });
        this._repairQueue = rq;
    }
    // learn contracts for a batch of skills with one code-model call; invalid ones fail loudly (no default contract)
    // fix45: skills with seeded contracts (contract.seeded === true) are never overwritten by learned contracts
    async _learnContracts(ents, why, fixNote = '') {
        // fix45: filter out skills with seeded contracts - they must not be overwritten
        const learnable = ents.filter(e => !e.contract?.seeded);
        const skipped = ents.filter(e => e.contract?.seeded);
        if (skipped.length) {
            console.log(`[contract] SKIPPED ${skipped.length} skill(s) with seeded contracts: ${skipped.map(e => e.name).join(', ')}`);
        }
        if (!learnable.length) return 0;
        const system = `You write PSN skill contracts for a Minecraft mineflayer skill library.\n${Voyager.CONTRACT_SPEC}\nReply ONLY with JSON: {"<skillName>": {"pre": "c => ...", "post": "c => ...", "text": "<one-line contract summary>"}, ...} for exactly the skills given.`;
        const user = learnable.map(e => `--- ${e.name} ---\ndescription: ${e.description}\nobserved effects: ${JSON.stringify(e.effects)}\n${e.contractFail ? `previous contract was refused: ${e.contractFail}\n` : ''}${e.contract ? `current contract (${fixNote || 'to fix'}): ${JSON.stringify(e.contract)}\n` : ''}code:\n${String(e.code)}`).join('\n');
        console.log(`[contract] learning contracts for ${learnable.length} skill(s) (${why}): ${learnable.map(e => e.name).join(', ')}`);
        let out; try { out = parseJSON(await this._ask(system, user, this._inferMeta('contract', { system, user }))); } catch (err) { console.log(`[contract] learning FAILED: ${err.message}`); return 0; }
        let n = 0;
        for (const e of learnable) {
            const ct = out?.[e.name], bad = this._validContract(ct, e);
            e.contractTried = Date.now();
            if (bad) { e.contractFail = bad; console.log(`[contract] FAILED for ${e.name}: ${bad}`); continue; }
            delete e.contractFail;
            // fix56/fix87: the same pre/post does not explain the violation. Installing it anyway left the contract
            //        unchanged, the queue entry was already consumed, and the next step queued the same repair (live:
            //        equipBestToolForAxe, 511 code-model calls). Record it on failedRepairSigs and do not install it,
            //        so the same evidence is not re-queued while this skill hash stands. A different evidence string,
            //        or a changed skill, is still a repair.
            if (why === 'contract repair' && e.contract && e.contract.pre === ct.pre && e.contract.post === ct.post) {
                console.log(`!!! [contract] LOUD: contract repair of ${e.name} returned the SAME pre/post; the violation (${fixNote}) is not explained by the contract`);
                this._proposalOutcome(e, 'rejected same contract', this._repairSig(e.name, fixNote));
                continue;
            }
            if (e.contract) e.contractPrev = e.contract;
            e.contract = { pre: ct.pre, post: ct.post, text: String(ct.text || ''), learned: new Date().toISOString(), why };
            n++; console.log(`[contract] ${e.name}: pre ${ct.pre.slice(0, 80)} | post ${ct.post.slice(0, 120)}`);
        }
        this._saveSkills(); return n;
    }
    // backfill: skills without a contract, 12 per code-model call, retried at most every 30 min per skill
    async _backfillContracts() {
        if (this._cursorLimited()) return false;
        const todo = this.skills.filter(s => !s.contract && !s.mergedInto && Date.now() - (s.contractTried || 0) > 30 * 60e3).slice(0, 12);
        if (!todo.length) return false;
        await this._learnContracts(todo, 'backfill'); return true;
    }
    get enabled() { return this.progress.enabled !== false; }
    setEnabled(v) { this.progress.enabled = v; this._saveProgress(); if (!v) this.interrupt(); }
    _saveProgress() { writeAtomic(this.progressFile, JSON.stringify(this.progress, null, 2)); }
    // fix32: debounced (one write per burst); flushed at the end of every step
    _saveSkills() { this._skillsDirty = true; if (!this._saveTimer) this._saveTimer = setTimeout(() => this._flushSkills(), 1000); }
    _flushSkills() { clearTimeout(this._saveTimer); this._saveTimer = null; if (!this._skillsDirty) return; this._skillsDirty = false; writeAtomic(this.indexFile, JSON.stringify(this.skills, null, 2)); }
    // fix14: highest solid (non-leaf, non-log) block in a loaded column; null if the column is not loaded
    _surfaceY(x, z) {
        const bot = this.agent.bot, V = bot.entity.position.constructor; x = Math.floor(x); z = Math.floor(z);
        const top = bot.game?.height ? (bot.game.minY ?? -64) + bot.game.height - 1 : 319, bottom = bot.game?.minY ?? -64;
        if (!bot.blockAt(new V(x, top, z))) return null;
        for (let y = top; y >= bottom; y--) { const b = bot.blockAt(new V(x, y, z)); if (b && b.boundingBox === 'block' && !/leaves|_log$|_wood$/.test(b.name)) return y; }
        return null;
    }
    // fix14: once, when near home's x/z, set HOME.y = ground + 1 and save it to home.json
    _checkHomeGround() {
        if (HOME.groundVerified) return;
        const p = this.agent.bot.entity.position;
        if (Math.hypot(p.x - HOME.x, p.z - HOME.z) > 32) return;
        const g = this._surfaceY(HOME.x, HOME.z);
        if (g === null) return;
        const old = HOME.y; HOME.y = g + 1; HOME.groundVerified = true;
        writeAtomic(HOME_FILE, JSON.stringify(HOME, null, 2) + '\n');
        console.log(`[home] ground at home (${HOME.x}, ${HOME.z}) is y=${g}; HOME.y ${old} -> ${HOME.y} (saved to ${HOME_FILE})`);
    }
    // fix14: why an action was cut off, for failure feedback (critic, code writer, blame)
    // fix19 (6): did the bot die during the current run? (agent.lastDeath set by the death message handler)
    // fix27: an action with no position/inventory change for longer than learned (fix66; was 60s) is stopped and traced as a failure (no waiting out the 5-min timeout)
    async _run(label, fn, timeout) {
        // fix93: settle practice before the foreground reads the world, then resume it if a model call is still waiting
        const cover = this._inferCover;
        if (cover) await cover.claim();
        try { return await this._runForeground(label, fn, timeout); }
        finally { if (cover) cover.resume('foreground'); }
    }
    async _runForeground(label, fn, timeout) {
        // fix42: populate bot.__safeToToss before any skill run (for tossClutter/freeInventory)
        const capacity = this._prepareTossSignals();
        if (capacity) {
            const seen = this.observe();
            await this._judgeItems(seen, this._capacityItems(capacity.req), false);
            const plan = this._buildCapacityPlan(capacity.req, seen, capacity.slotsNeeded);
            this.agent.bot.__capacityPlan = plan.removals;
        }
        // fix51: track inventory+equipment before run for death item-drop reporting (same view as satisfaction check)
        this._beforeRunInv = this._getInventoryWithEquipment();
        // fix28: progress = position, inventory, health, food, open-window contents (crafting/furnace UI) or a lit furnace/smoker nearby (smelting wait)
        const bot = this.agent.bot;
        const lit = () => !!bot.findBlock({ matching: b => /furnace|smoker/.test(b.name) && b.getProperties?.().lit === true, maxDistance: 6 });
        // fix33: position progress = reaching a 2-block cell not visited in this run (swimming/bobbing jitter and pacing back and forth
        // are not progress); health/food are not progress (drowning damage + regen kept resetting the timer)
        const seen = new Set(), cell = p => `${Math.floor(p.x / 2)},${Math.floor(p.y / 2)},${Math.floor(p.z / 2)}`; let fresh = 0;
        const sig = () => { const p = bot.entity?.position; if (!p) return ''; const w = bot.currentWindow, c = cell(p); if (!seen.has(c)) { seen.add(c); fresh++; }
            return `${fresh}|${JSON.stringify(world.getInventoryCounts(bot))}|${w ? w.type + ':' + w.slots.map(i => i ? i.name + i.count : '').join(',') : ''}|${lit() ? Date.now() : ''}`; };  // fix41: host code uses world. prefix
        // fix66: the 60 s limit and 5 s poll were constants (fix27). Now: checked on the game's physics tick; the bound is the
        // longest completed gap between progress signatures in earlier runs (movement store kind 'run'), only counting time
        // while the action executes; UNBOUNDED (logged once) until a gap was learned before this run started
        const learnedAtStart = learnedKinds();
        let last = sig(), gap = 0, tickAt = performance.now(); this._stall = null;
        const onTick = () => {
            const now = performance.now(), dt = now - tickAt; tickAt = now;
            const s = sig();
            if (s !== last) { if (gap > 0) recordStep('run', gap, 0); last = s; gap = 0; return; }
            if (!this.agent.actions.executing || this._stall) return;
            gap += dt;
            const b = stepBound('run', 0, learnedAtStart);
            if (b.ms === null) { if (noteUnbounded('run')) console.log(`[stall] UNBOUNDED run: ${b.why}; the no-progress stop is off until learned`); return; }
            if (gap <= b.ms) return;
            recordCut('run');
            const p = bot.entity.position;
            this._stall = { t: Date.now(), pos: `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`, why: `${Math.round(gap)}ms, longer than all ${b.n} completed gaps learned (longest ${Math.round(b.max)}ms)` };
            console.log(`[stall] ${label}: no progress (no new ground reached, inventory, window, lit furnace) for ${this._stall.why} at ${this._stall.pos}; stopping the action`);
            this.agent.actions.stop({ kind: 'stall', by: `no progress for ${this._stall.why}` });
        };
        bot.on('physicsTick', onTick);
        this._lastRunMsg = ''; this._lastRunTimedOut = null;
        // fix74: _executeAction returns { message: string } on every path (output summary, exception text, loop kill); a result
        //        without one is an action-manager bug, not an empty output (was String(r?.message || ''))
        try {
            const r = await this.agent.actions.runAction(label, fn, { timeout });
            if (typeof r.message !== 'string') throw new Error(`[voyager] _run(${label}): action result has no message string (got ${JSON.stringify(r.message)})`);
            this._lastRunMsg = r.message; this._lastRunTimedOut = r.timedout; return r;
        } finally { bot.removeListener('physicsTick', onTick); }
    }
    _stalledInRun() { const s = this._stall; return s && s.t >= (this._runStart || Infinity) ? s : null; }
    /** fix65: candidate code staged in place for a replay of `root`; `rootTrial` = the goal-overlap gate's verdict on root's own candidate */
    // fix81: the closure of a replay follows the deps of the version that will run: a candidate under trial is staged with
    //        ITS deps, not the incumbent's. Before, the closure came from the incumbents' deps only, so a repaired candidate
    //        that calls a new helper ran without it: live 17:56:15Z the joint repair's craftIronPickaxe candidate calls
    //        checkForIronPickaxe (NEW 17:50:41Z), the incumbent's deps are [craftRecipe], and every trial lint-failed
    //        "'checkForIronPickaxe' is not defined" (bundle "8 skill names in closure", the helper not among them).
    _replayOverrides(root, rootTrial) { return this._trialClosure(root, rootTrial).over; }
    _trialClosure(root, rootTrial) {
        const g = this._graph(), byName = new Map(this.skills.map(s => [s.name, s]));
        const closure = new Set(), over = {}, rejected = new Map(), st = [root];
        while (st.length) {
            const n = st.pop();
            if (closure.has(n)) continue;
            closure.add(n);
            const e = byName.get(n);
            const trial = e !== undefined && Boolean(e.candidate) && (n === root ? rootTrial : true);
            if (trial) {
                if (!Array.isArray(e.candidate.deps)) throw new Error(`[fix81] candidate of ${n} has no deps array`);
                // fix86: a trial that drops the unmet-need marker returns 0 with no reach need (live collectBlock repair)
                // fix87: that candidate is rejected and not kept. The incumbent runs. It is not a step error of the caller's task
                //        (the same throw twice was a [fatal] exit 1, pickupNearbyItems 21:38:26).
                const dropped = markerCallsMissing(e.code, e.candidate.code, PRECONDITION_UNMET_BINDING);
                if (typeof dropped === 'string' && dropped.includes('repair dropped')) {
                    this._rejectDroppedNeed(e, dropped);
                    rejected.set(n, dropped);
                    if (Object.hasOwn(g, n)) st.push(...g[n]);
                } else {
                    over[n] = e.candidate.code;
                    st.push(...e.candidate.deps);
                }
            } else if (Object.hasOwn(g, n)) st.push(...g[n]);
        }
        return { closure, over, rejected };
    }
    // fix87: the candidate is not kept. The reason is stored on the skill, and the next repair prompt shows repairHistory.
    _rejectDroppedNeed(e, dropped) {
        if (!e.candidate || typeof e.candidate.task !== 'string') throw new Error(`[fix87] LOUD: candidate of ${e.name} has no task; the rejection cannot be fed back`);
        const task = e.candidate.task;
        console.error(`!!! [fix87] LOUD: candidate of ${e.name} rejected (not kept, not a step failure): ${dropped}`);
        delete e.candidate;
        this._noteProposal(e, { task, kind: 'trial', evidence: dropped, desc: 'candidate dropped the reported need', outcome: 'rejected dropped need' });
    }
    _crashedInRun() { const c = this._crash; return c && c.t >= (this._runStart || Infinity) ? c : null; }
    // fix65: a run that kills the process (watchdog SIGKILL on a blocked main loop) never reaches _attribute, so its trial
    // outcome was lost: the 12:43Z hang in the collectBlock candidate left its record at 0/0. Before every run that carries
    // trial candidates, the learner writes which candidates are in flight; a clean end removes the journal. On the next
    // start a journal still on disk means the process died inside that run.
    get _trialJournalFile() { return `${this.dir}/trials_inflight.json`; }
    // fix68: every replay/trial run is journalled with the library skills it runs and the version of each (candidate or
    // incumbent code hash), not only runs with a candidate in flight. fix65 journalled candidate runs only, so the 14:02:52Z
    // kill (no candidate on the stack) could not be counted against anything, and a just-promoted skill was never counted.
    _openTrialJournal(names, root, task, closure) {
        // fix78: fix68 (19c0ecc) added `closure` but the generated-code call site (fix65, dfd90ec) kept passing 3 args, so every
        //        code-model attempt died here with "closure is not iterable"; a missing closure is a caller bug, say so
        if (!(closure instanceof Set)) throw new Error(`_openTrialJournal(${JSON.stringify(root)}, task ${JSON.stringify(task)}): closure must be the Set of library skills the run can execute, got ${closure === null ? 'null' : typeof closure}`);
        const ran = {};
        for (const n of new Set([root, ...closure])) {
            const e = this.skills.find(s => s.name === n);
            if (!e) continue;
            const cand = names.includes(n) && e.candidate;   // the candidate code is what runs (staged by _trialClosure)
            ran[n] = cand ? { as: 'candidate', hash: this._skillHash({ code: e.candidate.code }) } : { as: 'incumbent', hash: this._skillHash(e) };
        }
        writeAtomic(this._trialJournalFile, JSON.stringify({ pid: process.pid, root, task, ran, candidates: Object.keys(ran).filter(n => ran[n].as === 'candidate'), startedAt: Date.now() }));
        return () => unlinkSync(this._trialJournalFile);
    }
    // Reads the journal left by a process that died mid-run, with the watchdog's evidence (main_thread_watchdog.js), and
    // counts the hang against the deepest library skill on the blocked call stack, in the version that ran: a trial
    // candidate's trial fails, an incumbent (a just-promoted one too) records a failed run. Harness bookkeeping
    // ("<stack> <- (psn trace)") is nobody's skill: loud, not counted.
    // fix96: the previous process's watchdog kill, printed once in full (the bot API call that was running and the staged code),
    //        so the log of the restart holds what blocked. The file is marked reported, not removed (_settleDeadTrials reads it).
    _reportWatchdogKill(evidencePath) {
        if (!existsSync(evidencePath)) return;
        const ev = JSON.parse(readFileSync(evidencePath, 'utf8'));
        if (ev.reported === true) return;
        const code = Object.hasOwn(ev, 'code') && ev.code !== null ? ev.code : null;
        let inspector = '';
        if (!Object.hasOwn(ev, 'callFrames')) inspector = '; inspector stack not recorded by this watchdog version';
        else if (ev.callFrames === 'stack not captured') inspector = '; stack not captured';
        else if (!Array.isArray(ev.callFrames)) throw new Error(`[watchdog] callFrames is not an array or "stack not captured": ${JSON.stringify(ev.callFrames)}`);
        else inspector = `; inspector stack ${ev.callFrames.map(f => `${f.functionName}@${f.lineNumber}`).join(' <- ')}`;
        const clock = Object.hasOwn(ev, 'killClock') ? ` on the ${ev.killClock} clock` : '';
        console.error(`!!! [watchdog] previous process ${ev.pid} was SIGKILLed at ${ev.at} after ${ev.silentMs}ms without a main-loop turn${clock}; `
            + `phase ${ev.phases.join(' <- ')}; skill ${ev.skill}; stack ${ev.stack}; bot API call ${Object.hasOwn(ev, 'call') ? ev.call : '(not recorded by this watchdog version)'}${inspector}`);
        if (code === null) console.error('!!! [watchdog] no staged code was recorded for that kill');
        else if (Object.hasOwn(code, 'endedAt')) console.error(`!!! [watchdog] last staged code finished at ${code.endedAt} (${code.label}); it was not running at the kill`);
        else console.error(`!!! [watchdog] staged code running at the kill (${code.label}, staged ${code.at}):\n${code.source}`);
        writeAtomic(evidencePath, JSON.stringify({ ...ev, reported: true }));
    }
    _settleDeadTrials(evidencePath) {
        if (!existsSync(this._trialJournalFile)) return;
        const j = JSON.parse(readFileSync(this._trialJournalFile, 'utf8'));
        unlinkSync(this._trialJournalFile);
        const ev = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null;
        const ranNames = Object.keys(j.ran);
        if (!ev || ev.pid !== j.pid) {
            console.error(`!!! [gate] LOUD: process ${j.pid} died during "${j.task}" (root ${j.root}; ran ${ranNames.join(', ')}) and left no watchdog evidence for that pid; the outcome cannot be attributed to one of them`);
            return;
        }
        const frames = String(ev.stack).split(' <- ');
        if (frames[frames.length - 1] === '(psn trace)') {
            console.error(`!!! [gate] LOUD: process ${j.pid} was SIGKILLed while the PSN trace harness itself was running (stack ${ev.stack}, phase ${ev.phases.join(' <- ')}); a harness fault, not counted against any skill`);
            return;
        }
        const culprit = [...frames].reverse().find(n => ranNames.includes(n));
        if (!culprit) {
            console.error(`!!! [gate] LOUD: process ${j.pid} was SIGKILLed by the watchdog during "${j.task}" blocked in "${ev.stack}", which names none of the library skills that ran (${ranNames.join(', ')}); not counted`);
            return;
        }
        const e = this.skills.find(s => s.name === culprit);
        const v = j.ran[culprit];
        const how = `HUNG - watchdog SIGKILLed pid ${j.pid} after ${ev.silentMs}ms without a main-loop turn (stack ${ev.stack}, phase ${ev.phases.join(' <- ')})`;
        if (v.as === 'candidate') {
            if (!e?.candidate || this._skillHash({ code: e.candidate.code }) !== v.hash) {
                console.error(`!!! [gate] LOUD: ${culprit} hung process ${j.pid} as a trial candidate, but that candidate is gone or changed since; nothing to count`);
                return;
            }
            gateLog(`trial run of candidate ${culprit} inside ${j.root}: ${how}; counted as a failed trial`);
            this._recordRun(e, j.task, false, true);
            return;
        }
        if (!e || this._skillHash(e) !== v.hash) {
            console.error(`!!! [gate] LOUD: ${culprit} hung process ${j.pid}, but its code changed since that run; nothing to count`);
            return;
        }
        gateLog(`run of ${culprit} inside ${j.root}: ${how}; counted as a failed run of the current version (saved ${e.saved})`);
        this._recordRun(e, j.task, false, false);
    }
    _diedInRun() { const d = this.agent.lastDeath; return d && d.t >= (this._runStart || Infinity) ? d : null; }
    // fix75: takes the action result. Its interruptedBy is recorded where the interrupt fired (agent.requestInterrupt); a
    // timeout is a normal failed attempt of kind 'timeout'
    _interruptReason(res) {
        if (!res || typeof res !== 'object') throw new Error(`_interruptReason needs the action result, got ${JSON.stringify(res)}`);
        const output = String(res.message);
        const died = this._diedInRun();
        // fix51: set structured kind field (no text parsing needed later)
        if (died) {
            this._lastCutKind = 'death';
            return `died: ${died.message} at ${died.pos}${this._deathDetail(died, this._beforeRunInv)}`;
        }
        const st = this._stalledInRun();
        if (st) {
            this._lastCutKind = 'stall';
            return `stalled: no progress (no new ground reached, inventory, window, lit furnace) for ${st.why} at ${st.pos}`;
        }
        const src = res.interruptedBy;
        if (!src) throw new Error(`_interruptReason: the action was interrupted but no source recorded itself (interruptedBy=${JSON.stringify(src)}); every interrupt must call agent.requestInterrupt({ kind, by })`);
        const bot = this.agent.bot, p = bot.entity.position;
        const s = this._surfaceY(p.x, p.z), under = s !== null && p.y < s - 4;
        const travelling = /travelTo|goToPosition|goToSurface|path|Moving|travell/i.test(output.slice(-800));
        if (src.kind === 'timeout') {
            if (!res.timedout) throw new Error(`_interruptReason: source is a timeout (${src.by}) but the result says timedout=${res.timedout}`);
            this._lastCutKind = 'timeout';
            return `timed out: ran past the ${src.by}${travelling ? ' while travelling' : ''}${under ? ` (underground: y=${Math.floor(p.y)}, surface y=${s})` : ''}`;
        }
        // fix80: kind 'need' (and fix77 'threat') are interrupts that must not be blamed on the skill or goal backoff
        if (isUnblamedInterruptKind(src.kind)) {
            this._lastCutKind = src.kind;
            return `interrupted: cut off by ${src.kind} ${src.by}${travelling ? ' while travelling' : ''}${under ? ` (underground: y=${Math.floor(p.y)}, surface y=${s})` : ''}`;
        }
        const what = src.by === 'mode:unstuck' ? 'stuck' : `cut off by ${src.kind} ${src.by}`;
        this._lastCutKind = 'interrupt';
        return `interrupted: ${what}${travelling ? ' while travelling' : ''}${under ? ` (underground: y=${Math.floor(p.y)}, surface y=${s})` : ''}`;
    }

    // fix59: process-level uncaught error/rejection. Kept alive ONLY while a task step is running: the error is that step's
    // (generated code), so the step is failed and stopped and the update loop keeps acting. Outside a step nothing owns the
    // error and nothing will act on it, so it is fatal (agent.fatal: exit 1, launchd restarts) instead of a silent stall.
    _onProcessError(kind, err) {
        if (!this.running) return this.agent.fatal(`${kind} outside a task step`, err);
        const t = this.currentTask;
        this._crash = { t: Date.now(), kind, message: err instanceof Error ? err.message : String(err) };   // fix65: attributed in _attribute
        console.error(`[voyager] !!! ${kind} during task step "${t}" - counted as FAILED, step stopped, process kept alive: ${err instanceof Error ? err.stack : String(err)}`);
        if (t) { this.progress.failed.push(t); this._saveProgress(); }
        const src = { kind: 'process-error', by: kind };   // fix75: recorded like every other interrupt
        this.agent.requestInterrupt(src);
        this.agent.actions.stop(src);
    }
    // a real player spoke: they take priority
    notePlayerMessage() {
        this.lastPlayerMsg = Date.now();
        if (this.running) this.interrupt();
    }
    interrupt() {
        this.abort = true;
        if (this.running) this.agent.actions.stop({ kind: 'player', by: 'a player spoke' }).catch(e => this.agent.fatal('voyager.interrupt: stopping the action', e));   // fix75: was an empty catch
    }

    // fix28: 1 Hz motion/health samples so a death carries fall height and the damage that preceded it
    // fix51: also samples oxygen_level (bot.oxygenLevel) for drowning analysis
    _sample() {
        // fix59: no catch-and-continue around this. update() runs only from agent.startEvents(), which runs after mineflayer's
        // 'spawn' (emitted from the first update_health packet, whose handler sets bot.health/bot.food in the same emit), so
        // entity/health/food exist by construction; if that ever breaks, fail loud here instead of being swallowed.
        const bot = this.agent.bot, now = Date.now(); if (this._lastSample !== undefined && now - this._lastSample < 1000) return; this._lastSample = now;
        const p = bot.entity.position, h = bot.health, f = bot.food, o = bot.oxygenLevel, prev = (this._samples ||= []).slice(-1)[0];
        VitalsModel._nums({ 'bot.health': h, 'bot.food': f });
        if (prev) this.vitals.observeSample(prev, { h, f }, skills.getVitalsMax(bot).health);   // fix58: learn food level -> hp regen
        const hit = prev && h < prev.h ? { t: now, dmg: +(prev.h - h).toFixed(1), near: (() => { const e = bot.nearestEntity(x => x !== bot.entity && x.type !== 'object' && x.position.distanceTo(p) < 8); return e ? `${e.name || e.username} ${e.position.distanceTo(p).toFixed(0)}m` : 'no entity within 8m'; })(), onGround: bot.entity.onGround, inLava: !!bot.entity.isInLava, inWater: !!bot.entity.isInWater } : null;
        this._samples.push({ t: now, y: p.y, h, f, o, hit }); if (this._samples.length > 30) this._samples.shift();
    }
    // fix51: _deathDetail now accepts optional beforeInv to compute items dropped on death
    _deathDetail(d, beforeInv = null) {
        const ss = (this._samples || []).filter(x => x.t >= d.t - 10e3 && x.t <= d.t + 1500); if (!ss.length) return '';
        const dy = +d.pos.split(',')[1], fall = Math.max(0, Math.round(Math.max(...ss.map(x => x.y)) - dy));
        const hits = ss.filter(x => x.hit).map(x => `-${x.hit.dmg}hp (${x.hit.near}${x.hit.inLava ? ', in lava' : ''}${x.hit.inWater ? ', in water' : ''}${x.hit.onGround ? '' : ', airborne'})`);
        // fix51: report observed oxygen trend (no threshold classification)
        const oxygenSamples = ss.filter(x => typeof x.o === 'number');
        let oxygenTrend = '';
        if (oxygenSamples.length >= 2) {
            const first = oxygenSamples[0].o, last = oxygenSamples[oxygenSamples.length - 1].o;
            const minO = Math.min(...oxygenSamples.map(x => x.o));
            if (first !== last || minO < first) {
                const elapsed = Math.round((oxygenSamples[oxygenSamples.length - 1].t - oxygenSamples[0].t) / 1000);
                oxygenTrend = `; oxygen ${first} -> ${last} (min ${minO}) over ${elapsed}s`;
            }
        }
        // fix51: compute items dropped on death (inventory+equipment delta, same view as satisfaction check)
        let itemsLost = '';
        if (beforeInv) {
            const afterInv = this._getInventoryWithEquipment();
            const lost = [];
            for (const [item, beforeCount] of Object.entries(beforeInv)) {
                const afterCount = afterInv[item] || 0;
                const delta = beforeCount - afterCount;
                if (delta > 0) lost.push(`${item}:${delta}`);
            }
            if (lost.length > 0) itemsLost = `; items dropped: ${lost.join(', ')}`;
        }
        return `; fall height ${fall} blocks in the last 10s; damage taken: ${hits.length ? hits.join(', ') : 'none sampled'}${oxygenTrend}${itemsLost}`;
    }
    update() {
        this._sample();   // fix59: fail loud (was catch-and-continue)
        if (!this.enabled || this.running) {
            this.idlePractice.markBusy();
            return;
        }
        const now = Date.now();
        if (now - this.lastPlayerMsg < PLAYER_QUIET_MS) {
            this.idlePractice.markBusy();
            return;   // fix31: no fixed task cooldown (fix75: and no error backoff, see _onStepError)
        }
        if (!this.agent.isIdle() || this.agent.self_prompter.isActive() || this.agent.prompter.awaiting_coding) {
            this.idlePractice.markBusy();
            return;
        }
        // SkillWeaver-style: track idle state for practice opportunities
        this.idlePractice.markIdle();
        // fix33: quota check removed; CodeModel handles paid→free fallback internally
        this.running = true; this.abort = false;
        const c0 = { ...CALLS };
        this.step().then(() => { this._lastStepErrSig = null; }, e => this._onStepError(e)).catch(err => this.agent.fatal('prompt overflow and decomposition is impossible', err)).finally(() => { this.running = false; this.lastTaskEnd = Date.now(); this.idlePractice.markBusy();
            console.log(`[timing] step model calls: local ${CALLS.local - c0.local}, code ${CALLS.code - c0.code}, replay ${CALLS.replay - c0.replay}`); });
    }

    // The task a code or curriculum overflow can be broken into. The step's task, otherwise the latest failed task.
    _overflowTask() {
        if (typeof this.currentTask === 'string' && this.currentTask.length > 0) return this.currentTask;
        if (!this.progress || !Object.hasOwn(this.progress, 'failed')) return null;
        const failed = this.progress.failed;
        if (!Array.isArray(failed)) throw new Error(`[fix97] progress.failed must be an array, got ${JSON.stringify(failed)}`);
        if (failed.length === 0) return null;
        const last = failed[failed.length - 1];
        if (typeof last !== 'string' || last.length === 0) throw new Error(`[fix97] progress.failed entry is not a task: ${JSON.stringify(last)}`);
        return last;
    }

    // The prompt inputs a context block was measured against: every skill (code and contract) and the built-in signatures.
    // Live inventory is not hashed. It changes every step, and the block would never stick.
    _contextInputsHash() {
        if (!Array.isArray(this.skills)) throw new Error('[fix97] context block hash needs this.skills');
        const parts = this.skills.map(s => {
            if (!s || typeof s.name !== 'string') throw new Error('[fix97] context block hash: skill has no name');
            return `${s.name}:${this._skillHash(s)}:${s.demoted === true ? 'demoted' : 'live'}`;
        }).sort();
        return `${parts.join(';')}|${this._apiSignature()}`;
    }
    // A task whose prompt does not fit stays blocked while the skill library and the measured size are the same.
    // A different hash is a different prompt: the old row is dropped and the next overflow is measured again.
    _contextBlockReason(task) {
        if (typeof task !== 'string' || task.length === 0) throw new Error(`[fix97] context block lookup needs a task, got ${JSON.stringify(task)}`);
        if (!this.progress || typeof this.progress !== 'object') throw new Error('[fix97] progress required');
        if (!Object.hasOwn(this.progress, 'contextBlocked')) return null;
        const map = this.progress.contextBlocked;
        if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new Error(`[fix97] progress.contextBlocked must be an object, got ${JSON.stringify(map)}`);
        if (!Object.hasOwn(map, task)) return null;
        const row = map[task];
        const hash = this._contextInputsHash();
        if (!row || typeof row.inputHash !== 'string' || row.inputHash !== hash) {
            delete map[task];
            console.error(`!!! [voyager] LOUD: "${task}" context block does not match the current skill library (${hash}). It is measured again. ${JSON.stringify(row)}`);
            return null;
        }
        if (!Number.isInteger(row.requestTokens) || !Number.isInteger(row.contextTokens)) throw new Error(`[fix97] contextBlocked[${JSON.stringify(task)}] has no token counts: ${JSON.stringify(row)}`);
        const reply = Number.isInteger(row.replyTokens) ? `, reply ${row.replyTokens} tokens` : '';
        return `blocked by context size (prompt ${row.requestTokens} tokens${reply}, context ${row.contextTokens} tokens; inputs ${row.inputHash})`;
    }
    _blockTaskForContext(task, err) {
        const counts = Voyager.contextTokenCounts(err);
        if (!this.progress || typeof this.progress !== 'object') throw new Error('[fix97] progress required');
        if (!Object.hasOwn(this.progress, 'contextBlocked')) this.progress.contextBlocked = {};
        if (this.progress.contextBlocked === null || typeof this.progress.contextBlocked !== 'object' || Array.isArray(this.progress.contextBlocked)) throw new Error(`[fix97] progress.contextBlocked must be an object, got ${JSON.stringify(this.progress.contextBlocked)}`);
        const inputHash = this._contextInputsHash();
        const row = { inputHash, requestTokens: counts.requestTokens, contextTokens: counts.contextTokens, key: `${inputHash}:${counts.requestTokens}:${counts.contextTokens}:${counts.replyTokens === null ? '' : counts.replyTokens}` };
        if (counts.replyTokens !== null) row.replyTokens = counts.replyTokens;
        this.progress.contextBlocked[task] = row;
        if (Array.isArray(this.progress.subgoals)) this.progress.subgoals = this.progress.subgoals.filter(s => !s || s.task !== task);
        if (!Array.isArray(this.progress.failed)) throw new Error('[fix97] progress.failed must be an array');
        const note = `${task} (blocked by context size: prompt ${counts.requestTokens} tokens, context ${counts.contextTokens} tokens)`;
        if (!this.progress.failed.includes(note)) this.progress.failed.push(note);
        this._saveProgress();
        const reply = counts.replyTokens === null ? '' : `, reply ${counts.replyTokens} tokens`;
        console.error(`!!! [voyager] LOUD: "${task}" blocked by context size: prompt ${counts.requestTokens} tokens${reply}, context ${counts.contextTokens} tokens. Only this task fails. It stays blocked while the skill library and this measurement are unchanged, and it is measured again when they change. num_ctx is not raised. ${err.message}`);
    }

    // fix75: a step that throws is our bug. fix31 (f850a88) answered it with an exponential backoff scaled by the failing step's
    // duration, during which update() ran no step at all: the 14:25:37Z step (364 s, a 5-minute action timeout that
    // _interruptReason could not explain) bought 728 s of nothing, and icefox was slain by Red Figure at (-161,7,-15) at
    // 14:28Z with no step running (next step 14:37:45Z). Now: log it loudly and go on to the next step at once. The same
    // signature on two consecutive steps is a repeat by definition (the step after the failure, on a fresh state, hit the
    // same throw at the same place), so the loop cannot make progress past it: agent.fatal, and launchd restarts the
    // process where the restart is visible.
    async _onStepError(e) {
        // fix97: a code or curriculum prompt that does not fit the context is decomposed. num_ctx is not raised.
        //        Decomposition that cannot run (no task, or the plan and the model both refuse) throws: the step
        //        handler exits on that, it does not swallow the overflow and repeat it.
        if (e instanceof Error && e.code === CONTEXT_FULL) {
            const task = typeof e.decomposeTask === 'string' && e.decomposeTask.length > 0 ? e.decomposeTask : this._overflowTask();
            if (typeof task !== 'string' || task.length === 0) throw e;
            if (this._contextBlockReason(task) !== null) {
                console.error(`!!! [voyager] LOUD: "${task}" is already blocked by context size; not retried. ${e.message}`);
                return;
            }
            if (this._inOverflowDecompose) {
                this._blockTaskForContext(task, e);
                return;
            }
            this._inOverflowDecompose = true;
            try {
                const ok = await this._decompose(task, e.message);
                if (ok === true) {
                    console.error(`!!! [voyager] prompt does not fit (${e.message}). Decomposed "${task}" instead of repeating the step. num_ctx is not raised.`);
                    return;
                }
                if (ok !== false) throw new Error(`[fix97] _decompose returned ${JSON.stringify(ok)}; expected true or false`);
                this._blockTaskForContext(task, e);
            } catch (err) {
                if (err instanceof Error && err.code === CONTEXT_FULL) {
                    this._blockTaskForContext(task, err);
                    return;
                }
                throw err;
            } finally {
                this._inOverflowDecompose = false;
            }
            return;
        }
        const sig = stepErrorSignature(e);
        console.error(`!!! [voyager] step failed: ${sig}`);
        console.error('[voyager] stack:', e instanceof Error ? e.stack : `(non-Error thrown: ${typeof e})`);
        if (sig === this._lastStepErrSig) return this.agent.fatal(`the same step error on two consecutive steps (${sig})`, e);
        this._lastStepErrSig = sig;
    }

    observe() {
        const bot = this.agent.bot;
        const p = bot.entity.position;
        const dTown = Math.round(Math.hypot(p.x - TOWN.x, p.z - TOWN.z));
        const t = bot.time.timeOfDay;
        // fix38: add inventory_slots as N/36 plain fact
        const usedSlots = bot.inventory.items().length;
        const totalSlots = 36;
        const emptySlots = bot.inventory.emptySlotCount();
        const seen = world.getNearbyBlocks(bot);
        const nearbyBlocks = [];
        const perceivedAt = {};
        for (const b of seen) {
            if (!nearbyBlocks.includes(b.name)) nearbyBlocks.push(b.name);
            perceivedAt[b.name] = { x: b.x, y: b.y, z: b.z };
        }
        return {
            position: `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`,
            distance_to_town: dTown,
            biome: world.getBiomeName(bot),
            time: t < 12000 ? `day (${t})` : t < 13000 ? `dusk (${t}, hostiles about to spawn)` : t < 23000 ? `night (${t}, hostiles spawn outdoors)` : `dawn (${t})`,
            // fix46: use shared VITALS_MAX from skills.js (same source as log())
            health: `${Math.round(bot.health)}/${skills.VITALS_MAX.health}`, food: `${bot.food}/${skills.VITALS_MAX.food}`,
            // fix45: expose food/health as plain numeric facts for planner/curriculum to pick restore goals
            food_value: bot.food,
            food_max: skills.VITALS_MAX.food,
            health_value: Math.round(bot.health),
            health_max: skills.VITALS_MAX.health,
            alive: bot.health > 0,
            dimension: bot.game.dimension,
            // fix58: learned: hp below max and not recovering at the current food level (from the bot's own vitals history)
            health_recovery_blocked: this._recovery().blocked,
            // fix76: learned hunger (food vs regen floor / decay) — fires at full HP; not a hard-coded eat threshold
            hunger_urgent: this._hunger().urgent,
            food_below_regen_floor: this._hunger().belowRegen,
            // fix51: oxygen level as protocol value (300 = full breath, decreases when submerged, 0 = drowning damage)
            oxygen_level: bot.oxygenLevel,
            inventory: world.getInventoryCounts(bot),  // fix41: host code uses world. prefix
            inventory_slots: `${usedSlots}/${totalSlots}`,
            empty_inventory_slots: emptySlots,
            // fix38: full equipment (6 slots, not just held item)
            equipment: {
                hand: bot.heldItem ? bot.heldItem.name : 'empty',
                off_hand: bot.inventory.slots[45] ? bot.inventory.slots[45].name : 'empty',
                head: bot.inventory.slots[5] ? bot.inventory.slots[5].name : 'empty',
                torso: bot.inventory.slots[6] ? bot.inventory.slots[6].name : 'empty',
                legs: bot.inventory.slots[7] ? bot.inventory.slots[7].name : 'empty',
                feet: bot.inventory.slots[8] ? bot.inventory.slots[8].name : 'empty',
            },
            nearby_blocks: nearbyBlocks,
            perceived_at: perceivedAt,
            perception: world.perceivedStats(bot).indexNote,
            nearby_entities: world.getNearbyEntityTypes(bot),
            known_chests: this._getChestFacts(),
            threats: this._threats(),
            recent_deaths: (this.agent.recentDeaths || []).join('; ') || 'none',
            death_hotspots: this._deathHotspots(),
        };
    }
    // fix51: get inventory+equipment combined view (same as satisfaction check uses for __have)
    _getInventoryWithEquipment() {
        // fix51: getInventoryCounts reads slots 5..45, which already include armour (5-8), hotbar/held (36-44) and off-hand (45)
        return world.getInventoryCounts(this.agent.bot);
    }
    // fix19 (6): places where the bot died 2+ times (16-block cells): a problem for the curriculum to learn to handle, no reflex
    _deathHotspots() {
        const hs = Object.values(this.progress.deathSpots || {}).filter(c => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3);
        return hs.length ? hs.map(c => `${c.pos} (${c.n} deaths)`).join(' | ') : 'none';   // fix28: positions only, no push
    }
    _noteDeath(d, task) {
        const [x, y, z] = d.pos.split(',').map(Number), k = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
        const c = ((this.progress.deathSpots ||= {})[k] ||= { n: 0, pos: d.pos, causes: [], tasks: [] });
        c.n++; c.last = Date.now(); c.times = [...(c.times || []), c.last].slice(-20); c.pos = d.pos; c.causes = [...c.causes, d.message].slice(-5); c.tasks = [...c.tasks, task].slice(-5); this._saveProgress();
        // fix51: pass beforeInv for items-dropped reporting
        console.log(`[psn] death during "${task}": ${d.message} at ${d.pos}${this._deathDetail(d, this._beforeRunInv)} (death #${c.n} in this area)${c.n >= 2 ? '; surfaced to the curriculum as a death hotspot' : ''}`);
    }
    // fix18: perception only (no policy): hostiles within 32 blocks, nearest first
    _threats() {
        const bot = this.agent.bot, p = bot.entity.position;
        const hs = Object.values(bot.entities).filter(e => e !== bot.entity && (isHostile(e) || isDatapackHostile(e)) && e.position.distanceTo(p) < 32)
            .map(e => `${isDatapackHostile(e) ? 'DATAPACK ' : ''}${e.name || e.username} ${e.position.distanceTo(p).toFixed(0)}m`);
        return hs.length ? hs.slice(0, 6).join(', ') : 'none';
    }
    // fix38: Chest memory - track seen chests and their contents (learned path)
    _setupChestTracking() {
        const bot = this.agent.bot;
        if (!bot) return;
        bot.on('blockUpdate', (oldBlock, newBlock) => {
            if (newBlock?.name === 'chest' || newBlock?.name === 'trapped_chest' || newBlock?.name === 'barrel') {
                const pos = newBlock.position;
                const key = `${pos.x},${pos.y},${pos.z}`;
                if (!this.chestMemory[key]) {
                    this.chestMemory[key] = { type: newBlock.name, contents: 'Unknown', firstSeen: Date.now() };
                    this._saveChestMemory();
                    console.log(`[chest] detected ${newBlock.name} at ${key}`);
                }
            }
        });
        bot.on('windowOpen', (window) => {
            if (!window || !window.title) return;
            const title = typeof window.title === 'string' ? window.title : JSON.stringify(window.title);
            if (!title.toLowerCase().includes('chest') && !title.toLowerCase().includes('barrel')) return;
            const nearestChest = getNearestBlock(bot, b => b.name === 'chest' || b.name === 'trapped_chest' || b.name === 'barrel', 6);
            if (!nearestChest) return;
            const pos = nearestChest.position;
            const key = `${pos.x},${pos.y},${pos.z}`;
            setTimeout(() => {
                const items = window.containerItems ? window.containerItems() : [];
                if (items.length === 0) {
                    this.chestMemory[key] = { type: nearestChest.name, contents: 'Empty', lastOpened: Date.now() };
                } else {
                    const counts = {};
                    for (const it of items) { counts[it.name] = (counts[it.name] || 0) + it.count; }
                    const summary = Object.entries(counts).map(([n, c]) => `${n}:${c}`).join(',');   // fix96: every item (it kept 12)
                    this.chestMemory[key] = { type: nearestChest.name, contents: summary, lastOpened: Date.now() };
                }
                this._saveChestMemory();
                console.log(`[chest] opened ${nearestChest.name} at ${key}: ${this.chestMemory[key].contents}`);
            }, 200);
        });
    }
    _saveChestMemory() {
        try { writeAtomic(this.chestMemoryFile, JSON.stringify(this.chestMemory, null, 2)); }
        catch (e) { console.log('[chest] save failed: ' + e.message); }
    }
    _getChestFacts() {
        const result = {};
        const now = Date.now();
        for (const [pos, data] of Object.entries(this.chestMemory)) {
            if (now - (data.lastOpened || data.firstSeen || 0) > 7 * 24 * 60 * 60e3) continue;
            result[pos] = data.contents;
        }
        return result;
    }
    // fix47: compact state format for efficient prompts (one line, critical info only)
    // Includes full inventory as k:v pairs (no slice - hiding items causes bugs like raw_iron:28 invisible).
    // Counts stay in the prompt. A comparison that copies one is rejected against these counts; the counts are not blanked.
    _codeState(s) {
        if (!s || typeof s.inventory !== 'object' || s.inventory === null) throw new Error('[fix97] code state.inventory required');
        if (typeof s.position !== 'string') throw new Error('[fix97] code state.position required');
        if (typeof s.biome !== 'string') throw new Error('[fix97] code state.biome required');
        if (typeof s.time !== 'string') throw new Error('[fix97] code state.time required');
        if (typeof s.health_value !== 'number' || typeof s.health_max !== 'number') throw new Error('[fix97] code state health required');
        if (typeof s.food_value !== 'number' || typeof s.food_max !== 'number') throw new Error('[fix97] code state food required');
        if (typeof s.inventory_slots !== 'string') throw new Error('[fix97] code state.inventory_slots required');
        if (typeof s.empty_inventory_slots !== 'number') throw new Error('[fix97] code state.empty_inventory_slots required');
        if (!s.equipment || typeof s.equipment.hand !== 'string') throw new Error('[fix97] code state.equipment.hand required');
        if (typeof s.threats !== 'string') throw new Error('[fix97] code state.threats required');
        const items = Object.entries(s.inventory).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
        for (const [name, n] of items) if (typeof n !== 'number') throw new Error(`[fix97] code state inventory count of ${name} is not a number`);
        const shown = items.length === 0 ? 'empty' : items.map(([k, v]) => `${k}:${v}`).join(',');
        const held = s.equipment.hand === 'empty' ? '' : ` held:${s.equipment.hand}`;
        return `pos:(${s.position}) biome:${s.biome} time:${s.time.split(' ')[0]} hp:${s.health_value}/${s.health_max} food:${s.food_value}/${s.food_max} inv:${s.inventory_slots},${s.empty_inventory_slots}empty${held} threats:${s.threats} items:[${shown}]`;
    }
    _compactState(s) {
        const inv = s.inventory;
        const items = Object.entries(inv).sort((a, b) => b[1] - a[1]);
        const invSummary = items.length ? items.map(([k, v]) => `${k}:${v}`).join(',') : 'empty';
        const eq = s.equipment;
        const held = eq.hand !== 'empty' ? eq.hand : '';
        return `pos:(${s.position}) biome:${s.biome} time:${(s.time || '').split(' ')[0]} hp:${s.health_value}/${s.health_max} food:${s.food_value}/${s.food_max} inv:${s.inventory_slots},${s.empty_inventory_slots}empty${held ? ` held:${held}` : ''} threats:${s.threats || 'none'} items:[${invSummary}]`;
    }
    _stateText(s) {
        // fix34: present inventory facts prominently as exact counts (not just JSON blob)
        // fix36: facts only, no imperatives (Mo principle: everything learned, not hard-coded)
        // fix37 (D): surface inventory fullness as facts (not rules) with exact counts
        // fix38: add inventory_slots N/36, full equipment, known_chests
        const lines = [];
        const inv = s.inventory || {};
        const emptySlots = s.empty_inventory_slots ?? 0;
        const totalItems = Object.values(inv).reduce((a, b) => a + b, 0);

        for (const [k, v] of Object.entries(s)) {
            if (k === 'inventory' && typeof v === 'object') {
                // Sort by count descending to show largest stacks first (hoarding visibility)
                const items = Object.entries(v).sort((a, b) => b[1] - a[1]).map(([item, count]) => `${item}: ${count}`);
                lines.push(`inventory (exact counts, ${totalItems} total items): ${items.length ? items.join(', ') : '(empty)'}`);
            } else if (k === 'inventory_slots') {
                // fix38: N/36 plain fact
                lines.push(`inventory_slots: ${v}`);
            } else if (k === 'empty_inventory_slots') {
                // fix37 (D): state inventory fullness as a fact, not a rule
                if (v === 0) {
                    lines.push(`empty_inventory_slots: 0 (inventory is full)`);
                } else if (v <= 3) {
                    lines.push(`empty_inventory_slots: ${v} (inventory is nearly full)`);
                } else {
                    lines.push(`empty_inventory_slots: ${v}`);
                }
            } else if (k === 'equipment' && typeof v === 'object') {
                // fix38: full equipment slots
                const eq = Object.entries(v).map(([slot, item]) => `${slot}: ${item}`);
                lines.push(`equipment: ${eq.join(', ')}`);
            } else if (k === 'known_chests' && typeof v === 'object') {
                // fix38: chest memory
                const chests = Object.entries(v).map(([pos, contents]) => `(${pos}): ${contents}`);
                lines.push(`known_chests: ${chests.length ? chests.join('; ') : 'none'}`);
            } else {
                lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
            }
        }
        // ADAM-style: add learned needs/produces facts
        const npFacts = this.npGraph.getFactsText();
        if (npFacts) lines.push('', npFacts);
        return lines.join('\n');
    }
    _local() {
        if (!this.__local) this.__local = new Ollama(LOCAL.model, LOCAL.url, { ...LOCAL.params, keep_alive: this.agent.prompter.profile.model?.params?.keep_alive });
        return this.__local;
    }
    // small local model (Mac Studio Ollama) for curriculum + critic judgment; unloads after 5 min idle
    // fix31: one local request in flight at a time (solo decode speed; Ollama keeps a prefix-cache slot per prompt type)
    _ensureInferCover() {
        if (!this._inferCover) {
            this._inferCover = createInferenceCover({
                start: (callNum) => this._startIdlePractice(callNum),
                stop: () => this._stopIdlePractice(),
            });
        }
        return this._inferCover;
    }
    _inferMeta(kind, parts) {
        if (typeof kind !== 'string' || kind.length === 0) throw new Error('[fix93] inference kind required');
        if (parts === null || parts === undefined || typeof parts !== 'object') throw new Error('[fix93] prompt components required');
        const components = {};
        for (const [k, v] of Object.entries(parts)) {
            if (typeof v !== 'string') throw new Error(`[fix93] prompt component ${k} is not text`);
            components[k] = v.length;
        }
        return { kind, components };
    }
    async _askLocal(system, user, meta) {
        if (!meta || typeof meta.kind !== 'string' || meta.kind.length === 0) throw new Error('[fix93] _askLocal requires { kind, components }');
        CALLS.local++;
        meta.requestId = `${meta.kind}#${CALLS.local}`;
        const prev = this._localQ || Promise.resolve(); let release; this._localQ = new Promise(r => release = r);
        const tq = Date.now(); await prev; const waited = Date.now() - tq; if (waited > 500) console.log(`[timing] local call waited ${waited}ms for the previous local call`);
        const cover = this._ensureInferCover();
        cover.enter(CALLS.local);
        let r; const t0 = Date.now();
        try { r = await this._local().sendRequest([{ role: 'user', content: user }], system, meta); }
        finally {
            try { await cover.leave(); }
            finally { release(); }
        }
        console.log(`[timing] ${new Date().toISOString().slice(11,19)}Z local call #${CALLS.local} took ${Date.now() - t0}ms kind=${meta.kind}`);
        console.log(`[voyager] local model call #${CALLS.local}`);
        return r;
    }
    _cursorLimited() { const cm = this.agent.prompter.code_model; return !cm.fallback && Date.now() < (cm.quotaUntil || 0); }   // fix33: fallback configured = not limited
    // find a saved skill that can be replayed without any model call
    // fix56: structured routes (exact name/task identity, parsed kill/harvest/mine/craft/travel/smelt) first, then lexical word overlap
    _findReplay(task) { return this._structuredReplay(task) || this._lexicalReplay(task); }
    _structuredReplay(task) {
        // fix41: exact skill name or exact task match FIRST, including primitives (tossClutter/tossItem/depositToChest)
        const taskLower = task.toLowerCase().trim();
        for (const s of this.skills) {
            if (s.demoted || s.mergedInto) continue;
            // exact name match (case-insensitive)
            if (s.name.toLowerCase() === taskLower || (s.task && s.task.toLowerCase().trim() === taskLower)) {
                // fix86: a bare `await craftItem(bot)` leaves the item undefined ("Craft N of an item"). Skip it;
                //        a parsed route supplies the arguments, and a bare call that still lacks them throws in _replay.
                if (requiredArgs(s).length) continue;
                return { name: s.name, call: `await ${s.name}(bot);` };
            }
        }
        const goal = countGoal(task);
        const has = n => this.skills.some(s => s.name === n && !s.demoted);
        const kill = task.match(/^(?:kill|hunt|slay|fight)\s+(\d+)\s+([a-z_]+?)s?\b/i);
        if (kill && has('killMob')) return { name: 'killMob', call: `await killMob(bot, ${JSON.stringify(kill[2].toLowerCase())}, ${kill[1]});`, check: 'output' };
        const harv = task.match(/^harvest\s+(\d+)\s+([a-z_]+)/i);
        if (harv && has('harvestCrop')) return { name: 'harvestCrop', call: `await harvestCrop(bot, ${JSON.stringify(harv[2].toLowerCase())}, ${harv[1]});`, check: 'output' };
        if (goal && ['mine', 'collect', 'gather', 'chop'].includes(goal.verb) && /(_ore|^stone|^cobblestone|^deepslate)$/.test(goal.item) && has('mineOre'))
            return { name: 'mineOre', call: `await mineOre(bot, ${JSON.stringify(goal.item)}, ${goal.count});` };
        if (goal && ['mine', 'collect', 'gather', 'chop'].includes(goal.verb) && goal.item.endsWith('_log') && has('collectLogs'))
            return { name: 'collectLogs', call: `await collectLogs(bot, ${goal.count}, ${JSON.stringify(goal.item)});` };
        if (goal && ['get', 'obtain'].includes(goal.verb) && has('obtainItem') && this._routeProducesFit('obtainItem', [goal.item]))
            return { name: 'obtainItem', call: `await obtainItem(bot, ${JSON.stringify(goal.item)}, ${goal.count});` };
        if (goal && ['mine', 'collect', 'gather', 'chop'].includes(goal.verb) && this.skills.some(s => s.name === 'mineBlocks') && this._routeProducesFit('mineBlocks', [goal.item]))
            return { name: 'mineBlocks', call: `await mineBlocks(bot, ${JSON.stringify(goal.item)}, ${goal.count});` };
        if (goal && ['craft', 'get', 'make'].includes(goal.verb) && goal.item === 'torch' && has('craftTorches'))
            return { name: 'craftTorches', call: `await craftTorches(bot, ${goal.count});` };
        if (goal && goal.verb === 'craft' && this.skills.some(s => s.name === 'craftItem'))
            return { name: 'craftItem', call: `await craftItem(bot, ${JSON.stringify(goal.item)}, ${goal.count});` };
        const go = task.match(/^(?:go|return|travel|walk|head)\b[^(]*?x\s*=\s*(-?\d+)[,\s]+y\s*=\s*(-?\d+)[,\s]+z\s*=\s*(-?\d+)/i);
        if (go && this.skills.some(s => s.name === 'travelTo'))
            return { name: 'travelTo', call: `await travelTo(bot, ${go[1]}, ${go[2]}, ${go[3]});`, at: { x: +go[1], z: +go[3] } };
        const sm = smeltGoal(task);
        if (sm && has('smeltWithFuel'))
            return { name: 'smeltWithFuel', call: `await smeltWithFuel(bot, ${JSON.stringify(sm.input)}, ${sm.count});` };
        if (sm && this.skills.some(s => s.name === 'smeltItems'))
            return { name: 'smeltItems', call: `await smeltItems(bot, ${JSON.stringify(sm.input)}, ${sm.count});` };
        return null;
    }
    // fix56: lexical word-overlap routing. Any two task heads without digits/ids are "comparable" and 0.3*rate is always > 0,
    // so this returns the best-rated unrelated skill when nothing matches (live: "Explore for iron ore deposit" -> ensureFurnaceInRange).
    // Item goals still use it (they are verified by inventory gain); open goals never do (see _step).
    _lexicalReplay(task) {
        const nums = t => (t.match(/\d+/g) || []).join(',');
        const ids = t => (t.toLowerCase().match(/\b[a-z]+(?:_[a-z]+)+\b/g) || []).sort().join(',');
        const head = t => t.split(/\s+(?:within|at|in|on|using|from|near|and)\b/i)[0].trim().toLowerCase();
        let best = null, bestScore = 0;
        for (const s of this.skills) {
            if (s.primitive || s.demoted || s.mergedInto || !s.task) continue;
            if (head(s.task) !== head(task) && !(nums(head(s.task)) === nums(head(task)) && ids(head(s.task)) === ids(head(task)))) continue;
            const nameHit = s.name.toLowerCase().split(/(?=[a-z])/).length && task.toLowerCase().replace(/[^a-z]/g, '').includes(s.name.toLowerCase().replace(/^(craft|mine|get|make)/, '')) ? 0.3 : 0;
            const sc = wordOverlapScore(task, s.task) + nameHit + 0.3 * rate(s.stats || newStats());
            if (sc > bestScore) { best = s; bestScore = sc; }
        }
        return best ? { name: best.name, call: `await ${best.name}(bot);` } : null;
    }
    // fix28 (D): nearest learned skill by nomic-embed-text over its description; the match threshold is learned from replay outcomes
    // fix41: allow important primitives (tossClutter, tossItem, depositToChest) in embedding replay
    async _embedReplay(task) {
        const th = this.progress.replayThreshold ??= 0.85;
        const q = await this._embed(task);
        let best = null, bs = -1;
        const g = this._resolveGoal(task);
        const goalItems = g.kind === 'item' ? (g.items || [g.item]) : g.kind === 'ensure' || g.kind === 'reach' ? [g.item] : [];
        const IMPORTANT_PRIMITIVES = new Set(['tossClutter', 'tossItem', 'depositToChest']);
        for (const s of this.skills) {
            // fix41: allow important primitives (inventory freeing skills) even if s.primitive is true
            if (s.demoted || s.mergedInto || !s.task || /^(repair|refactor)\b/.test(s.task)) continue;
            if (s.primitive && !IMPORTANT_PRIMITIVES.has(s.name)) continue;
            if (goalItems.length && !this._routeProducesFit(s.name, goalItems)) continue;
            const extra = (signatureOf(s.code, s.name).match(/\(([^)]*)\)/)?.[1] || '').split(',').slice(1).map(x => x.trim()).filter(Boolean);
            if (extra.some(x => !x.includes('='))) continue;   // needs arguments it cannot get from the task text
            if (!s.embedding || s.embedding.length !== q.length) continue;
            const sc = cosineSimilarity(q, s.embedding) * (0.7 + 0.3 * rate(s.stats || newStats()));
            if (sc > bs) { bs = sc; best = s; }
        }
        console.log(`[replay] embedding match for "${task}": ${best ? `${best.name} score ${bs.toFixed(3)}` : 'none'} (learned threshold ${th.toFixed(3)})${best && bs >= th ? ' -> replaying' : ' -> code model'}`);
        return best && bs >= th ? { name: best.name, call: `await ${best.name}(bot);`, embed: bs } : null;
    }
    _learnReplayThreshold(rp) {
        if (!rp || rp.interrupted || rp.unverified) return;   // fix56: an unverifiable post says nothing about routing
        const P = this.progress, old = P.replayThreshold; P.replayThreshold = Math.min(0.99, Math.max(0.6, old + (rp.ok ? -0.01 : 0.02))); this._saveProgress();
        console.log(`[replay] embedding replay ${rp.ok ? 'passed' : 'failed'}; threshold ${old.toFixed(3)} -> ${P.replayThreshold.toFixed(3)}`);
    }
    // SkillCompiler-style effect contract for a route: what must hold before (pre) and what must change after (post)
    _contract(r) {
        let args = []; try { args = JSON.parse('[' + (r.call.match(/\(bot(?:,\s*(.*))?\);?$/)?.[1] || '') + ']'); } catch (e) {}
        const [a0, a1] = args;
        switch (r.name) {
            case 'craftItem': case 'craftTorches': { const item = r.name === 'craftTorches' ? 'torch' : a0; return { item, count: (r.name === 'craftTorches' ? a0 : a1) || 1, pre: 'recipe' }; }
            case 'mineOre': case 'collectLogs': return { item: r.name === 'collectLogs' ? (a1 || 'any _log') : a0, count: r.name === 'collectLogs' ? a0 : a1, pre: 'block' };
            case 'killMob': return { mob: a0, count: a1 || 1, pre: 'mob' };
            case 'smeltWithFuel': return { input: a0, count: a1 || 1, pre: 'input' };
            default: return null;
        }
    }
    // Skill-V-style applicability precheck: is the route even runnable from the current state?
    // fix49: VERSION must be set (fail loud, no fallback)
    _precheck(r) {
        const c = this._contract(r); if (!c) return { ok: true };
        if (!VERSION) throw new Error(`[fix49] LOUD FAIL: _precheck called but VERSION is null`);
        const bot = this.agent.bot, inv = this.observe().inventory;
        try {
            if (c.pre === 'recipe') {
                if (typeof c.item !== 'string' || c.item === '') throw new Error(`[fix86] LOUD: ${r.name} routed with no item (${r.call}); a subgoal cannot call a skill with an undefined item`);
                const md = minecraftData(VERSION); const it = md.itemsByName[c.item];
                if (!it) return { ok: false, why: `unknown item ${c.item}` };
                const table = bot.findBlock({ matching: md.blocksByName.crafting_table.id, maxDistance: 32 });
                const can = bot.recipesFor(it.id, null, 1, table).length > 0;
                return can ? { ok: true } : { ok: false, why: `missing ingredients for ${c.item}${table ? '' : ' (no crafting table within 32)'}` , reroute: 'obtainItem', item: c.item, count: c.count };
            }
            if (c.pre === 'block') {
                if (c.item.startsWith('any')) return { ok: true };
                const md = minecraftData(VERSION); const b = md.blocksByName[c.item];
                if (!b) return { ok: false, why: `unknown block ${c.item}` };
                const names = [c.item];
                const deep = 'deepslate_' + c.item;
                if (Object.hasOwn(md.blocksByName, deep)) names.push(deep);
                const ids = names.map(n => md.blocksByName[n].id);
                if (bot.findBlock({ matching: ids, maxDistance: 64 })) return { ok: true };
                const need = reachNeedForBlocks(md.blocksByName, names, c.count);
                if (need === null) throw new Error(`[fix87] LOUD: ${c.item} is not a block in the game data`);
                return { ok: false, why: `no ${c.item} within 64 blocks`, need };
            }
            if (c.pre === 'mob') return Object.values(bot.entities).some(e => e.name === c.mob && e.position.distanceTo(bot.entity.position) <= 48) ? { ok: true } : { ok: false, why: `no ${c.mob} within 48 blocks` };
            if (c.pre === 'input') return (inv[c.input] || 0) > 0 ? { ok: true } : { ok: false, why: `no ${c.input} in inventory` };
        } catch (e) {
            if (e instanceof Error && e.message.startsWith('[fix87]')) throw e;
            return { ok: false, why: `precheck error ${e.message}` };
        }
        return { ok: true };
    }
    // fix79: what a skill is learned to produce: its measured effects (recordEffectEvidence, fix74), its candidate's, and the
    //        needs/produces links confirmed for it. Absent from all three = no evidence it produces the item.
    _learnedProduces(e) {
        if (!Array.isArray(e.effects)) throw new Error(`[fix79] _learnedProduces: skill ${e.name} has no effects record (${JSON.stringify(e.effects)})`);
        if (e.candidate && !Array.isArray(e.candidate.effects)) throw new Error(`[fix79] _learnedProduces: candidate of ${e.name} has no effects record`);
        return [...new Set([...e.effects, ...(e.candidate ? e.candidate.effects : []), ...this.npGraph.confirmedProduces(e.name)])];
    }
    // fix79: route evidence for an item goal on a route that is not parametrised by the goal (a bare `name(bot)` call; a
    //        parsed-contract route such as mineOre(bot, item, n) carries its item in its own contract). fits = the skill is
    //        learned to produce one of the goal items.
    // fix86: a route to an item goal is a misroute when the skill's learned produces are non-empty and disjoint.
    //        Empty produces is no evidence (the route may still be right). obtainItem and mineBlocks were routed on the verb alone.
    _routeProducesFit(name, items) {
        const e = this.skills.find(s => s.name === name && !s.demoted);
        if (!e || !Array.isArray(e.effects)) return true;
        const fromGraph = this.npGraph ? this.npGraph.confirmedProduces(e.name) : [];
        const extra = e.candidate && Array.isArray(e.candidate.effects) ? e.candidate.effects : [];
        const produces = [...new Set([...e.effects, ...extra, ...fromGraph])];
        if (!produces.length) return true;
        if (items.some(i => produces.includes(i))) return true;
        console.log(`[fix86] ${name} learned produces [${produces.join(', ')}] do not include [${items.join(', ')}]`);
        return false;
    }
    _routeFit(e, goalItems) {
        if (!Array.isArray(goalItems) || !goalItems.length) throw new Error(`[fix79] _routeFit needs goal items, got ${JSON.stringify(goalItems)}`);
        const produces = this._learnedProduces(e);
        return { skill: e.name, items: goalItems, produces, fits: produces.some(i => goalItems.includes(i)) };
    }
    // fix44 gate as one predicate (used by _replay and by _gateTrial's route choice, fix79): a candidate is trialled on a goal
    // only if its learned effects overlap the goal items (any non-item goal: no items to overlap, so it runs)
    _candidateFitsGoal(entry, goalItems) {
        if (!Array.isArray(entry.candidate.effects)) throw new Error(`[fix79] candidate of ${entry.name} has no effects record`);
        return goalItems.length === 0 || entry.candidate.effects.some(eff => goalItems.includes(eff));
    }
    async _replay(task, before, forced) {
        let r = forced || this._findReplay(task);
        if (!r) return null;
        const pc = this._precheck(r);
        const ct = this._contract(r);
        if (ct) console.log(`[contract] ${r.name}: pre=${ct.pre} post=${ct.item ? '+' + (ct.count || 1) + ' ' + ct.item : ct.mob ? 'killed ' + ct.mob : 'smelted ' + ct.input}`);
        if (!pc.ok) {
            // fix100: a failed craft used to reroute to obtainItem with no learned evidence it produces the goal
            // (bread's edge had failed 15/15). That shipped the bundle on every later step. Reroute only when the
            // target is learned to produce the goal item; otherwise report the unmet need, same as a reach precheck.
            const rerouteTo = pc.reroute && r.name !== pc.reroute ? this.skills.find(s => s.name === pc.reroute && !s.demoted) : null;
            if (rerouteTo && this._routeFit(rerouteTo, [pc.item]).fits) {
                console.log(`[skillv] precheck ${r.name}: not applicable (${pc.why}); rerouting to ${pc.reroute} to fetch prerequisites`);
                r = { name: pc.reroute, call: `await ${pc.reroute}(bot, ${JSON.stringify(pc.item)}, ${pc.count});` };
            } else if (rerouteTo) {
                console.error(`!!! [fix87] LOUD: ${r.name}: ${pc.why}; ${pc.reroute} has no learned evidence it produces ${pc.item}; reporting the unmet need instead of rerouting`);
                return { ok: false, name: r.name, output: '', reason: pc.why, needs: [this._checkNeed({ item: pc.item, count: pc.count, reason: 'ingredients' }, pc.why)] };
            } else if (pc.need) {
                // fix87: "no <block> within search range" is a reach need. Returning null here used to skip the chain
                // and write new code, so a log that is not nearby never became "reach <log block>".
                console.error(`!!! [fix87] LOUD: ${r.name}: ${pc.why}; reporting a reach need instead of writing new code`);
                return { ok: false, name: r.name, output: '', reason: pc.why, needs: [this._checkNeed(pc.need, pc.why)] };
            } else { console.log(`[skillv] precheck ${r.name}: not applicable (${pc.why}); skipping replay, writing code instead`); return null; }
        } else if (ct) console.log(`[skillv] precheck ${r.name}: applicable`);
        // fix55: one goal resolver; item/smelt goals are verified by gain, ensure by placement, skill/open goals by a learned post-contract
        const g = this._resolveGoal(task);
        if (g.kind === 'invalid') { console.log(`[fix55] LOUD: not replaying ${r.name} for invalid goal "${task}": ${g.why}`); return { ok: false, name: r.name, output: '', reason: `invalid goal: ${g.why}` }; }
        const goal = g.kind === 'item' ? g : null;
        CALLS.replay++;
        console.log(`[voyager] REPLAY skill ${r.name} for "${task}" (no code model)`);
        const entry = this.skills.find(s => s.name === r.name);
        if (entry) {
            const supplied = Voyager._callArgs(r.call);
            const req = requiredArgs(entry);
            if (supplied.length < req.length) throw new Error(`[fix86] LOUD: ${entry.name} requires ${req.join(', ')} after bot but ${r.call} passes ${supplied.length}`);
        }
        // fix44: gate trials only when candidate effects overlap with task goal
        // Prevents trialing e.g. craftIronHelmet on an iron_pickaxe goal (wastes ingots, wrong outcome)
        let trial = false;
        if (entry?.candidate) {
            const candidateEffects = entry.candidate.effects;   // fix74: every candidate is created with effects (saveSkill HOLD, fix25 migrate; checked at load)
            const goalItems = goal?.items || (goal?.item ? [goal.item] : []);
            const effectsOverlap = this._candidateFitsGoal(entry, goalItems);
            if (effectsOverlap) {
                trial = true;
                gateLog(`trial run of candidate ${r.name} (candidate ${entry.candidate.stats.success}/${entry.candidate.stats.success + entry.candidate.stats.fail}, current ${entry.stats?.success || 0}/${(entry.stats?.success || 0) + (entry.stats?.fail || 0)})`);
            } else {
                gateLog(`SKIP trial of candidate ${r.name}: effects [${candidateEffects.join(', ')}] do not overlap goal [${goalItems.join(', ')}]`);
            }
        }
        // fix79: a dedicated gate trial exists only to run the candidate. #30's gate above used to fall through to the INCUMBENT
        //        when the candidate did not fit, and the incumbent took the run's stats and blame (live: scanForIronOreBlocks on
        //        "Mine 1 diamond_ore", 85x). _gateTrial now checks the same predicate first, so reaching here is a bug.
        if (forced?.dedicatedTrial && !trial) throw new Error(`[fix79] dedicated trial of ${r.name} on "${task}" would run the incumbent: candidate does not fit the goal`);
        // fix79: route evidence for an item goal verified by gain on a bare-call route
        // fix86: ensure and reach goals are the same kind of bare route (ensureFurnaceWithinSixteen on a collect path)
        const routeItems = g.kind === 'item' ? goal.items : (g.kind === 'ensure' || g.kind === 'reach' ? [g.item] : []);
        const bareRoute = routeItems.length > 0 && !r.free && !r.at && !this._contract(r);
        if (bareRoute && !entry) throw new Error(`[fix79] item goal "${task}" routed to ${r.name}, which is not in the skill library`);
        const routeFit = bareRoute ? this._routeFit(entry, routeItems) : null;
        if (routeFit && !routeFit.fits) console.log(`!!! [route] ${r.name} routed to "${task}" with no learned evidence it produces [${routeFit.items.join(', ')}] (learned produces [${routeFit.produces.join(', ')}])`);
        // fix65: the goal-overlap gate above (#30) decides the ROOT's own candidate only. #30 also AND-ed it into the children,
        // so a child candidate ran only when the replayed root had a candidate of its own: replays (the common path) never
        // ran the 09:37Z collectBlock candidate, its 0/0 record never moved, and every repair of collectBlock was deferred
        // "a candidate is already under trial" and DROPPED. A child candidate is exercised by the root's real calls for this
        // task, so it is trialled in place whenever it is in the closure (fix10's rule).
        // fix76: learned food-raiser already at observed food cap — do not run (would raise a saturated vital); not evidence
        {
            const sat = this._foodRaiseSaturated(r.name, this.agent.bot.food);
            if (sat) {
                console.log(`!!! [blame] UNMET PRECONDITION (${sat}): skip replay of ${r.name} — not counted against stats or gate`);
                return { ok: false, name: r.name, output: '', unmetPrecondition: sat, unverified: true };
            }
        }
        const { closure: replayClosure, over, rejected } = this._trialClosure(r.name, trial);
        if (rejected.has(r.name)) {
            // fix87: the root candidate dropped the need marker and was rejected. A dedicated trial must not run the
            // incumbent in its place (that would charge the incumbent). A caller's replay runs the incumbent.
            const why = rejected.get(r.name);
            if (forced?.dedicatedTrial) return { ok: false, name: r.name, output: '', unverified: true, reason: `candidate rejected: ${why}` };
            trial = false;
        }
        const tracedNames = Voyager._tracedSkillNamesForInstrument(this, replayClosure, over);
        const libPart = this._libSrcSubset(replayClosure, over);
        const call = '\n\nasync function __replay(bot) {\n    try { ' + r.call + ' } finally { bot.__psnOut = bot.output; }\n}\nawait __replay(bot);';
        const full = libPart + '\n\n' + instrumentSrc(tracedNames) + call;
        const { lint, staged } = await this._stageLintExecTraced(libPart + call, full, replayClosure, `voyager:replay:${r.name}`);
        if (lint) { console.error(`[voyager] replay ${r.name}: lint failed before run: ${lint}`); return { ok: false, name: r.name, output: '', reason: `lint failed before run: ${lint}` }; }
        if (!staged) return { ok: false };
        // fix70: what this skill did to the inventory is measured over ITS run only (runBefore -> after). `before` is the
        //        task-start snapshot (goal gain is still measured from it); everything between it and this run (other replays,
        //        backchaining, a practice run still finishing) is not this skill's doing
        const runBefore = this.observe();
        this._runStart = Date.now();
        const closeJournal = this._openTrialJournal(Object.keys(over), r.name, task, replayClosure);
        let res;
        try {
            res = await this._run(`voyager:replay:${task}`, async () => {
                const bot = this._timedBotForSkillRun();
                await staged.func.main(bot);
            }, 5);
        } finally { closeJournal(); }
        if (this.abort) return { ok: false, interrupted: true };
        const after = this.observe();
        this._noteBroughtNear(entry, runBefore, after);
        let ok, unverified = false;
        const cut = res.interrupted || this._diedInRun() || this._stalledInRun() ? this._interruptReason(res) : '';   // fix14: a cut-off replay is a failure
        if (this._diedInRun()) this._noteDeath(this._diedInRun(), task);
        if (cut) { ok = false; console.log(`[voyager] replay ${r.name} ${cut}; counting as a failure`); } else
        if (!res.success) { ok = false; console.log(`[voyager] replay ${r.name} EXEC_FAILED: ${String(res.message)}`); } else
        if (r.free) { const e = this.agent.bot.inventory.emptySlotCount(); ok = e >= r.free; console.log(`[voyager] inventory check: ${e} empty slots (need ${r.free})`); }
        else if (r.at) { const p = this.agent.bot.entity.position; ok = Math.hypot(p.x - r.at.x, p.z - r.at.z) <= 8; }
        else if (g.kind === 'item') ok = gainedFor(goal, before, after) >= goal.count;
        else if (g.kind === 'ensure') { ok = this._ensureHolds(g, after); console.log(`[psn] fix55 ensure goal ${g.item}: placed nearby -> ${ok}`); }
        else if (g.kind === 'reach') { ok = this._reachHolds(g, after); console.log(`[psn] fix83 reach goal ${g.item}: observed nearby -> ${ok}`); }
        else if (g.kind === 'skill') {
            // a different skill run on a skill goal cannot show that the named skill succeeded
            if (r.name !== g.skill.name) { ok = false; console.log(`[psn] LOUD: skill goal "${task}" was run by ${r.name}, not ${g.skill.name}; NOT satisfied`); }
            else { ok = this._postHolds(g.skill); console.log(`[psn] fix55 skill goal ${g.skill.name}: learned post ${g.skill.contract.post} -> ${ok}`); }
        } else {
            // fix55: open (free-text) goal: only the routed skill's learned post-contract verifies it, never item counts
            if (!entry?.contract?.post) {
                console.log(`[psn] LOUD: open goal "${task}" routed to ${r.name}, which has no learned post-contract; cannot verify -> NOT satisfied (contract learning queued)`);
                if (entry) delete entry.contractTried;
                ok = false;
            } else {
                const held = this._postHolds(entry);
                const v = held ? this._postVerifiesRun(entry) : { ok: true };
                if (held && v.ok === false) {
                    // fix56: the post held but would also hold for a run that did nothing -> it cannot verify an open goal
                    console.log(`!!! [psn] LOUD: open goal "${task}" NOT verified: ${r.name} post ${entry.contract.post} cannot verify it (${v.why}); queued contract repair`);
                    this._queueContractFix(entry, `post cannot verify a goal: ${v.why}`);
                    unverified = true;
                } else if (held && v.ok === null) {
                    // fix87: pre did not hold. The goal is not verified by this run, and the contract is not at fault.
                    console.log(`[psn] open goal "${task}": ${r.name} ${v.why}; not a contract violation`);
                    unverified = true;
                } else if (held && v.ok !== true) throw new Error(`[fix87] _postVerifiesRun(${r.name}) returned ok=${JSON.stringify(v.ok)}`);
                ok = held && v.ok === true;
                console.log(`[psn] fix55 open goal "${task}": ${r.name} learned post ${entry.contract.post} -> held=${held}, verifies run=${v.ok} -> ${ok}`);
            }
        }
        // fix81: what this failed run lacks, as structured facts (reported by the code, a violated contract's inventory reads,
        //        or the goal's game-data prerequisites); read before the marker is cleared and the trace consumed below
        const failTrace = this.agent.bot.__psnTrace;
        const reported = ok ? null : peekPreconditionUnmet(this.agent.bot);
        if (ok) clearPreconditionUnmet(this.agent.bot);
        // fix44: pass goal items to filter learned effects and produces (denoise)
        const goalItems = goal?.items || (goal?.item ? [goal.item] : null);
        if (entry && ok && !trial) this._learnEffects(entry, runBefore, after, goalItems);
        // fix56: an unverified open goal is neither a pass nor a failure of the skill: no run stats, no blame of the root for the goal
        // fix70: a run whose error was raised in library code is that code's fault, not a run of the learned skill
        // fix76: structural unmet preconditions (typed marker or learned food-raiser at food cap) are not skill/candidate evidence
        const libFault = !ok && this._libraryFault(this.agent.bot.__psnTrace, r.name);
        const unmet = !ok && !libFault && this._classifyUnmetPrecondition(r.name, runBefore.food_value);
        if (unmet) console.log(`!!! [blame] UNMET PRECONDITION (${unmet}): ${r.name} — not counted against stats or gate`);
        clearPreconditionUnmet(this.agent.bot);   // fix81: read above (reported); a library fault must not leave it for the next run
        // fix10: per-call trace -> contract results -> blame -> targeted repair. fix79: runs before the stats so a misroute
        //        (every call met its contract; the route had no learned evidence for the goal) is not a failure of the skill
        const verdict = this._attribute(r.name, task, unverified ? true : ok, over, routeFit);
        const misrouted = verdict === MISROUTED;
        if (entry && !unverified && !libFault && !unmet && !misrouted) this._recordRun(entry, task, ok, trial);
        // ADAM-style: record inventory delta for needs/produces learning
        if (ok) this.npGraph.recordDelta(r.name, runBefore.inventory, after.inventory, goalItems);   // fix70: this run only
        // fix81: what the failed run lacked (not for a misroute: the wrong skill's needs are not the goal's)
        let needs = null;
        if (!ok && !libFault && !cut && !misrouted) {
            await this._judgeItems(after, this._goalSourceItems(task), true);
            needs = await this._withChosenSearches(after, () => this._failureNeeds(task, reported, failTrace, after));
        }
        const reason = !ok ? this._failureReason(failTrace) : null;   // fix89: FAILED lines already on the trace

        // fix37 (D): detect and log inventory-full as a fact for learning
        const invFullFact = !ok ? this._detectInventoryFullFailure(task, before, after, String(res.message || '')) : null;
        const gained = goal ? gainedFor(goal, before, after) : 0;

        console.log(`[voyager] replay ${r.name}: ${ok ? 'PASSED' : 'failed'}${goal ? ` (+${gained} ${goal.items.join('/')})` : ''}`);
        if (r.free) console.log(`[voyager] storage replay ${r.name} output: ${String(res.message || '(none)').split(/\n|\|/).filter(l => /\[(toss|chest)\]/.test(l)).join(' | ').slice(-800)}; inv now ${JSON.stringify(after.inventory)}`);
        if (!ok) {
            console.log(`[voyager] replay ${r.name} inv: ${this.agent.bot.inventory.emptySlotCount()} empty slots; ${JSON.stringify(after.inventory)}`);
            if (invFullFact) console.log(`[voyager] replay ${r.name} INVENTORY FULL DETECTED: ${invFullFact}`);
        }
        if (!ok) console.log(`[voyager] replay ${r.name} output: ${String(res.message || '(none)').slice(-600).replace(/\n+/g, ' | ')}`);
        const out = { ok, name: r.name, output: String(res.message || ''), cut, invFullFact, unverified, needs };
        // fix79: the route takes the blame: ok stays false (goal outcome, learned embedding threshold) and the reason names the route
        if (misrouted) return { ...out, misrouted: routeFit, reason: `misrouted: ${r.name} has no learned evidence it produces ${routeFit.items.join('/')}` };
        if (typeof reason === 'string') return { ...out, reason };   // fix89
        return out;
    }
    // library source with optional per-name code overrides (candidates under test)
    _libSrc(over = {}) { return this.skills.map(s => over[s.name] ?? s.code).join('\n\n'); }
    /** Only skills in `names` (dependency-closure subset); same override rules as _libSrc */
    _libSrcSubset(names, over = {}) {
        const set = names instanceof Set ? names : new Set(names);
        return this.skills.filter(s => set.has(s.name)).map(s => over[s.name] ?? s.code).join('\n\n');
    }
    /** Install bot API timing proxy once for skill/staged execution. */
    _timedBotForSkillRun() {
        const b = wrapBotForApiTiming(this.agent.bot);
        if (b !== this.agent.bot) this.agent.bot = b;
        return this.agent.bot;
    }
    /** Staging options for coder: narrow bare API + declare learned names for eslint */
    _coderStageOpts(bundleSrc, skillNameSet) {
        const bareApiFilter = collectBareApiUsedInSource(bundleSrc);
        const learnedNamesForLint = skillNameSet instanceof Set ? skillNameSet : new Set(skillNameSet);
        // PSN trace instrumentSrc assigns `name = __wrap(..., name)` — `name` may not match `name(` call detection
        for (const n of learnedNamesForLint) {
            if (typeof skills[n] === 'function') bareApiFilter.skillNames.add(n);
            else if (typeof world[n] === 'function') bareApiFilter.worldNames.add(n);
        }
        return { bareApiFilter, learnedNamesForLint };
    }
    async _stageLintExec(bundleSrc, skillNameSet, label = 'voyager') { return this._stageLintExecTraced(bundleSrc, bundleSrc, skillNameSet, label); }
    // fix61: lintSrc is everything a model or skill wrote (library closure + generated code + call); execSrc is lintSrc with the
    // harness's PSN instrumentation (`name = __wrap("name", name)`) spliced in. #44 linted execSrc, so ESLint's no-func-assign
    // flagged the instrumentation itself on every traced bundle: every replay "lint failed before run" (craftItem for
    // "Craft 1 iron_pickaxe" included) and fell through to the code model, whose feedback then named lines it never wrote.
    async _stageLintExecTraced(lintSrc, execSrc, skillNameSet, label) {
        const opts = this._coderStageOpts(execSrc, skillNameSet);
        console.log(`[staging] ${label}: bundle ${execSrc.length} chars, ${execSrc.split('\n').length} lines, ${skillNameSet instanceof Set ? skillNameSet.size : '?'} skill names in closure`);
        const lintSt = await withStallPhase('voyager:stage-lint', () => this.agent.coder._stageCode(lintSrc, { ...opts, lintOnly: true }));
        if (typeof lintSt.preludeLines !== 'number') throw new Error('[voyager] _stageLintExec: lint stage must return numeric preludeLines');
        const lint = await withStallPhase('voyager:lint', () => this.agent.coder._lintCode(lintSt.src_lint_copy, lintSt.preludeLines));
        if (lint) return { lint, staged: null };
        const staged = await withStallPhase('voyager:stage-exec', () => this.agent.coder._stageCode(execSrc, { ...opts, lintOnly: false }));
        return { lint: null, staged };
    }
    _graph(exclude) { const g = {}; for (const s of this.skills) if (s.name !== exclude) g[s.name] = s.deps || []; return g; }
    
    // fix49/fix88: self-call and dependency-cycle feedback for a repair, before the gate. null when the code may be installed.
    _cycleLint(skillName, code) {
        const deps = this._candidateDeps(skillName, code);
        const violations = installViolations({ name: skillName, code, deps }, this.skills);
        if (violations.length === 0) return null;
        return this._installViolationText(violations);
    }
    // deps that would be stored for this code: library skills only, with learned deps stripped from a seeded skill (fix39)
    _candidateDeps(name, code) {
        let deps = depsOf(code, name, new Set(this.skills.map(s => s.name)));
        const existing = this.skills.find(s => s.name === name);
        if (existing !== undefined && existing.seeded === true) {
            const learnedDeps = deps.filter(d => {
                const dep = this.skills.find(s => s.name === d);
                return dep !== undefined && dep.seeded !== true && dep.primitive !== true && dep.handwritten !== true;
            });
            if (learnedDeps.length > 0) {
                gateLog(`WARN ${name} (seeded): stripping learned deps [${learnedDeps.join(', ')}] to prevent cycles`);
                deps = deps.filter(d => !learnedDeps.includes(d));
            }
        }
        return deps;
    }
    _installViolationText(violations) {
        if (!Array.isArray(violations) || violations.length === 0) throw new Error('[fix88] _installViolationText: violations required');
        const lines = [];
        for (const v of violations) {
            if (v.kind === 'self') lines.push(`SELF-RECURSION: ${v.name} calls itself with its own parameters unchanged. That overflows the stack at runtime. Do not call ${v.name} from inside itself.`);
            else if (v.kind === 'cycle') {
                const via = v.path.filter((n, i) => i > 0);
                lines.push(`DEPENDENCY CYCLE would be created: ${v.path.join(' -> ')}\nThe skill "${v.path[0]}" cannot take part in this cycle (${via.join(' -> ')}).`);
            } else throw new Error(`[fix88] unknown violation kind ${JSON.stringify(v.kind)}`);
        }
        return lines.join('\n');
    }
    // Record a rejected install where the learner will read it. Does not write the skill file or index.
    _recordInstallRejection(name, violations) {
        const evidence = this._installViolationText(violations);
        console.error(`[psn] REJECT ${name} before save:\n${evidence}`);
        gateLog(`REJECT ${name}: ${evidence}`);
        const entry = this.skills.find(s => s.name === name);
        if (entry) {
            if (entry.repairHistory === undefined) entry.repairHistory = [];
            else if (!Array.isArray(entry.repairHistory)) throw new Error(`[psn] ${name}.repairHistory is not an array`);
            const last = entry.repairHistory.length > 0 ? entry.repairHistory[entry.repairHistory.length - 1] : null;
            if (last !== null && !Object.hasOwn(last, 'outcome')) {
                last.evidence = evidence;
                last.outcome = 'rejected';
            } else {
                this._pushRepair(entry, { kind: 'install', evidence, desc: evidence, outcome: 'rejected' });
            }
            this._proposalOutcome(entry, 'rejected');
        } else {
            if (!Array.isArray(this.installRejections)) throw new Error('[fix88] installRejections is not initialized');
            this.installRejections.push({ name, at: new Date().toISOString(), kind: 'install', evidence, desc: evidence, outcome: 'rejected' });
            console.log(`[repair-outcome] ${name}: rejected`);
        }
        return evidence;
    }

    // fix32: learned effects / consumption of a skill from its successful runs - feeds backward chaining (fix70/fix74: both carry run evidence)
    // fix44: goalItems hint FILTERS which observed ups count as effects - does NOT fabricate
    // When goalItems present: keep only observed ∩ goal (no fabrication from goal alone)
    // When goalItems absent: keep ALL observed ups (no hard-coded incidental/junk tables)
    _learnEffects(e, before, after, goalItems = null) {
        const inv0 = before.inventory, inv1 = after.inventory;
        // fix44: the goal hint filters which observed ups count as effects in this run (observed AND goal; nothing fabricated)
        if (goalItems && goalItems.length) {
            const excluded = Object.keys(inv1).filter(k => invCount(inv1, k) > invCount(inv0, k) && !goalItems.includes(k));
            if (excluded.length) console.log(`[psn] _learnEffects filtered non-goal items: [${excluded.join(',')}]`);
        }
        // fix73: every entry is created with effects and consumes (load, saveSkill NEW, split/generalise); the `|| {}` here hid
        // the one creator that left consumes out, so a skill that consumed nothing kept it undefined. Missing is a bug: say so.
        if (!Array.isArray(e.effects) || e.consumes === null || typeof e.consumes !== 'object') throw new Error(`[psn] _learnEffects: skill ${e.name} has no effects/consumes record (effects=${JSON.stringify(e.effects)}, consumes=${JSON.stringify(e.consumes)})`);
        // fix74: effects carry their evidence like consumes (consume_evidence.js recordEffectEvidence). The fix32 union (d1ea48e;
        //        fix73 dropped its first-12 cap) could never shrink, so one polluted window (pre-fix70 task-window measurement)
        //        stayed a learned effect for good. The goal hint (fix44) says which ups count in this run.
        const eff0 = JSON.stringify(e.effects);
        recordEffectEvidence(e, inv0, inv1, goalItems && goalItems.length ? goalItems : null);
        if (JSON.stringify(e.effects) !== eff0) console.log(`[psn] ${e.name} effects (from ${e.effectEvidence.runs} measured run(s)): [${e.effects.join(', ')}]`);
        // fix70: consumption carries its evidence (consume_evidence.js); before, consumes was a running max of every item that went
        //        down in any success window and could never shrink, so one polluted window blocked practice for good
        const con0 = JSON.stringify(e.consumes);
        recordConsumeEvidence(e, inv0, inv1);
        if (JSON.stringify(e.consumes) !== con0) console.log(`[psn] ${e.name} consumes (from ${e.consumeEvidence.runs} measured run(s)): ${JSON.stringify(e.consumes)}`);
        this._saveSkills();
    }
    // fix55: ONE goal resolver. Each kind comes from one rule over disjoint grammars (no fallback chain):
    //   item   - "Smelt N a into N b" / "<verb> N <item>", after an optional "kind:" label (smeltGoal / countGoal): verified by inventory gain
    //   ensure - "ensure <block>" (ensureGoal): verified by the block being placed nearby
    //   skill  - the text IS the name of a library skill (learned names): verified by that skill's learned post-contract
    //   invalid- a bare identifier that is not a usable skill: rejected loudly back to the planner
    //   open   - any other free text: verified only by the routed skill's learned post-contract, never by item counts
    _resolveGoal(task) {
        if (typeof task !== 'string' || !task.trim()) throw new Error(`[fix55] LOUD FAIL: _resolveGoal needs a non-empty task string, got ${JSON.stringify(task)}`);
        const t = task.trim();
        const smelt = smeltGoal(t);
        if (smelt) return { kind: 'item', ...smelt };
        const ensure = ensureGoal(t);  // fix49: before countGoal
        if (ensure) return { kind: 'ensure', ...ensure };
        const reach = reachGoal(t);   // fix83
        if (reach) return { kind: 'reach', ...reach };
        const count = countGoal(t);
        if (count) return { kind: 'item', ...count };
        if (!isBareIdentifier(t)) return { kind: 'open' };
        const e = this.skills.find(s => s.name === t);
        if (!e) return { kind: 'invalid', why: `"${t}" is neither an item goal ("<verb> N <item>", "Smelt N <raw> into N <out>", "ensure <block>", "reach <block>") nor the name of a known skill` };
        // fix70: a demoted skill with a repair candidate is still a valid goal: the candidate's trial runs are the learner's only way
        // back for it (a promotion clears demoted). fix55 (#48) made every demoted skill goal invalid, so _gateTrial's dedicated
        // trial of the eatCookedMutton candidate was refused ("not replaying ... skill eatCookedMutton is demoted") every 5 min
        if (e.demoted && !e.candidate) return { kind: 'invalid', why: `skill ${t} is demoted` };
        if (e.mergedInto) return { kind: 'invalid', why: `skill ${t} was merged into ${e.mergedInto}; propose ${e.mergedInto}` };
        const host = this._curSub && this._curSub.task === t && this._curSub.slotRequest ? this._curSub.slotRequest : null;
        const need = requiredArgs(e);
        if (need.length && host === null) return { kind: 'invalid', why: `skill ${t} needs arguments (${need.join(', ')}); propose an item goal instead` };
        if (!e.contract?.post) {
            delete e.contractTried;   // fix55: _backfillContracts learns it on the next step
            console.log(`[fix55] LOUD: skill goal ${t} has no learned post-contract; contract learning queued`);
            return { kind: 'invalid', why: `skill ${t} has no learned post-contract yet, so its success cannot be verified` };
        }
        return { kind: 'skill', skill: e };
    }
    // fix55: an "ensure" goal holds when the block is placed nearby (exact block name in observe().nearby_blocks)
    _ensureHolds(goal, state) {
        if (goal.verb === 'ensure') {
            const blocks = state.nearby_blocks;
            if (!Array.isArray(blocks)) throw new Error('[fix55] state.nearby_blocks (array) required for ensure goals');
            return blocks.some(b => b === goal.item);
        }
        throw new Error(`[fix55] _ensureHolds called for a non-ensure goal (${goal.verb})`);
    }
    // fix83: a "reach" goal holds when the block is observed nearby (exact block name in observe().nearby_blocks)
    _reachHolds(goal, state) {
        if (goal.verb !== 'reach') throw new Error(`[fix83] _reachHolds called for a non-reach goal (${goal.verb})`);
        if (!Array.isArray(state.nearby_blocks)) throw new Error('[fix83] state.nearby_blocks (array) required for reach goals');
        return state.nearby_blocks.includes(goal.item);
    }
    // fix86: a run that made a block appear in nearby_blocks is evidence that skill can bring that block into range
    _noteBroughtNear(entry, before, after) {
        if (!entry) return;
        if (!Array.isArray(before.nearby_blocks) || !Array.isArray(after.nearby_blocks)) return;
        const had = new Set(before.nearby_blocks);
        const gained = [];
        for (const b of after.nearby_blocks) if (!had.has(b) && !gained.includes(b)) gained.push(b);
        if (!gained.length) return;
        if (!Array.isArray(entry.broughtNear)) entry.broughtNear = [];
        let changed = false;
        for (const b of gained) if (!entry.broughtNear.includes(b)) { entry.broughtNear.push(b); changed = true; }
        if (changed) { console.log(`[fix86] ${entry.name} brought into range: ${gained.join(', ')}`); this._saveSkills(); }
    }
    // fix86: the learned skill (no required args) whose runs brought this block into nearby. Name order, no random pick.
    _reachBringer(block) {
        const fits = [];
        for (const s of this.skills) {
            if (s.demoted || s.mergedInto) continue;
            if (!Array.isArray(s.broughtNear) || !s.broughtNear.includes(block)) continue;
            if (requiredArgs(s).length) continue;
            fits.push(s);
        }
        fits.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        return fits.length ? fits[0] : null;
    }
    // fix86: arguments after bot, parsed the same way a contract sees them. A call that cannot be parsed fails loudly.
    static _callArgs(call) {
        const m = String(call).match(/\(bot(?:,\s*(.*))?\);?$/);
        if (!m) throw new Error(`[fix86] LOUD: cannot read arguments of ${JSON.stringify(call)}`);
        if (m[1] === undefined) return [];
        let args;
        try { args = JSON.parse(`[${m[1]}]`); }
        catch (e) { throw new Error(`[fix86] LOUD: cannot parse arguments of ${JSON.stringify(call)}: ${e.message}`); }
        if (!Array.isArray(args)) throw new Error(`[fix86] LOUD: arguments of ${JSON.stringify(call)} are not a list`);
        return args;
    }
    // fix81: the items being sought by the subgoal entry's ancestors (root first); a fresh task has none
    _prereqChain(entry) {
        if (entry === null) return [];
        if (!Object.hasOwn(entry, 'chain')) return [];
        if (!Array.isArray(entry.chain)) throw new Error(`[fix81] subgoal entry "${entry.task}" has a non-array chain`);
        return entry.chain;
    }
    // fix81: the game-data planner (recipe_plan.js) over the live registry and bot.recipesAll (every recipe, not only the
    //        ones the inventory can make now). "known" is learned or observed: a source block of the item in
    //        observe().nearby_blocks, or a learned producer of it. Exact ties are a uniform choice.
    // pathToBlock returns only success or noPath. A partial slice stays inside that search and is never stored
    // here. mineflayer-pathfinder index.js:64-71 takes one tickTimeout yield; lib/astar.js:70 returns 'partial'
    // and line 73 'timeout'. 'noPath' (line 121) is the open set exhausted, and that is the unreachable answer.
    _pathStatus(state, name) {
        if (state && state._reach && Object.hasOwn(state._reach, name)) {
            const status = state._reach[name];
            if (status !== 'success' && status !== 'noPath') {
                throw new Error(`[fix97] ${name} path status ${status} is not unreachable (mineflayer-pathfinder index.js tickTimeout; lib/astar.js compute).`);
            }
            return status;
        }
        throw new Error(`[fix97] ${name} has not been searched. bot.pathfinder.getPathFromTo steps the search (mineflayer-pathfinder index.js:75). A partial result is not unreachable.`);
    }
    // One search per block this decision will use, nearest by GoalLookAtBlock.heuristic first. A step does not
    // search every block the eye can see. stopAtSuccess returns the first success: that is the nearest one.
    async _judgeTargets(state, names, stopAtSuccess) {
        if (!Array.isArray(names)) throw new Error('[fix97] _judgeTargets needs the block names of this decision');
        // An observation with no positions has nothing to search. Unjudged is not success and not noPath.
        if (!state || !state.perceived_at || typeof state.perceived_at !== 'object') return null;
        if (!state._reach) state._reach = {};
        const bot = this.agent.bot;
        const pending = [];
        for (const name of names) {
            if (typeof name !== 'string' || name.length === 0) throw new Error('[fix97] a judged block name is not a string');
            if (Object.hasOwn(state._reach, name)) {
                if (stopAtSuccess && state._reach[name] === 'success') return name;
                continue;
            }
            if (!Object.hasOwn(state.perceived_at, name)) continue;
            pending.push(name);
        }
        if (!pending.length) {
            if (!stopAtSuccess) return null;
            for (const name of names) if (state._reach[name] === 'success') return name;
            return null;
        }
        const pf = bot && bot.pathfinder;
        if (!pf || typeof pf.getPathFromTo !== 'function') {
            throw new Error('[fix97] bot.pathfinder.getPathFromTo is missing. Reachability is one search of the chosen block (mineflayer-pathfinder index.js:75).');
        }
        pending.sort((a, b) => world.lookHeuristic(bot, state.perceived_at[a]) - world.lookHeuristic(bot, state.perceived_at[b]));
        let found = null;
        for (const name of pending) {
            const result = await world.pathToBlock(bot, state.perceived_at[name]);
            state._reach[name] = this._pathStatus({ _reach: { [name]: result.status } }, name);
            if (result.status === 'success') {
                found = name;
                if (stopAtSuccess) return name;
            }
        }
        return found;
    }
    _perceivedSources(state, items) {
        if (!state || !state.perceived_at || typeof state.perceived_at !== 'object') return [];
        if (!Array.isArray(items) || items.length === 0) return [];
        const registry = this.agent && this.agent.bot && this.agent.bot.registry;
        const names = [];
        const seen = new Set();
        for (const item of items) {
            if (typeof item !== 'string' || item.length === 0) continue;
            for (const block of itemSourceBlocks(registry, item)) {
                if (seen.has(block) || !Object.hasOwn(state.perceived_at, block)) continue;
                seen.add(block);
                names.push(block);
            }
        }
        return names;
    }
    async _judgeItems(state, items, stopAtSuccess) {
        return this._judgeTargets(state, this._perceivedSources(state, items), stopAtSuccess);
    }
    _goalSourceItems(task) {
        const goal = this._resolveGoal(task);
        const items = [];
        if (goal && typeof goal.item === 'string') items.push(goal.item);
        if (goal && typeof goal.input === 'string') items.push(goal.input);
        return items;
    }
    _needItems(needs) {
        const items = [];
        for (const n of needs || []) {
            if (!n || typeof n !== 'object') continue;
            if (typeof n.item === 'string') items.push(n.item);
            if (Array.isArray(n.anyOf)) for (const a of n.anyOf) if (typeof a === 'string') items.push(a);
        }
        return items;
    }
    _capacityItems(req) {
        const goal = this._resolveGoal(req.parent);
        const items = [req.item];
        if (goal && typeof goal.item === 'string') items.push(goal.item);
        if (goal && typeof goal.input === 'string') items.push(goal.input);
        return items;
    }
    _obtainPlanner(state) {
        const bot = this.agent.bot;
        if (!Array.isArray(state.nearby_blocks)) throw new Error('[fix81] _obtainPlanner: state.nearby_blocks (array) required');
        if (typeof bot.recipesAll !== 'function') throw new Error('[fix81] _obtainPlanner: bot.recipesAll required');
        const near = new Set(state.nearby_blocks), memo = new Map(), reached = new Map();
        // fix100: learned smelt edges are read once. plan() calls smeltInputs on every node; scanning goalStats
        // there made a hunger serve walk the whole history 20k times (12.5s at 1080 keys, 76s at 5000, Node 20).
        // The edges do not change during one synchronous plan, same as sourceMemo's game data.
        const smelt = this._learnedSmeltIndex();
        // fix100: _edgeSuccess -> _resolveGoal -> countGoal re-reads minecraft-data and re-runs the goal regex on every
        // node. Recipe edges and the registry do not change during one synchronous plan.
        const edgeMemo = new Map();
        // A source the bot can see is knowledge (nearby_blocks). Whether that block can be walked to is one
        // pathfinder search of the perceived position, not membership of the set. A source nobody has searched
        // is searched when this plan chooses it. Only noPath is unreachable.
        const reachableBlock = (block) => {
            if (reached.has(block)) return reached.get(block);
            const at = state.perceived_at && state.perceived_at[block];
            if (!at) {
                reached.set(block, false);
                return false;
            }
            let status = state._reach && Object.hasOwn(state._reach, block) ? state._reach[block] : null;
            if (status === null) {
                const ready = world.pathToBlockReady(bot, at);
                if (ready) {
                    if (!state._reach) state._reach = {};
                    state._reach[block] = ready.status;
                    status = ready.status;
                } else {
                    const err = new Error(`[fix97] ${block} is nearby and has not been searched. Reachability is pathToBlock of that block, not membership of nearby_blocks.`);
                    err.unsearchedBlock = block;
                    throw err;
                }
            }
            if (status === 'noPath') {
                reached.set(block, false);
                return false;
            }
            if (status !== 'success') throw new Error(`[fix97] ${block} reach status ${JSON.stringify(status)} is not success or noPath`);
            reached.set(block, true);
            return true;
        };
        return obtainPlanner({
            registry: bot.registry,
            recipesOf: id => bot.recipesAll(id, null, true),
            known: (item, src) => {
                if (!memo.has(item)) memo.set(item, src.some(b => near.has(b)) || this._producers(item).length > 0);
                return memo.get(item);
            },
            present: reachableBlock,
            proven: item => Object.hasOwn(this.progress.recipeEdges, item) && this.progress.recipeEdges[item].status === 'proven',
            edgeSuccess: (item, verb) => {
                let byVerb = edgeMemo.get(item);
                if (byVerb === undefined) { byVerb = new Map(); edgeMemo.set(item, byVerb); }
                if (!byVerb.has(verb)) byVerb.set(verb, this._edgeSuccess(item, verb));
                return byVerb.get(verb);
            },
            smeltInputs: item => {
                const inputs = smelt.get(item);
                if (inputs === undefined) return [];
                return [...inputs];
            },
        });
    }
    // A plan that chooses a perceived source whose search is still partial throws unsearchedBlock. Search that
    // block with pathToBlock (which continues across ticks) and plan again. Only noPath stays unreachable.
    async _withChosenSearches(state, run) {
        const seen = new Set();
        for (;;) {
            try {
                return run(() => this._obtainPlanner(state));
            } catch (err) {
                if (!err || typeof err.unsearchedBlock !== 'string') throw err;
                if (seen.has(err.unsearchedBlock)) throw new Error(`[fix97] ${err.unsearchedBlock} was searched and still has no reach status`);
                seen.add(err.unsearchedBlock);
                await this._judgeTargets(state, [err.unsearchedBlock], false);
                if (!state._reach || !Object.hasOwn(state._reach, err.unsearchedBlock)) {
                    throw new Error(`[fix97] ${err.unsearchedBlock} is nearby and was not searched`);
                }
            }
        }
    }
    // fix96: observed success of an item's producer edge (progress.recipeEdges runs/fails), the fix90 posterior. 1 when there is
    //        no edge, or the edge is another verb than the one asked (verb null: whatever its verb).
    _edgeSuccess(item, verb) {
        if (!Object.hasOwn(this.progress.recipeEdges, item)) return 1;
        const e = this.progress.recipeEdges[item];
        if (typeof e.task !== 'string' || typeof e.runs !== 'number' || typeof e.fails !== 'number') throw new Error(`[fix96] recipeEdges[${item}] is malformed: ${JSON.stringify(e)}`);
        if (verb !== null) {
            const g = this._resolveGoal(e.task);
            const edgeVerb = Object.hasOwn(g, 'verb') ? String(g.verb).toLowerCase() : e.task.split(/\s+/)[0].toLowerCase();
            if (edgeVerb !== verb) return 1;
        }
        return this._posteriorMean(e.runs - e.fails, e.fails);
    }
    // fix96: furnace recipes are not in the game data. A "Smelt N <in> into N <out>" goal that succeeded is a learned edge in -> out.
    // fix100: one pass, grouped by output. Set insertion order matches the old per-item scan (Object.entries order, first input kept).
    _learnedSmeltIndex() {
        if (!this.progress.goalStats || typeof this.progress.goalStats !== 'object') throw new Error('[fix96] progress.goalStats required to read learned smelt edges');
        const byItem = new Map();
        for (const [key, st] of Object.entries(this.progress.goalStats)) {
            if (!(st.success > 0)) continue;
            const sm = smeltGoal(key.split('::')[0]);
            if (sm === null || sm.input === sm.item) continue;
            let inputs = byItem.get(sm.item);
            if (inputs === undefined) { inputs = new Set(); byItem.set(sm.item, inputs); }
            inputs.add(sm.input);
        }
        return byItem;
    }
    // fix81: the goal key a subgoal chain is seeking: an item goal seeks the item, an ensure goal the block PLACED nearby
    _goalKey(goal) {
        if (goal.kind === 'ensure') return `placed ${goal.item}`;
        if (goal.kind === 'reach') return `reach ${goal.item}`;   // fix83
        if (goal.kind === 'skill') return `skill ${goal.skill.name}`;   // fix84
        return goal.item;
    }
    _needKey(need) {
        if (need.reason === 'proximity') return `placed ${need.item}`;
        if (need.reason === 'reach') return `reach ${need.item}`;   // fix83
        if (need.reason === 'slot') return 'slot';   // fix84: any full-inventory need is the same missing slot
        return need.item;
    }
    // fix81: every failure that is not a library fault says what it lacks, as structured facts { item | anyOf, count, reason }:
    //   1. reported by the code that failed (markPreconditionUnmet(bot, { need }): seeded craftRecipe "ingredients",
    //      collectBlock "tool", tossClutter "proximity", ensureCraftingTable "ingredients")
    //   2. a violated learned pre-contract: the inventory items it read and the bot has none of (_checkContracts r.need)
    //   3. the goal's own prerequisites in the game data (recipe_plan.js): an item goal's missing harvest tool or
    //      ingredients; an ensure goal whose block is not in the inventory to place
    //   4. fix90: a failure that means "no item of kind X" (the run said so, or every item the skill named is a member
    //      of one game-data collection and the bot holds none of that collection). The satisfying set is the whole
    //      collection (minecraft-data), an anyOf need, so _chainNeeds obtains one member. Not a per-kind branch:
    //      the collections are read off the game data.
    //   null when none of them names anything (an open goal whose code reported nothing): the model decomposes it.
    // fix90: why fix89's "lacked an input; backchained" did not run on the live hunger loop. That log is only in the
    // raiser branch of _serveUrgentBody, and only when the replay already returned needs. Live, the food raiser was
    // `consume` (a built-in, not a library skill), so the serve was "raiser none playable" and cold-started the
    // curriculum. The curriculum replayed the skill goal eatFood. _failureNeeds returned null for that skill goal
    // (no marker, no pre-contract inventory read, not an item goal), so _pursueProposedTask never called _chainNeeds.
    // Both paths call _failureNeeds; a kind need returned from here is chained by the raiser branch and by
    // _pursueProposedTask (on the need label while a need serve is current, so the next step yields to the subgoals).
    _itemKinds(md) {
        if (!md || !md.itemsByName) throw new Error('[fix90] _itemKinds: minecraft-data items required');
        const itemCount = Object.keys(md.itemsByName).length;
        if (itemCount < 2) throw new Error('[fix90] minecraft-data has no items');
        const kinds = [];
        for (const key of Object.keys(md)) {
            if (key.endsWith('Array') || key.endsWith('ByName')) continue;
            const items = this._collectionItems(md, md[key]);
            if (items === null) continue;
            if (items.length < 2 || items.length >= itemCount) continue;
            kinds.push({ key, items, aliases: this._kindAliases(key) });
        }
        if (kinds.length === 0) throw new Error('[fix90] minecraft-data has no item-kind collection');
        return kinds;
    }
    // A collection whose every record is an item (its name is an item), a proper subset of every item.
    // ByName/Array copies of the same collection are skipped by the caller.
    _collectionItems(md, val) {
        if (!val || typeof val !== 'object' || typeof val === 'function') return null;
        const entries = Array.isArray(val) ? val : Object.values(val);
        if (entries.length < 2) return null;
        const names = [];
        for (const rec of entries) {
            if (!rec || typeof rec !== 'object' || typeof rec.name !== 'string') return null;
            // the record is an item when its name is an item. Numeric ids are not identity: they collide across
            // game-data tables, and a later version's copy of an item table does not reuse the item id.
            if (!Object.hasOwn(md.itemsByName, rec.name)) return null;
            if (!names.includes(rec.name)) names.push(rec.name);
        }
        return names;
    }
    _kindAliases(key) {
        if (typeof key !== 'string' || !/^[A-Za-z0-9_]+$/.test(key)) throw new Error(`[fix90] game-data kind key is not a name: ${JSON.stringify(key)}`);
        const aliases = [key];
        if (key.endsWith('s') && key.length > 1) aliases.push(key.slice(0, -1));
        return aliases;
    }
    _kindsNamedIn(line, kinds) {
        const hit = [];
        for (const k of kinds) {
            for (const alias of k.aliases) {
                const re = new RegExp(`\\b(?:no|without|missing|lacks)\\s+${alias}\\b|\\b${alias}\\s+missing\\b`, 'i');
                if (re.test(line)) { hit.push(k); break; }
            }
        }
        return hit;
    }
    _ownFailLines(trace) {
        if (!Array.isArray(trace)) return [];
        const lines = [];
        for (const r of trace) {
            if (!Array.isArray(r.ownFail)) continue;
            for (const line of r.ownFail) if (typeof line === 'string' && line.length > 0) lines.push(line);
        }
        return lines;
    }
    _quotedItemNames(code, itemsByName) {
        if (typeof code !== 'string') throw new Error('[fix90] skill code must be a string');
        const names = [];
        const re = /['"]([a-z0-9_]+)['"]/g;
        let m;
        while ((m = re.exec(code)) !== null) {
            if (Object.hasOwn(itemsByName, m[1]) && !names.includes(m[1])) names.push(m[1]);
        }
        return names;
    }
    _failureSkillCodes(task, trace, goal) {
        const codes = [];
        const push = (e) => {
            if (!e || typeof e.code !== 'string') return;
            if (!codes.includes(e.code)) codes.push(e.code);
        };
        if (goal.kind === 'skill') push(goal.skill);
        if (typeof task === 'string') push(this.skills.find(s => s.name === task.trim()));
        if (Array.isArray(trace)) {
            for (const r of trace) {
                if (typeof r.name !== 'string') continue;
                push(this.skills.find(s => s.name === r.name));
            }
        }
        return codes;
    }
    _holdsKind(inv, items) {
        for (const name of items) {
            if (Object.hasOwn(inv, name) && typeof inv[name] === 'number' && inv[name] > 0) return true;
        }
        return false;
    }
    _kindsCovering(kinds, names) {
        const hit = [];
        for (const k of kinds) {
            let all = true;
            for (const n of names) if (!k.items.includes(n)) { all = false; break; }
            if (all) hit.push(k);
        }
        return hit;
    }
    _needsForKinds(kinds) {
        return kinds.map(k => this._checkNeed({ anyOf: [...k.items].sort(), count: 1, reason: 'input' }, `no item of kind ${k.key}`));
    }
    // null when this failure is not "no item of kind X". One need per kind the bot does not hold.
    _kindInputNeeds(task, trace, state, goal) {
        if (!state || typeof state.inventory !== 'object' || state.inventory === null) throw new Error('[fix90] _kindInputNeeds: state.inventory required');
        if (!VERSION) throw new Error('[fix90] _kindInputNeeds: VERSION required');
        const md = minecraftData(VERSION);
        if (!md || !md.itemsByName) throw new Error(`[fix90] no minecraft-data items for ${JSON.stringify(VERSION)}`);
        const kinds = this._itemKinds(md);
        const inv = state.inventory;
        const named = [];
        for (const line of this._ownFailLines(trace)) {
            for (const k of this._kindsNamedIn(line, kinds)) if (!named.includes(k)) named.push(k);
        }
        if (named.length > 0) {
            const missing = named.filter(k => !this._holdsKind(inv, k.items));
            if (missing.length === 0) return null;
            console.log(`[fix90] "${task}": failure names kind ${missing.map(k => k.key).join(', ')}; anyOf ${missing.map(k => k.items.length).join(', ')} item(s) from game data`);
            return this._needsForKinds(missing);
        }
        const names = [];
        for (const code of this._failureSkillCodes(task, trace, goal)) {
            for (const n of this._quotedItemNames(code, md.itemsByName)) if (!names.includes(n)) names.push(n);
        }
        // one quoted item is that item (a contract read already reports it). A set of them that share one kind is the kind.
        if (names.length < 2) return null;
        const cover = this._kindsCovering(kinds, names);
        if (cover.length > 1) throw new Error(`[fix90] LOUD: items [${names.join(', ')}] belong to more than one game-data kind (${cover.map(k => k.key).join(', ')})`);
        if (cover.length === 0) return null;
        if (this._holdsKind(inv, cover[0].items)) return null;
        console.log(`[fix90] "${task}": skill names only items of kind ${cover[0].key} and the bot holds none; anyOf ${cover[0].items.length} from game data`);
        return this._needsForKinds(cover);
    }
    // fix92: the slot need that actually blocked this run. A root-reported need wins (fix85). Otherwise the deepest
    // failure that propagated to the root (the same parent walk as blame), then the first slot need on that path.
    // A nested need whose caller succeeded is that call's, and is not promoted.
    _blockingSlotNeed(trace) {
        if (!Array.isArray(trace) || trace.length === 0) return null;
        const roots = trace.filter(r => r.parent < 0 && Object.hasOwn(r, 'reportedNeed'));
        if (roots.length > 1) throw new Error(`[fix85] ${roots.length} root frames reported a need`);
        if (roots.length === 1) {
            const need = roots[0].reportedNeed;
            if (!need || need.reason !== 'slot') return null;
            if (typeof roots[0].name !== 'string' || roots[0].name.length === 0) throw new Error('[fix92] slot frame has no name');
            return { item: need.item, count: need.count, reason: 'slot', owner: roots[0].name };
        }
        const failed = [];
        for (let i = 0; i < trace.length; i++) {
            const r = trace[i];
            if (r.ok) continue;
            if (r.intr) continue;
            let propagates = true;
            let c = r;
            let p = r.parent;
            const seen = new Set();
            while (p >= 0) {
                if (seen.has(p)) throw new Error(`[fix92] trace cycle at frame ${p}`);
                seen.add(p);
                if (typeof p !== 'number' || p >= trace.length) throw new Error(`[fix92] frame ${r.name} parent ${p} is outside the trace`);
                const a = trace[p];
                if (a.ok || (c.err && !a.err)) { propagates = false; break; }
                c = a;
                p = a.parent;
            }
            if (propagates) {
                if (typeof r.depth !== 'number') throw new Error(`[fix92] trace frame ${JSON.stringify(r.name)} has no numeric depth`);
                failed.push({ i, depth: r.depth });
            }
        }
        if (!failed.length) return null;
        failed.sort((a, b) => {
            if (a.depth !== b.depth) return b.depth - a.depth;
            return b.i - a.i;
        });
        let i = failed[0].i;
        const walked = new Set();
        while (i >= 0) {
            if (walked.has(i)) throw new Error(`[fix92] trace cycle at frame ${i}`);
            walked.add(i);
            if (i >= trace.length) throw new Error(`[fix92] frame parent ${i} is outside the trace`);
            const r = trace[i];
            if (Object.hasOwn(r, 'reportedNeed') && r.reportedNeed && r.reportedNeed.reason === 'slot') {
                if (typeof r.name !== 'string' || r.name.length === 0) throw new Error('[fix92] slot frame has no name');
                if (typeof r.reportedNeed.item !== 'string' || !Number.isInteger(r.reportedNeed.count)) throw new Error(`[fix92] slot need is malformed: ${JSON.stringify(r.reportedNeed)}`);
                return { item: r.reportedNeed.item, count: r.reportedNeed.count, reason: 'slot', owner: r.name };
            }
            i = r.parent;
            if (typeof i !== 'number') throw new Error(`[fix92] frame ${r.name} parent is not a number`);
        }
        return null;
    }
    _failureNeeds(task, reported, trace, state) {
        // fix85: a need stamped on the root frame of this run is this task's. A need stamped only on a nested frame
        // (an iron_pickaxe craft inside "Collect 4 oak_planks") is that call's, and the global marker is the last write
        // of either. With no trace (the test world, a failure before any call) the marker is the whole run's report.
        if (Array.isArray(trace) && trace.some(r => Object.hasOwn(r, 'reportedNeed'))) {
            const roots = trace.filter(r => r.parent < 0 && Object.hasOwn(r, 'reportedNeed'));
            if (roots.length > 1) throw new Error(`[fix85] ${roots.length} root frames reported a need on "${task}"`);
            if (roots.length === 1) {
                const need = this._checkNeed(roots[0].reportedNeed, `reported by ${roots[0].name}`);
                if (need.reason === 'slot') {
                    if (typeof roots[0].name !== 'string' || roots[0].name.length === 0) throw new Error('[fix92] slot frame has no name');
                    need.owner = roots[0].name;
                }
                return [need];
            }
            const slot = this._blockingSlotNeed(trace);
            if (slot !== null) {
                const need = this._checkNeed({ item: slot.item, count: slot.count, reason: 'slot' }, `reported by ${slot.owner}`);
                need.owner = slot.owner;
                return [need];
            }
            const nested = trace.filter(r => Object.hasOwn(r, 'reportedNeed'));
            console.log(`[fix85] "${task}": ${nested.map(r => `${r.name} reported ${r.reportedNeed.item || r.reportedNeed.reason} at depth ${r.depth}`).join('; ')}; a nested call's need is that call's, not this task's`);
        } else if (reported !== null && Object.hasOwn(reported, 'need')) {
            const need = this._checkNeed(reported.need, 'reported');
            if (need.reason === 'slot') need.owner = 'reported';
            return [need];
        }
        if (Array.isArray(trace)) {
            const rec = trace.filter(r => r.preFail && Object.hasOwn(r, 'need'));
            if (rec.length) return [this._checkNeed(rec[rec.length - 1].need, `contract of ${rec[rec.length - 1].name}`)];
        }
        const goal = this._resolveGoal(task);
        if (goal.kind === 'ensure') {
            const inv = state.inventory;
            if (Object.hasOwn(inv, goal.item) && inv[goal.item] > 0) return null;
            return [this._checkNeed({ item: goal.item, count: 1, reason: 'place' }, 'game data')];
        }
        // fix83: nothing in the game data says where a block is: a reach goal that fails is decomposed / written by the model
        if (goal.kind === 'reach') return null;
        // smelt goals ("Smelt N <raw> into N <out>") are furnace work the crafting recipes do not describe.
        // fix90: a skill/open goal (and a smelt goal) can still lack an item of a kind. Item goals keep the recipe plan below.
        if (goal.kind !== 'item' || Object.hasOwn(goal, 'input')) {
            const kind = this._kindInputNeeds(task, trace, state, goal);
            if (kind !== null) return kind;
            return null;
        }
        const pre = this._obtainPlanner(state).prerequisites(goal.item, goal.count, state.inventory);
        for (const t of pre.ties) console.log(`[backchain] cost tie broken (proven edges, then name) planning ${goal.item}: ${t}`);
        if (pre.cycles.length) console.log(`[backchain] LOUD: ${pre.cycles.length} recipe cycle(s) in the game data excluded while planning ${goal.item}, through: ${[...new Set(pre.cycles.flatMap(c => c.split(' -> ')))].join(', ')}`);
        if (!pre.steps.length) {
            // fix87: a raw resource's game-data plan is "collect it from its source block", with nothing else missing
            // (a log drops by hand). That used to return null, so "no log in range" never became a reach need.
            // A source the pathfinder can reach is a different failure: do not invent a reach need for it.
            // Seeing the block is not that. Each seen source is one getPathTo of its perceived position.
            if (pre.how === 'collect') {
                if (!Array.isArray(state.nearby_blocks)) throw new Error('[fix87] _failureNeeds: state.nearby_blocks required');
                const src = this._obtainPlanner(state).sources(goal.item);
                const near = new Set(state.nearby_blocks);
                const usable = [];
                const unjudged = [];
                for (const b of src) {
                    if (!near.has(b)) continue;
                    const at = state.perceived_at && state.perceived_at[b];
                    if (!at) throw new Error(`[fix97] ${b} is perceived but has no position. Reachability is pathToBlock of that block, not membership of nearby_blocks.`);
                    const status = state._reach && Object.hasOwn(state._reach, b) ? state._reach[b] : null;
                    if (status === 'success') usable.push(b);
                    else if (status === null) unjudged.push(b);
                    else if (status !== 'noPath') throw new Error(`[fix97] ${b} reach status ${JSON.stringify(status)} is not success or noPath`);
                }
                // stopAtSuccess leaves only sources past a success unjudged, and a success is usable.
                // A nearby source nobody searched is not unreachable.
                if (usable.length === 0 && unjudged.length > 0) {
                    throw new Error(`[fix97] ${unjudged.join(', ')} is nearby and has not been searched. Reachability is pathToBlock of that block, not membership of nearby_blocks.`);
                }
                if (src.length > 0 && usable.length === 0) {
                    const blocksByName = this.agent.bot.registry.blocksByName;
                    const need = reachNeedForBlocks(blocksByName, src, goal.count);
                    if (need === null) throw new Error(`[fix87] LOUD: source blocks of ${goal.item} (${src.join(', ')}) are not blocks in the game data`);
                    console.error(`!!! [fix87] LOUD: "${task}": no source block the pathfinder can reach (${src.join(', ')}); reach need`);
                    return [this._checkNeed(need, 'no source block in range')];
                }
            }
            return null;
        }
        return pre.steps.map(st => this._checkNeed({ item: st.item, count: st.count, reason: pre.tool === null ? 'ingredients' : 'tool' }, 'game data'));
    }
    // fix89: the deepest failure line annotateTrace already pulled out of the run's own output (ownFail).
    //        _replay copies it onto the result so a serve failure is not "without a reason" while the output holds the evidence.
    _failureReason(trace) {
        if (!Array.isArray(trace)) return null;
        let best = null;
        for (const r of trace) {
            if (!Array.isArray(r.ownFail)) continue;
            const depth = r.depth;
            if (typeof depth !== 'number') throw new Error(`[fix89] trace frame ${JSON.stringify(r.name)} has no numeric depth`);
            for (const line of r.ownFail) {
                if (typeof line !== 'string') continue;
                if (line.length === 0) continue;
                if (best === null) best = { depth, name: r.name, line };
                else if (depth > best.depth) best = { depth, name: r.name, line };
            }
        }
        if (best === null) return null;
        return `${best.name}: ${best.line}`;
    }
    _checkNeed(need, source) { return { ...checkNeed(need, source), source }; }
    // fix81: chain on what the failed goal lacks (not only on the goal item). Each need becomes a subgoal in
    //        progress.subgoals (ahead of a {retry, prereq} entry for the goal), pursued by the normal path: a learned
    //        producer's replay if there is one, else code generation; when IT fails, its own needs are chained the same way
    //        (stone_pickaxe -> stick -> oak_planks -> oak_log). anyOf is resolved by the game-data cost (recipe_plan.js).
    //        A subgoal chain that comes back to something an ancestor seeks throws; a prereq retry that still lacks it is a
    //        failed goal, not re-run and not re-queued. Returns true when it handled the goal.
    // fix90: a curriculum replay that happens inside a need serve (currentTask need:hunger) chains for that need,
    // so _needServePending yields the next step to the subgoals. A raiser replay already passes the need label.
    _chainOwner(task) {
        if (typeof this.currentTask === 'string' && this.currentTask.startsWith('need:')) return this.currentTask;
        return task;
    }
    // fix91b: the subgoal still pursues one item (cheapest of an anyOf). The blocker keeps the need's own shape:
    // item XOR anyOf, anyOf copied. A need with neither is not written.
    _resolveChainedNeed(n, inv, state, goal, task) {
        const selector = readBlockerNames(n, `[fix91b] need must name exactly one of item / anyOf: ${JSON.stringify(n)}`);
        let item;
        if (Object.hasOwn(selector, 'anyOf')) {
            const ch = this._obtainPlanner(state).cheapest(selector.anyOf, n.count, inv, false);
            for (const t of ch.ties) console.log(`[backchain] cost tie broken (proven edges, then name): ${t}`);
            item = ch.item;
        } else {
            item = selector.item;
        }
        // fix86: a contract that names one harvest tool (iron_pickaxe) is not the block's harvestTools.
        //        The game data lists every tool that drops the goal; the cheapest of that set is the need.
        if (n.reason === 'contract' && goal.kind === 'item' && item !== goal.item) {
            const tools = this._obtainPlanner(state).toolsNeeded(goal.item, inv);
            if (Array.isArray(tools) && tools.includes(item)) {
                const ch = this._obtainPlanner(state).cheapest(tools, n.count, inv, false);
                for (const t of ch.ties) console.log(`[backchain] cost tie broken (proven edges, then name): ${t}`);
                console.log(`[fix86] contract named ${item} for "${task}"; harvestTools choose ${ch.item} from [${tools.join(', ')}]`);
                item = ch.item;
                if (Object.hasOwn(selector, 'item')) selector.item = item;
            }
        }
        if (typeof item !== 'string') throw new Error(`[fix91b] need resolved to no item: ${JSON.stringify(n)}`);
        if (item.length === 0) throw new Error(`[fix91b] need resolved to no item: ${JSON.stringify(n)}`);
        const out = { item, count: n.count, reason: n.reason, source: n.source, selector };
        if (typeof n.owner === 'string') out.owner = n.owner;
        return out;
    }
    _chainNeeds(task, needs, state) {
        const cur = this._curSub !== null && this._curSub !== undefined && this._curSub.task === task ? this._curSub : null;
        const chain = this._prereqChain(cur);
        const goal = this._resolveGoal(task);
        const inv = state.inventory;
        const resolved = [];
        for (const n of needs) {
            const picked = this._resolveChainedNeed(n, inv, state, goal, task);
            // fix84: a slot need names the drop that will not fit. That item IS the collect goal, and expanding it
            //        into the goal's own prerequisites would ask for the same item again instead of a free slot.
            if (goal.kind === 'item' && picked.item === goal.item && n.reason !== 'proximity' && n.reason !== 'reach' && n.reason !== 'slot') {
                // the goal's own item could not be made: what it lacks is its own game-data prerequisites
                const own = this._failureNeeds(task, null, null, state);
                if (own === null) { console.log(`[backchain] "${task}": ${picked.item} reported missing, but the game data shows nothing it lacks`); continue; }
                for (const o of own) resolved.push(this._resolveChainedNeed(o, inv, state, goal, task));
                continue;
            }
            resolved.push(picked);
        }
        if (!resolved.length) return false;
        const desc = resolved.map(n => `${n.count} ${n.item} (${n.reason}, ${n.source})`).join(', ');
        if (cur !== null && cur.retry === true && cur.prereq === true) {
            console.log(`!!! [backchain] LOUD: "${task}" still lacks ${desc} after its prerequisite subgoals ran; not re-queued`);
            this._recordGoalOutcome(task, false, `prerequisite still missing: ${desc}`);
            return true;
        }
        const keyed = goal.kind === 'item' || goal.kind === 'ensure' || goal.kind === 'reach' || goal.kind === 'skill';
        const below = keyed ? [...chain, this._goalKey(goal)] : chain;
        const subs = [];
        for (const n of resolved) {
            const key = this._needKey(n);
            // fix84: a slot need whose key is already on the chain is the chest→logs→slot loop. A craft whose net
            //        slot change (stack sizes) is negative breaks it; otherwise it is a real cycle and throws.
            if (below.includes(key)) {
                if (n.reason !== 'slot') throw new Error(`[fix81] LOUD: subgoal cycle ${[...below, key].join(' -> ')} (need of "${task}")`);
                subs.push(this._slotAction(task, n, below, state));
                continue;
            }
            subs.push(this._subgoalForNeed(n, state, task, below));
        }
        const runnable = [];
        for (const sb of subs) {
            if (sb.met === true) continue;
            if (typeof sb.task !== 'string' || sb.task.length === 0) throw new Error(`[fix92] subgoal has no task: ${JSON.stringify(sb.need)}`);
            if (sb.task === task) throw new Error(`[fix86] LOUD: subgoal cycle: "${task}" decomposes into itself`);
            runnable.push(sb);
        }
        const edges = this.progress.recipeEdges;
        for (const sb of runnable) if (sb.edge !== null && !Object.hasOwn(edges, sb.edge)) edges[sb.edge] = { task: sb.task, status: 'untried', runs: 0, fails: 0 };
        const d = (this.progress.decomposed ||= {}), q = (this.progress.subgoals ||= []);
        const depth = cur === null ? 0 : cur.depth;
        d[task] = { subs: subs.map(sb => sb.task), skills: [], at: Date.now(), reason: `needs: ${desc}` };
        // fix83: a need's count is a SHORTFALL (how many more), the subgoal's task names that delta ("Collect 1 oak_planks") and
        //        its run is verified by the gain (gainedFor >= 1), but the pre-run check read it as an absolute count: with 1 of the 2
        //        oak_planks "Craft 3 sticks" needs held, "Collect 1 oak_planks" was "already satisfied (1/1)" and never ran (live
        //        19:01-19:05 GMT, twice). The entry carries what the parent needs HELD (held now + shortfall); the pre-run check of
        //        that entry and the blocker use it, so the delta and the absolute target cannot disagree.
        const target = (n, sbTask) => {
            const g = this._resolveGoal(sbTask);
            if (g.kind !== 'item' || g.item !== n.item) return null;   // a learned task for another item is verified by its own goal
            const held = Object.hasOwn(inv, n.item) ? inv[n.item] : 0;
            return { item: n.item, count: held + n.count };
        };
        const slotWork = runnable.some(sb => sb.need && sb.need.reason === 'slot');
        const retryChain = slotWork ? [...chain, 'slot'] : chain;
        q.unshift(...runnable.map(sb => {
            // fix84: descendants of a slot need see 'slot' on the chain, so the logs a chest needs notice the loop
            const entryChain = sb.need.reason === 'slot' ? [...below, 'slot'] : below;
            const entry = { task: sb.task, parent: task, depth: depth + 1, chain: entryChain, edge: sb.edge };
            if (sb.slotRequest) entry.slotRequest = sb.slotRequest;
            const t = target(sb.need, sb.task);
            if (t !== null) entry.atLeast = t;
            return entry;
        }), { task, retry: true, prereq: true, depth, chain: retryChain });
        // fix47's curriculum blockers, now from the structured needs (was the "Cannot break X" critic text); fix83: resolved once
        //        the bot HOLDS what the goal needs (held at the failure + shortfall), not once it holds the shortfall.
        //        fix84: a slot's count is how many more will not fit, not an absolute stack to hold.
        //        fix91b: an anyOf need is stored as anyOf (copied), not as item: undefined. Its count is the need's count
        //        of any one member (cheapest plans that many of one item; members are not summed). A single item still
        //        stores held + shortfall, except proximity / reach / slot.
        this.progress.blockers = this.progress.blockers.filter(b => b.task !== task);
        const shortfallOnly = new Set(['proximity', 'reach', 'slot']);
        for (const n of resolved) {
            const sel = n.selector;
            let count = n.count;
            if (!shortfallOnly.has(n.reason) && Object.hasOwn(sel, 'item')) {
                const held = Object.hasOwn(inv, sel.item) ? inv[sel.item] : 0;
                count = held + n.count;
            }
            const row = { count, reason: n.reason, task, at: Date.now() };
            if (Object.hasOwn(sel, 'anyOf')) row.anyOf = sel.anyOf;
            else row.item = sel.item;
            this.progress.blockers.push(row);
        }
        this._saveProgress();
        const shown = runnable.length ? runnable.map(sb => sb.task).join(', ') : '(already fits)';
        console.log(`[psn] DECOMPOSE (needs) "${task}" -> ${shown}; lacks ${desc}`);
        return true;
    }
    // fix91b: an anyOf blocker is met when one member is held at >= count. Not the sum: cheapest() plans `count` of one item.
    _blockerSatisfied(b, inv) {
        assertProgressBlocker(b);
        if (b.reason === 'slot') {
            const bot = this.agent.bot;
            if (!bot || !bot.inventory || !Array.isArray(bot.inventory.slots)) throw new Error('[fix92] slot blocker needs the live inventory slots');
            if (typeof b.item !== 'string') throw new Error(`[fix92] slot blocker has no item: ${JSON.stringify(b)}`);
            return world.roomForItem(bot, b.item) >= b.count;
        }
        if (Object.hasOwn(b, 'anyOf')) {
            for (const name of b.anyOf) {
                if (Object.hasOwn(inv, name) && inv[name] >= b.count) return true;
            }
            return false;
        }
        return Object.hasOwn(inv, b.item) && inv[b.item] >= b.count;
    }
    _blockerLabel(b) {
        assertProgressBlocker(b);
        if (Object.hasOwn(b, 'anyOf')) return `one of ${b.anyOf.join(', ')}`;
        return b.item;
    }
    // fix81: the curriculum's BLOCKERS line, from the structured needs of failed goals (_chainNeeds); a need is resolved once held.
    //        fix91b: anyOf renders as "one of a, b, c" (the full list; other anyOf text joins every name, it does not truncate).
    // fix96: a blocker is what an OPEN goal lacks. _chainNeeds writes it together with the goal's retry entry in
    //        progress.subgoals; once that entry has left the queue (run, dropped as stale, backed off) the goal is no
    //        longer pursued and its need is not a blocker of anything. Those rows used to stay forever (47 rows, 44 of
    //        them for goals no longer queued, e.g. "needs 395 torch" from Nov 6) and were ~9.7k chars of the curriculum prompt.
    _openGoalTasks() {
        if (!Object.hasOwn(this.progress, 'subgoals')) return new Set();
        if (!Array.isArray(this.progress.subgoals)) throw new Error(`[fix96] progress.subgoals must be an array, got ${JSON.stringify(this.progress.subgoals)}`);
        return new Set(this.progress.subgoals.map(s => s.task));
    }
    _blockerHint(inv) {
        const open = this._openGoalTasks();
        const closed = this.progress.blockers.filter(b => !open.has(b.task));
        if (closed.length > 0) {
            const tasks = [...new Set(closed.map(b => b.task))];
            console.log(`[fix96] ${closed.length} blocker(s) dropped: their goal is no longer queued (${tasks.map(t => JSON.stringify(t)).join(', ')})`);
        }
        const before = this.progress.blockers.length;
        this.progress.blockers = this.progress.blockers.filter(b => open.has(b.task) && !this._blockerSatisfied(b, inv));
        if (this.progress.blockers.length !== before) this._saveProgress();
        const blockers = this.progress.blockers;
        return blockers.length > 0
            ? `\nBLOCKERS (prioritize these - what failed goals lack): ${blockers.map(b => `"${b.task}" needs ${b.count} ${this._blockerLabel(b)} (${b.reason})`).join('; ')}`
            : '';
    }
    // fix81: a game-data producer edge (progress.recipeEdges[item] = { task, status }) is a fact only once a run of its task proves it
    _noteEdgeOutcome(task, ok) {
        if (!Object.hasOwn(this.progress, 'recipeEdges')) return;
        for (const [item, e] of Object.entries(this.progress.recipeEdges)) {
            if (e.task !== task) continue;
            e.runs++;
            if (ok) e.status = 'proven';
            else e.fails++;
            console.log(`[backchain] game-data edge for ${item} ("${task}"): ${ok ? 'PROVEN by a run' : `failed (${e.fails}/${e.runs})`}`);
        }
    }
    // fix51: pick a subgoal task string from learned producers / consumes chain (depth-first on missing inputs)
    // fix54: `path` = items already being sought on this branch; a learned consumes cycle (A needs B needs A)
    // ends that branch (logged) instead of recursing until the stack overflows
    _subgoalToObtainItem(item, shortfall, inv, path) {
        const producers = this._producers(item);
        if (!producers.length) return null;
        const picked = this._boltzmann(producers);
        const skill = picked.s;
        const consumes = Object.hasOwn(skill, 'consumes') ? skill.consumes : {};
        const onPath = new Set(path).add(item);
        for (const [consumed, amt] of Object.entries(consumes)) {
            const have = inv[consumed] || 0;
            if (have < amt) {
                if (onPath.has(consumed)) {
                    console.log(`[psn] subgoal cycle: ${[...onPath, consumed].join(' -> ')} (via ${skill.name}); not descending`);
                    continue;
                }
                const sub = this._subgoalToObtainItem(consumed, amt - have, inv, onPath);
                if (sub) return sub;
            }
        }
        if (skill.task) {
            // fix95: a parameterised producer (craftItem, task "Craft N of an item") can make the item, but its task does
            //        not name it, so it is not a subgoal for it. fix86 threw here; the throw recurred on every step and the
            //        same step error twice exited the process (live 17:15 GMT 9 Nov, iron_pickaxe; later stick). The
            //        learned path has no subgoal for this item: null, and _subgoalForNeed takes the game-data plan, whose
            //        task names the item (routing still replays craftItem for it).
            if (this._taskIsGenericFor(skill, item)) {
                console.log(`!!! [psn] LOUD: learned producer ${skill.name} makes ${item}, but its task ${JSON.stringify(skill.task)} does not name ${item}; not a subgoal, the game data names it`);
                return null;
            }
            return skill.task;
        }
        return null;
    }
    // fix95: true when the skill has a task and that task does not name `item` (as its item goal or as a word).
    _taskIsGenericFor(skill, item) {
        if (!skill.task) return false;
        if (skill.task.split(/[^A-Za-z0-9_]+/).includes(item)) return false;
        const g = this._resolveGoal(skill.task);
        return !(g.kind === 'item' && g.item === item);
    }
    // fix84: one need, one subgoal. proximity and reach are placement/search. A slot is a whole-slot capacity plan
    //        (fix92). Anything else is a learned producer, else the game data.
    _subgoalForNeed(n, state, task, below) {
        if (n.reason === 'proximity') return { task: `ensure ${n.item}`, need: n, edge: null };
        if (n.reason === 'reach') return { task: `reach ${n.item}`, need: n, edge: null };
        if (n.reason === 'slot') return this._slotAction(task, n, below, state);
        const learned = this._subgoalToObtainItem(n.item, n.count, state.inventory, new Set());
        if (learned !== null) return { task: learned, need: n, edge: null };
        return { task: this._obtainPlanner(state).prerequisites(n.item, n.count, state.inventory).task, need: n, edge: n.item };
    }
    _buildCapacityPlan(req, state, slotsNeeded) {
        const bot = this.agent.bot;
        if (typeof bot.recipesAll !== 'function') throw new Error('[fix92] bot.recipesAll required');
        const goal = this._resolveGoal(req.parent);
        let goalItem = req.item;
        let goalCount = req.count;
        if (goal.kind === 'item') { goalItem = goal.item; goalCount = goal.count; }
        const planner = this._obtainPlanner(state);
        return capacityPlan({
            registry: bot.registry,
            skills: this.skills,
            stacks: inventoryStacks(bot),
            slotsNeeded,
            goalItem,
            goalCount,
            needItem: req.item,
            prerequisites: (item, count, inv) => planner.prerequisites(item, count, inv),
            toolsNeeded: item => planner.toolsNeeded(item, {}),
            recipesOf: id => bot.recipesAll(id, null, true),
        });
    }
    // fix92: serve the capacity need before reach, explore, or repair. Toss only when it empties whole slots.
    //        A craft that frees slots is the cycle break once a toss is already on the chain. No safe plan throws.
    _slotAction(task, n, below, state) {
        if (typeof n.owner !== 'string' || n.owner.length === 0) throw new Error(`[fix92] slot need has no traced owner: ${JSON.stringify(n)}`);
        const bot = this.agent.bot;
        const counts = stackableCounts(bot);
        const room = roomFor(bot.registry, counts, n.item);
        const slotsNeeded = emptySlotsToFit(bot.registry, counts, n.item, n.count);
        console.log(`[slot] need item=${n.item} count=${n.count} owner=${n.owner} parent=${task} room_before=${room} slots_needed=${slotsNeeded}`);
        if (slotsNeeded < 1) return { met: true, task: null, need: n, edge: null };
        const req = { item: n.item, count: n.count, owner: n.owner, parent: task, slotsNeeded };
        const plan = this._buildCapacityPlan(req, state, slotsNeeded);
        const chain = Array.isArray(below) ? below : [];
        const again = chain.includes('slot');
        if (!again && plan.freed >= slotsNeeded) {
            const toss = this.skills.find(s => s.name === 'tossClutter');
            if (!toss) throw new Error(`[fix92] LOUD: capacity plan frees ${plan.freed} slot(s) for ${n.item} but tossClutter is not in the library`);
            if (!toss.contract || typeof toss.contract.post !== 'string') throw new Error('[fix92] LOUD: tossClutter has no post-contract, so a toss cannot be verified');
            const post = toss.contract.post;
            if (!post.includes('c.post.free')) throw new Error(`[fix92] LOUD: tossClutter post does not measure empty slots (${post})`);
            if (!post.includes('c.pre.free')) throw new Error(`[fix92] LOUD: tossClutter post does not measure empty slots (${post})`);
            return { task: toss.name, need: n, edge: null, slotRequest: { ...req, removals: plan.removals } };
        }
        if (plan.craft !== null && plan.craft.freed >= slotsNeeded && !chain.includes(plan.craft.item)) {
            console.log(`[slot] craft ${plan.craft.task} frees ${plan.craft.freed} slot(s) for ${n.item}`);
            return { task: plan.craft.task, need: n, edge: plan.craft.item };
        }
        const rejected = [];
        for (const c of plan.candidates) if (c.potential < 1) rejected.push(`${c.item}(keep ${c.keep})`);
        const why = plan.craft === null ? 'no slot-freeing craft' : `craft ${plan.craft.item} is already on the chain`;
        let detail = rejected.join(', ');
        if (detail.length === 0) detail = 'none';
        throw new Error(`[fix92] LOUD: no whole-slot plan frees ${slotsNeeded} slot(s) for ${n.count} ${n.item} (${why}; rejected: ${detail})`);
    }
    async _tossClutterCall(entry) {
        const req = entry.slotRequest;
        if (!req || typeof req.item !== 'string' || !Number.isInteger(req.count) || req.count < 1) throw new Error(`[fix92] tossClutter subgoal has no slot request: ${JSON.stringify(entry)}`);
        const bot = this.agent.bot;
        const live = emptySlotsToFit(bot.registry, stackableCounts(bot), req.item, req.count);
        if (live < 1) throw new Error(`[fix92] LOUD: ${req.item} already fits; tossClutter plan is stale`);
        const seen = this.observe();
        await this._judgeItems(seen, this._capacityItems(req), false);
        const plan = this._buildCapacityPlan(req, seen, live);
        if (plan.freed < live) throw new Error(`[fix92] LOUD: tossClutter plan is stale; it frees ${plan.freed} of ${live} slot(s) for ${req.item}`);
        bot.__capacityPlan = plan.removals;
        return `await tossClutter(bot, ${live}, ${JSON.stringify(plan.removals)});`;
    }
    // fix74: how long a skill has been seen to run before returning on its own, from the trace of every traced run (replay,
    //        writeCode, practice): skill.runMs = { n, max }. A call that was interrupted (rec.intr) or never returned (no t1)
    //        did not show how long the skill takes, so it is not a sample.
    _learnRunDurations(trace) {
        if (!Array.isArray(trace)) throw new Error('[psn] _learnRunDurations: no trace');
        for (const r of trace) {
            if (r.intr || typeof r.t1 !== 'number' || typeof r.t0 !== 'number') continue;
            const e = this.skills.find(s => s.name === r.name);
            if (!e) continue;
            const ms = r.t1 - r.t0;
            if (!Object.hasOwn(e, 'runMs')) e.runMs = { n: 0, max: ms };
            e.runMs.n++;
            if (ms > e.runMs.max) e.runMs.max = ms;
        }
    }
    // fix74: the practice cap is the longest this skill has been seen to run before returning on its own (_learnRunDurations).
    //        A practice run that is still going past it is outside everything this skill has done: it is cut and counted as a
    //        failure, as a cut-off replay is (fix14). Task runs are not capped by it, so a slower real run raises it.
    //        A skill with NO observed run has no cap, by design: there is nothing to derive one from, and any number would be
    //        a guess. Its run ends when it returns or when the code-model call completes (the abort signal), whichever is
    //        first; the abort is not a verdict on the skill, so it gets no stats, and the first run that returns on its own is
    //        its first sample.
    _practiceBound(skill) {
        return Object.hasOwn(skill, 'runMs') ? skill.runMs.max : null;
    }
    // fix74: what a finished practice run says about the skill. ok true/false is counted; ok null is no verdict. Before, the
    //        result fed only stats.lastRun/practiceRuns (fa01ee3), so n never moved and the Beta-uncertainty ranking (fix49)
    //        picked the same n=1 skill forever (travelWestAvoidDeathHotspot: 311 practice runs by 15:47 GMT, stats still 1/0).
    //   - a learned post-contract judges it on the run's own trace (as open goals are, fix55/fix56)
    //   - else the effects verified by run evidence (fix74 effectEvidence) judge it by inventory gain
    //   - else nothing can judge it: an inventory change is not a success (fix51's "any delta" counted a walk that picked
    //     up a block); _selectPracticeSkill does not pick such a skill
    _practiceRunChanged(skill, before, after) {
        if (this._postJudges(skill)) {
            const held = this._postHolds(skill);
            if (!held) return { ok: false, detail: `learned post ${skill.contract.post} does not hold` };
            const v = this._postVerifiesRun(skill);
            // fix87: ok null is "this run is not evidence", not a violation. ok false is a bad post and is queued once.
            // fix95: and it is learned on the skill: this post cannot judge a practice run, so the skill is not picked to
            //        practise on it again until its contract changes (live: logCactusAbsence picked 76 times in 1h27m,
            //        NO VERDICT every time, its repair already rejected, stats never moved).
            if (v.ok === false) {
                skill.postUnverifiable = { pre: skill.contract.pre, post: skill.contract.post, why: v.why, at: new Date().toISOString() };
                this._saveSkills();
                this._queueContractFix(skill, `post cannot verify a run: ${v.why}`);
                return { ok: null, detail: `post ${skill.contract.post} held but cannot verify a run (${v.why}); queued contract repair; not practised on this post again` };
            }
            if (v.ok === null) return { ok: null, detail: v.why };
            if (v.ok !== true) throw new Error(`[fix87] _postVerifiesRun(${skill.name}) returned ok=${JSON.stringify(v.ok)}`);
            return { ok: true, detail: `learned post ${skill.contract.post} holds` };
        }
        const effects = verifiedEffects(skill);
        if (effects.length) {
            const gained = effects.filter(it => invCount(after.inventory, it) > invCount(before.inventory, it));
            if (gained.length) return { ok: true, detail: `+${gained.join(',')}` };
            return { ok: false, detail: `no gain for verified effects [${effects.join(',')}]` };
        }
        return { ok: null, detail: 'no learned post-contract and no verified effects to judge it by' };
    }
    _practiceJudgeable(skill) { return this._postJudges(skill) || verifiedEffects(skill).length > 0; }
    // fix95: a learned post judges a practice run unless a run already showed that this exact contract (pre and post)
    //        cannot verify one. A changed contract (contract repair) is judged again.
    _postJudges(skill) {
        if (!skill.contract || !skill.contract.post) return false;
        if (!Object.hasOwn(skill, 'postUnverifiable')) return true;
        const u = skill.postUnverifiable;
        if (u === null || typeof u !== 'object' || typeof u.post !== 'string') throw new Error(`[fix95] ${skill.name}.postUnverifiable must be { pre, post, why }, got ${JSON.stringify(u)}`);
        return u.post !== skill.contract.post || u.pre !== skill.contract.pre;
    }
    // fix32 (H): does the root call of the last trace satisfy the skill's learned postcondition (and report success)?
    // fix55: the verifier of skill and open goals; every "does not hold" says why
    _postHolds(e) {
        if (!e?.contract?.post) throw new Error(`[fix55] LOUD FAIL: _postHolds(${e?.name}) without a learned post-contract`);
        const tr = this.agent.bot.__psnTrace;
        if (!Array.isArray(tr)) { console.log(`[psn] post of ${e.name}: no execution trace recorded -> does not hold`); return false; }
        const r = tr.find(t => t.name === e.name && (t.parent ?? -1) < 0);
        const why = !r ? 'no root call in the trace' : r.intr ? 'interrupted' : !r.s0 || !r.s1 ? 'no pre/post state snapshot' : r.fail ? 'the call failed' : r.rv === false || r.rv === null ? `it returned ${r.rv}` : null;
        if (why) { console.log(`[psn] post of ${e.name}: ${why} -> does not hold`); return false; }
        try { return this._compileContract(e.contract.post)(this._contractCtx({ args: r.argv, ret: r.rv, pre: r.s0, post: r.s1, delta: r.delta })) === true; }
        catch (err) { console.log(`!!! [contract] ${e.name}.post THREW: ${err.message}; does not hold, queued contract repair`); this._queueContractFix(e, `post threw: ${err.message}`); return false; }
    }

    // fix56: can this post-contract verify a goal at all, judged on the run that just happened?
    //  1) AST: the post must read something the run produces: c.ret, c.delta or c.post.* (c.dist(c.pre.pos, c.post.pos) counts via c.post.pos)
    //  2) null-run counterfactual: the same post on a run that did nothing (ret undefined, post state = pre state, empty delta) must be false;
    //     a post that also holds when nothing happened (e.g. "!c.ret || (c.post.alive && c.pre.dim === c.post.dim)") verifies nothing.
    //     fix87: only a run whose pre held is that experiment. A pre-false no-op (the axe is already in hand, so the skill
    //     correctly changes nothing and the post is already true) is not evidence for or against the post.
    //  3) falsy ret: when the real ret is falsy, the pass must come from the state change, not from a "!c.ret ||" guard:
    //     the post with the real ret but no state change must be false. Same pre-held rule as (2).
    _postVerifiesRun(e) {
        const src = e.contract.post;
        const { root, param } = this._parseContract(src);
        if (param === null) return { ok: false, why: 'post takes no parameter, so it reads nothing from the run' };
        const reads = new Set();
        this._walkAst(root.body, node => { if (node.type !== 'MemberExpression') return; const p = this._contractPath(node, param); if (p && p.length) reads.add(p[0] === 'post' ? 'post' : p[0]); });
        if (!['ret', 'delta', 'post'].some(k => reads.has(k))) return { ok: false, why: `post reads only [${[...reads].join(', ')}], nothing the run produced (ret, delta, post state)` };
        const r = this.agent.bot.__psnTrace.find(t => t.name === e.name && (t.parent ?? -1) < 0);
        // fix87: pre false -> this run neither confirms nor refutes the post's discriminative power. No violation.
        if (typeof e.contract.pre === 'string') {
            const preHeld = this._compileContract(e.contract.pre)(this._contractCtx({ args: r.argv, ret: r.rv, pre: r.s0, post: r.s1, delta: r.delta }));
            // fix95: a learned pre that returns a non-boolean (c.pre.inv.x && ... is undefined when x is not held) is a bad
            //        contract, the same as a post that cannot verify a run: the caller queues its repair. Thrown, it was an
            //        unhandled rejection in idle practice (live 9 Nov, tossOneRawCopper.pre returned undefined).
            if (preHeld !== true && preHeld !== false) return { ok: false, why: `pre ${e.contract.pre} returned ${preHeld === undefined ? 'undefined' : JSON.stringify(preHeld)}, not a boolean` };
            if (preHeld === false) return { ok: null, why: 'pre did not hold, so this run is not evidence for or against the post' };
        }
        const f = this._compileContract(src), dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (f(this._contractCtx({ args: r.argv, ret: undefined, pre: r.s0, post: r.s0, delta: {} })) === true) return { ok: false, why: 'post also holds for a run that did nothing (ret undefined, no state change)' };
        if (!r.rv && f(this._contractCtx({ args: r.argv, ret: r.rv, pre: r.s0, post: r.s0, delta: {} })) === true) return { ok: false, why: `ret was ${JSON.stringify(r.rv)} and the post holds from ret alone (vacuous guard), not from what the run changed` };
        return { ok: true };
    }

    // fix47: compute what can be produced from current inventory via learned producers ONLY
    // NO hard-coded name patterns - uses only learned skill consumes/effects
    // Returns { count, sources: [{item, count, ratio, producer, task}] } where count is total producible
    _computeProducibleFromInventory(targetItem, inv) {
        const sources = [];
        let total = inv[targetItem] || 0;
        sources.push({ type: 'inventory', item: targetItem, count: total });
        
        // Use ONLY learned producers from skills with effects containing targetItem
        // Get ratio from skill's learned .consumes, store skill's task for subgoal generation
        const producers = this._producers(targetItem);
        for (const { s: skill } of producers) {
            const consumes = skill.consumes || {};
            
            // For each consumed item, check if we have it in inventory
            for (const [consumeItem, consumeCount] of Object.entries(consumes)) {
                const haveCount = inv[consumeItem] || 0;
                if (haveCount > 0 && !sources.some(s => s.item === consumeItem && s.producer === skill.name)) {
                    // Ratio: how many target items per consume (from learned delta)
                    // Default to 1:1 if consumeCount is 0 or missing (shouldn't happen)
                    const ratio = consumeCount > 0 ? 1 / consumeCount : 1;
                    const producibleFromThis = Math.floor(haveCount * ratio);
                    sources.push({ 
                        type: 'learned_producer',
                        item: consumeItem, 
                        count: producibleFromThis,
                        ratio,
                        producer: skill.name,
                        task: skill.task  // Store the learned skill's task for subgoal
                    });
                    total += producibleFromThis;
                }
            }
        }
        
        return { count: total, sources };
    }

    // fix47: compute the real shortfall after considering inventory + producible items
    // Returns { shortfall, plan, produceItems } where plan is 'learned', 'none', or 'gather'
    _computeShortfall(goal, inv) {
        const targetItem = goal.item;
        const targetCount = goal.count;
        
        const producible = this._computeProducibleFromInventory(targetItem, inv);
        const shortfall = Math.max(0, targetCount - producible.count);
        
        if (shortfall === 0) {
            // Can satisfy from inventory + producing
            const produceSources = producible.sources.filter(s => s.type !== 'inventory' && s.count > 0);
            if (produceSources.length > 0) {
                return { shortfall: 0, plan: 'learned', produceItems: produceSources, producible };
            }
            return { shortfall: 0, plan: 'none', producible };
        }
        
        return { shortfall, plan: 'gather', producible };
    }

    // fix51: goal satisfaction = ONE path only — resolved product item + exact inventory+equipment count
    // Sub-skill / component contract posts must NEVER mark a parent goal satisfied
    _goalAlreadySatisfied(task, state) {
        const goal = this._resolveGoal(task);
        if (goal.kind === 'invalid') throw new Error(`[fix55] LOUD FAIL: satisfaction check of invalid goal "${task}": ${goal.why}`);
        // fix55: skill/open goals have no learned pre-run predicate (posts read c.ret/c.delta of a run): verified after running, never by item counts
        if (goal.kind === 'skill') return { satisfied: false, reason: `skill goal: verified by ${goal.skill.name}'s learned post-contract after it runs`, goal };
        if (goal.kind === 'open') return { satisfied: false, reason: 'open goal: verified by the routed skill\'s learned post-contract after it runs', goal };

        // fix49: for "ensure" goals, check observed state directly (exact block-name match)
        if (goal.kind === 'ensure') {
            if (this._ensureHolds(goal, state)) return { satisfied: true, reason: `${goal.item} is already placed nearby (observed state)` };
            return { satisfied: false, reason: `${goal.item} not found nearby (need to place it)`, goal };
        }

        // fix83: "reach <block>" holds when the block is observed nearby (the same observation an ensure goal reads)
        if (goal.kind === 'reach') {
            if (this._reachHolds(goal, state)) return { satisfied: true, reason: `${goal.item} is within reach (observed nearby)` };
            return { satisfied: false, reason: `${goal.item} not observed nearby (need to find it)`, goal };
        }

        const inv = state.inventory;
        // fix83: a need subgoal (_chainNeeds) is satisfied when the bot holds what its parent needs, not the delta its task names
        const cur = this._curSub !== null && this._curSub !== undefined && this._curSub.task === task && Object.hasOwn(this._curSub, 'atLeast') ? this._curSub : null;
        if (cur !== null) {
            if (cur.atLeast.item !== goal.item) throw new Error(`[fix83] LOUD: subgoal "${task}" targets ${cur.atLeast.item} but its goal is ${goal.item}`);
            const held = Object.hasOwn(inv, goal.item) ? inv[goal.item] : 0;
            if (held >= cur.atLeast.count) return { satisfied: true, reason: `already hold ${held}/${cur.atLeast.count} ${goal.item} (what "${cur.parent}" needs)` };
            return { satisfied: false, reason: `hold ${held} ${goal.item}; "${cur.parent}" needs ${cur.atLeast.count} (this subgoal gains ${goal.count})`, goal };
        }
        // fix51: inventory counts already include held/worn/off-hand slots; exact item name only (no double count)
        const haveExact = inv[goal.item] || 0;
        const shortfallInfo = this._computeShortfall(goal, inv);

        if (haveExact >= goal.count) {
            return { satisfied: true, reason: `already have ${haveExact}/${goal.count} ${goal.item} (exact inventory+equipment)` };
        }

        // fix47: check if we can produce enough via learned producers (inventory-first planning)
        // Note: this returns NOT satisfied but with a plan, so canProduce is appropriate here
        if (shortfallInfo.shortfall === 0 && shortfallInfo.produceItems?.length > 0) {
            const produceDesc = shortfallInfo.produceItems.map(s => `${s.count} ${s.item} via ${s.producer || s.type}`).join(', ');
            return {
                satisfied: false,
                reason: `need ${goal.count} ${goal.item}, can produce: ${produceDesc}`,
                plan: shortfallInfo,
                goal
            };
        }

        // 4) Not satisfied: don't have enough items
        // fix51: report exact inventory count, not producible count
        return { satisfied: false, reason: `need ${goal.count} ${goal.item}, have ${haveExact}`, plan: shortfallInfo, goal };
    }

    // fix32 (PSN backward chaining): a goal item is produced by a learned skill whose learned effects contain it; the skill is
    // chosen by Boltzmann sampling over V (T = 0.3); every item that skill consumes and the bot lacks is chained the same way
    // (depth <= 3). The plan runs as replays, children first; no model call.
    _boltzmann(c, T = 0.3) { const w = c.map(x => Math.exp(x.V / T)), tot = w.reduce((a, b) => a + b, 0); let r = Math.random() * tot; for (let i = 0; i < c.length; i++) if ((r -= w[i]) <= 0) return c[i]; return c[c.length - 1]; }
    // fix43: _producers now also checks NeedsProducesGraph for confirmed producers (learned from observation)
    // NO hard-coded ore/smelt tables - producers come from skill.effects and observed graph recordings
    // fix44: resolve mergedInto to validated active skills (merge targets that are not candidate/demoted)
    _producers(item) {
        const fromSkills = this.skills.filter(s => !s.demoted && !s.mergedInto && !s.candidate && !/^(repair|refactor)\b/.test(s.task || '') && s.effects.includes(item)
            && !(signatureOf(s.code, s.name).match(/\(([^)]*)\)/)?.[1] || '').split(',').slice(1).some(x => x.trim() && !x.includes('=')))
            .map(s => ({ s, V: this._maturity(s).V }));
        
        // fix44: check merged skills - if a merged skill produces the item, include its merge target
        // ONLY if the merge target is a validated active skill (not candidate, not demoted)
        for (const merged of this.skills.filter(s => s.mergedInto && s.effects.includes(item))) {
            const target = this.skills.find(s => s.name === merged.mergedInto);
            if (target && !target.demoted && !target.candidate && !fromSkills.some(x => x.s.name === target.name)) {
                fromSkills.push({ s: target, V: this._maturity(target).V });
                console.log(`[backchain] found producer for ${item} via mergedInto: ${merged.name} -> ${target.name}`);
            }
        }
        
        // fix43: also check NeedsProducesGraph for confirmed producers (learned from observation)
        if (this.npGraph) {
            const graphProducers = this.npGraph.getProducersOf(item);
            for (const producerKey of graphProducers) {
                // Map the producer key back to a skill if possible
                const matchingSkill = this.skills.find(s => 
                    !s.demoted && !s.mergedInto && !s.candidate &&
                    (s.name.toLowerCase().replace(/[^a-z0-9_]/g, '_') === producerKey ||
                     s.task?.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80) === producerKey));
                if (matchingSkill && !fromSkills.some(x => x.s.name === matchingSkill.name)) {
                    fromSkills.push({ s: matchingSkill, V: this._maturity(matchingSkill).V });
                    console.log(`[backchain] found producer for ${item} via NeedsProducesGraph: ${matchingSkill.name}`);
                }
            }
        }
        
        return fromSkills;
    }
    _chain(item, need, inv, depth, plan, path) {
        if ((inv[item] || 0) >= need) return true;
        if (depth > 3 || path.includes(item)) return false;
        const c = this._producers(item);
        if (!c.length) {
            console.log(`[backchain] no learned skill produces ${item}`);
            // SkillWeaver-style: record missing producer for idle practice
            this.idlePractice.recordMissingProducer(item);
            return false;
        }
        const pick = this._boltzmann(c);
        console.log(`[backchain] ${'  '.repeat(depth)}${item} x${need}: ${c.length} producer(s) [${c.map(x => `${x.s.name} V=${x.V.toFixed(2)}`).join(', ')}] -> Boltzmann picked ${pick.s.name}`);
        for (const [k, n] of Object.entries(pick.s.consumes || {})) if (!this._chain(k, n, inv, depth + 1, plan, [...path, item])) return false;
        plan.push({ name: pick.s.name, item, need });
        return true;
    }
    // fix81: with structured needs, the chain target is the missing item (a single named need), not only the goal item
    async _backchain(task, before, needs) {
        const goal = countGoal(task); if (!goal) return null;
        const plan = [];
        const target = Array.isArray(needs) && needs.length === 1 && Object.hasOwn(needs[0], 'item') && needs[0].item !== goal.item ? needs[0] : null;
        if (target !== null) {
            const have = Object.hasOwn(before.inventory, target.item) ? before.inventory[target.item] : 0;
            if (!this._chain(target.item, have + target.count, before.inventory, 0, plan, []) || !plan.length) return null;
            console.log(`[backchain] plan for missing ${target.count} ${target.item} (${target.reason}) of "${task}": ${plan.map(x => `${x.name}(+${x.item})`).join(' -> ')}`);
            for (let i = 0; i < plan.length; i++) {
                const st = plan[i], last = await this._replay(`obtain 1 ${st.item}`, this.observe(), { name: st.name, call: `await ${st.name}(bot);` });
                if (last === null) { console.log(`[backchain] step ${i + 1}/${plan.length} ${st.name} not replayable; plan abandoned`); return { ok: false }; }
                if (!last.ok) { console.log(`[backchain] step ${i + 1}/${plan.length} ${st.name} ${last.interrupted ? 'interrupted' : 'failed'}; plan abandoned`); return last; }
            }
            console.log(`[backchain] missing ${target.item} produced by learned skills; retrying "${task}"`);
            const route = this._findReplay(task);
            return route ? await this._replay(task, before, route) : null;
        }
        if (!this._chain(goal.item, (before.inventory[goal.item] || 0) + goal.count, before.inventory, 0, plan, []) || !plan.length) return null;
        console.log(`[backchain] plan for "${task}": ${plan.map(x => `${x.name}(+${x.item})`).join(' -> ')}`);
        let last = null;
        for (let i = 0; i < plan.length; i++) {
            const st = plan[i], t = i === plan.length - 1 ? task : `obtain 1 ${st.item}`;
            last = await this._replay(t, i === plan.length - 1 ? before : this.observe(), { name: st.name, call: `await ${st.name}(bot);` });
            if (!last?.ok) { console.log(`[backchain] step ${i + 1}/${plan.length} ${st.name} ${last?.interrupted ? 'interrupted' : 'failed'}; plan abandoned`); return last || { ok: false }; }
        }
        console.log(`[backchain] plan for "${task}" PASSED (${plan.length} skill(s), no model call)`);
        return last;
    }
    // fix32 (PSN refactor triggers): after a success, re-run the canonical refactor detectors
    // (parametric coverage -> variant merge, duplication -> dedup, common subskill -> extraction next step)
    // fix34: added prune, generalise, split detection
    _afterSuccess() {
        this._polyMerge();
        // SkillWeaver-style: track weak skills for idle practice
        for (const s of this.skills) {
            if (s.demoted || s.mergedInto || !s.stats) continue;
            const total = (s.stats.success || 0) + (s.stats.fail || 0);
            if (total >= 3) {
                const failRate = (s.stats.fail || 0) / total;
                if (failRate >= 0.4) {
                    this.idlePractice.recordWeakSkill(s.name, failRate);
                }
            }
        }
        let n = 0;
        const L = this.skills.filter(s => !s.primitive && !s.handwritten && !s.demoted && !s.mergedInto && !s.candidate && s.embedding && s.effects.length);
        for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
            const a = L[i], b = L[j]; if (a.mergedInto || b.mergedInto || a.embedding.length !== b.embedding.length) continue;
            if (JSON.stringify([...a.effects].sort()) !== JSON.stringify([...b.effects].sort()) || cosineSimilarity(a.embedding, b.embedding) < 0.97) continue;
            const [keep, drop] = this._maturity(a).V >= this._maturity(b).V ? [a, b] : [b, a];
            if (this.skills.some(s => (s.deps || []).includes(drop.name))) continue;   // still called by another skill
            drop.mergedInto = keep.name; n++; gateLog(`DEDUP ${drop.name} -> ${keep.name} (same learned effects, description cosine >= 0.97; kept the higher V)`);
        }
        if (n) this._saveSkills();
        const before = JSON.stringify(this.sharedHints || []); this._extractShared();
        if ((this.sharedHints || []).length && JSON.stringify(this.sharedHints) !== before) { this._refactorDue = true; console.log('[psn] refactor due: a new shared fragment appeared after a success'); }
        this._detectPrune();
        this._detectGeneralise();
        this._detectSplit();
        this._windowCheck(true);
        this._retentionTick();
    }
    // fix34 (PSN prune): detect unused low-maturity skills that can be pruned
    _detectPrune() {
        const recent = (this.progress.outcomes || []).slice(-20);
        if (recent.length < 10) return;
        const unused = this.skills.filter(s => !s.primitive && !s.handwritten && !s.demoted && !s.mergedInto && !s.candidate
            && this._maturity(s).V < 0.25 && (s.stats?.success || 0) + (s.stats?.fail || 0) >= 3
            && !this.skills.some(o => !o.demoted && !o.mergedInto && (o.deps || []).includes(s.name)));
        if (unused.length && !this._pruneDue) { this._pruneDue = true; console.log(`[psn] prune due: ${unused.length} unused low-V skill(s) detected`); }
    }
    // fix34 (PSN generalise): detect groups of similar specific skills that could become parameterized
    _detectGeneralise() {
        if (this._generaliseDue) return;
        const cands = this.skills.filter(s => !s.primitive && !s.handwritten && !s.demoted && !s.mergedInto && !s.candidate
            && s.effects.length && !/\(bot\s*,/.test(signatureOf(s.code, s.name)));
        const groups = new Map();
        for (const s of cands) {
            const base = s.name.replace(/^(craft|mine|get|make|collect)/, '').replace(/(Wooden|Stone|Iron|Golden|Diamond|Netherite|Oak|Birch|Spruce|Dark_?Oak|Jungle|Acacia|Mangrove|Cherry|Bamboo)/i, '').toLowerCase();
            if (base.length < 3) continue;
            if (!groups.has(base)) groups.set(base, []);
            groups.get(base).push(s);
        }
        for (const [base, g] of groups) if (g.length >= 3 && !this._generaliseDue) { this._generaliseHint = g.map(s => s.name); this._generaliseDue = true; console.log(`[psn] generalise due: ${g.length} skills share base "${base}"`); }
    }
    // fix34 (PSN split): detect large monolithic skills that could be split
    _splitAlreadyFailed(name, code) {
        if (!this.progress || !Object.hasOwn(this.progress, 'splitFailures')) return false;
        const rows = this.progress.splitFailures;
        if (!Array.isArray(rows)) throw new Error(`[fix97] progress.splitFailures must be an array, got ${JSON.stringify(rows)}`);
        const hash = this._hashReply(code);
        return rows.some(r => r && r.name === name && r.hash === hash);
    }
    _recordSplitFailure(name, code, why) {
        if (this._splitAlreadyFailed(name, code)) return;
        if (!this.progress) throw new Error('[fix97] progress required to record a split failure');
        if (!Object.hasOwn(this.progress, 'splitFailures')) this.progress.splitFailures = [];
        if (!Array.isArray(this.progress.splitFailures)) throw new Error('[fix97] progress.splitFailures must be an array');
        this.progress.splitFailures.push({ name, hash: this._hashReply(code), why: String(why) });
        this._saveProgress();
    }
    _detectSplit() {
        if (this._splitDue) return;
        const large = this.skills.filter(s => !s.primitive && !s.handwritten && !s.demoted && !s.mergedInto && !s.candidate
            && (s.code || '').split('\n').length > 40 && this._maturity(s).V < 0.5 && !this._splitAlreadyFailed(s.name, s.code));
        if (large.length) { this._splitHint = large[0].name; this._splitDue = true; console.log(`[psn] split due: ${large[0].name} has ${large[0].code.split('\n').length} lines and V < 0.5`); }
    }
    // fix32: windowed rollback - a promoted skill is rolled back when the task success rate over the 3 tasks after the
    // promotion is more than 20 points below the 3 before it
    _windowCheck(ok) {
        const P = this.progress, o = (P.outcomes ||= []); o.push(ok ? 1 : 0); if (o.length > 50) o.splice(0, o.length - 50);
        for (const w of (P.watch ||= [])) w.after.push(ok ? 1 : 0);
        for (const w of P.watch.filter(w => w.after.length >= 3)) {
            const after = w.after.reduce((a, b) => a + b, 0) / w.after.length, e = this.skills.find(s => s.name === w.name);
            if (w.base - after > 0.2 && e?.prev) {
                Object.assign(e, { code: e.prev.code, description: e.prev.description, deps: e.prev.deps, stats: e.prev.stats }); delete e.prev;
                writeAtomic(`${this.dir}/${e.name}.js`, `// ${e.description}\n${e.code}\n`); this._saveSkills();
                gateLog(`WINDOW ROLLBACK ${w.name}: success ${Math.round(w.base * 100)}% over 3 tasks before promotion -> ${Math.round(after * 100)}% over 3 after; previous version restored`);
            } else gateLog(`window check ${w.name}: ${Math.round(w.base * 100)}% before -> ${Math.round(after * 100)}% after promotion; kept`);
        }
        P.watch = P.watch.filter(w => w.after.length < 3); this._saveProgress();
    }
    // fix32: skill retention - every 8 completed tasks one mastered skill (V >= 0.7) is re-run on a recorded past task
    // with a deterministic inventory check; the running retention rate is logged
    _retentionTick() { const R = (this.progress.retention ||= { tests: 0, passes: 0, since: 0, last: {} }); R.since++; if (R.since >= 8) this._retentionDue = true; this._saveProgress(); }
    async _retention() {
        if (!this._retentionDue) return false; this._retentionDue = false;
        const R = this.progress.retention; R.since = 0;
        const m = this.skills.filter(s => !s.demoted && !s.mergedInto && !s.candidate && this._maturity(s).V >= 0.7 && /async\s+function\s+\w+\s*\(\s*bot\s*\)/.test(s.code || '') && (s.stats?.tasks || []).some(t => countGoal(t)))
            .sort((a, b) => (R.last[a.name] || 0) - (R.last[b.name] || 0));
        if (!m.length) { console.log('[retention] no mastered skill with a checkable past task yet'); this._saveProgress(); return false; }
        const e = m[0], t = e.stats.tasks.slice().reverse().find(x => countGoal(x));
        R.last[e.name] = Date.now();
        console.log(`[retention] re-testing mastered skill ${e.name} (V=${this._maturity(e).V.toFixed(2)}) on past task "${t}"`);
        const rp = await this._replay(t, this.observe(), { name: e.name, call: `await ${e.name}(bot);` });
        if (rp?.interrupted) { this._saveProgress(); return true; }
        R.tests++; if (rp?.ok) R.passes++;
        (R.log ||= []).push({ at: new Date().toISOString(), skill: e.name, ok: !!rp?.ok }); R.log = R.log.slice(-50);
        this._saveProgress();
        console.log(`[retention] ${e.name}: ${rp?.ok ? 'RETAINED' : 'LOST'}; retention rate ${R.passes}/${R.tests} = ${Math.round(100 * R.passes / R.tests)}%`);
        return true;
    }
    // PSN-style catalogue: every skill with its signature, one line each
    catalogue(only) {
        return this.skills.filter(s => !s.demoted && !s.mergedInto && (!only || only.has(s.name))).map(s => `- ${signatureOf(s.code, s.name)}${s.handwritten ? ' [handwritten]' : ''}: ${s.description}`).join('\n');
    }
    // fix39 (#18): enriched known_skills for decompose/curriculum - descriptions for primitives and for skills that free space
    // fix59: "frees space" is LEARNED (mean empty-slot gain over the skill's traced runs, SlotEffects), not a name regex/list
    _knownSkillsFacts() {
        return this.skills.filter(s => !s.demoted && !s.mergedInto).map(s => {
            if (typeof s.description !== 'string') throw new Error(`[fix59] skill ${s.name} has no description`);
            const desc = s.description;
            const eff = this.slotEffects.effect(s.name);
            const frees = eff !== null && eff.freed > 0;
            const isPrimitive = s.primitive || s.seeded;
            if (!frees && !isPrimitive) return s.name;
            const learned = frees ? ` (observed: frees ${eff.freed.toFixed(1)} inventory slots/run over ${eff.n} runs)` : '';
            return `${s.name}: ${desc}${learned}`;   // fix96: whole description (23 of 40 were cut mid-sentence at 120 chars)
        });
    }
    // fix47: retrieve relevant built-in API functions by embedding search + skill deps
    // Returns top-k relevant signatures plus built-ins that shown skills actually call
    // No hard-coded CORE_API: derived from what the skill library uses (learned, not hard-coded)
    async _relevantBuiltInAPI(query, k, shownSkillNames) {
        if (typeof k !== 'number' || k < 1) {
            throw new Error('[fix47] FAIL LOUD: api_topk must be a positive number in settings.js');
        }
        const bare = getBareAPI();
        const em = this.agent.prompter.embedding_model;
        if (!em) {
            console.error('[fix47] FAIL LOUD: embedding model required for API filtering - no fallback');
            throw new Error('[fix47] embedding model required for API filtering');
        }
        
        // Collect built-ins that the shown skills (and their deps) actually call
        const usedBySkills = new Set();
        const shownSet = shownSkillNames instanceof Set ? shownSkillNames : new Set(shownSkillNames || []);
        for (const skillName of shownSet) {
            const skill = this.skills.find(s => s.name === skillName);
            if (skill?.code) {
                for (const call of extractBareCalls(skill.code)) {
                    if (bare.names.has(call)) usedBySkills.add(call);
                }
            }
        }
        
        const q = await this._embed(query);
        
        // Embed each API signature if not cached
        const apiCache = (this._apiEmbCache ||= new Map());
        const scored = [];
        for (const sig of bare.sigs) {
            const name = sig.split('(')[0];
            if (!apiCache.has(sig)) {
                apiCache.set(sig, await this._embed(sig));
            }
            const score = cosineSimilarity(q, apiCache.get(sig));
            const usedByShown = usedBySkills.has(name);
            scored.push({ sig, name, score, usedByShown });
        }
        
        // Sort by relevance
        scored.sort((a, b) => b.score - a.score);
        const selected = new Set();
        const result = [];
        
        // First add built-ins that shown skills actually call (required for those skills to work)
        for (const s of scored) {
            if (s.usedByShown && !selected.has(s.name)) {
                selected.add(s.name);
                result.push(`- ${s.sig} [built-in, used]`);
            }
        }
        const usedCount = result.length;
        
        // Then add top-k relevant APIs by embedding
        for (const s of scored) {
            if (result.length >= k + usedCount) break;
            if (!selected.has(s.name)) {
                selected.add(s.name);
                result.push(`- ${s.sig} [built-in]`);
            }
        }
        
        console.log(`[fix47] relevant API: ${result.length} of ${bare.sigs.length} built-in (${usedCount} used by skills + ${result.length - usedCount} by embedding)`);
        return result.join('\n');
    }
    
    // fix40: unified bare-name API list (built-in + learned) with exact call signatures
    // ALL functions use bare names (e.g., goToPosition(bot, x, y, z) NOT skills.goToPosition)
    // fix47: now accepts relevantBuiltIn for efficient prompts
    unifiedAPIList(only, relevantBuiltIn = null) {
        const bare = getBareAPI();
        const builtInSigs = relevantBuiltIn || bare.sigs.map(s => `- ${s} [built-in]`);
        const builtInText = Array.isArray(builtInSigs) ? builtInSigs.join('\n') : builtInSigs;
        const learnedSigs = this.skills
            .filter(s => !s.demoted && !s.mergedInto && (!only || only.has(s.name)))
            .map(s => `- ${signatureOf(s.code, s.name)}${s.handwritten ? ' [handwritten]' : ''}: ${s.description}`);
        return [builtInText, ...learnedSigs].join('\n');
    }
    // fix96: the functions a behaviour-preserving rewrite (refactor, generalise, split) of these skills can call: the built-ins
    //        and library skills they call now. Those prompts listed the WHOLE library and every built-in (live refactor and
    //        split prompts 18.7-19k chars, mostly the catalogue)
    scopedAPIList(ents) {
        if (!Array.isArray(ents) || !ents.length) throw new Error('[fix96] scopedAPIList: skills required');
        const own = new Set(ents.map(e => e.name));
        const sigs = getBareAPI().sigs;
        const builtIn = [...new Set(ents.flatMap(e => builtInsCalled(sigs, e.code)))];
        const skills = new Set(ents.flatMap(e => [...this._closure(e.name)]).filter(n => !own.has(n)));
        return this.unifiedAPIList(skills, builtIn);
    }
    // fix40: legacy builtInAPIList for backward compatibility - returns bare names now
    builtInAPIList() {
        const bare = getBareAPI();
        return bare.sigs.join('\n');
    }
    
    // fix47: per-prompt breakdown logging (uses shared helper, no magic threshold)
    _logPromptBreakdown(kind, sections, sent) {
        return logPromptBreakdown(kind, sections, sent);
    }
    // fix70 (blame-aware accounting): when the traced call `name` threw and the error's top frame is outside the staged program
    // (thrownIn: the seeded library, mineflayer, node), the fault is counted against THAT code in progress.libraryFaults
    // ("<fn> <file:line>": n), loudly, and not against the learned skill's stats or gate (no fail, no streak, no demotion,
    // no trial verdict). Where the frame lives is the only criterion: no name lists. An error raised in learned or
    // generated code (its frames are the compartment's "<anonymous>:L:C") stays the skill's own failure.
    // Returns the counted fault { fn, loc } or null.
    _libraryFault(trace, name) {
        if (!Array.isArray(trace)) return null;
        const rec = trace.find(t => t.name === name && t.err !== undefined);
        if (!rec || typeof rec.errTop !== 'string') return null;
        const w = thrownIn(rec.errTop);
        if (w.staged) return null;
        const key = `${w.fn} ${w.loc}`;
        const lf = (this.progress.libraryFaults ||= {});
        lf[key] = (lf[key] || 0) + 1;
        this._saveProgress();
        console.log(`!!! [blame] LIBRARY FAULT in ${key} (x${lf[key]}): ${name} threw "${rec.err}" from library code; counted against that code, not against ${name}'s stats or gate`);
        return w;
    }
    _recordRun(entry, task, ok, trial) {
        if (trial) {
            const c = entry.candidate; recordRun(c.stats, task, ok);
            const n = c.stats.success + c.stats.fail;
            // fix38: detailed logging for joint repair trial runs (show refactor id to correlate with joint context)
            const jointCtx = c.refactor?.startsWith('jr') ? ` [joint repair ${c.refactor}]` : '';
            // fix39: add inventory context to gate logs when trial fails (helps ops diagnose invent-full root cause)
            const invCtx = !ok && this.agent?.bot?.inventory ? ` [inv: ${this.agent.bot.inventory.emptySlotCount()} empty]` : '';
            if (!ok && c.stats.fail >= 2) {
                gateLog(`REJECT candidate ${entry.name}${jointCtx}: failed ${c.stats.fail}/${n} trial runs${invCtx}; keeping current version`);
                this._proposalOutcome(entry, `rejected ${c.stats.success}/${n}`);
                const rf = c.refactor;
                delete entry.candidate;
                if (rf) {
                    console.log(`[psn] ROLLBACK triggered: candidate ${entry.name} rejected after trial runs -> rolling back refactor ${rf}`);
                    this._rollbackRefactor(rf, `${entry.name} failed ${c.stats.fail} trial runs`);
                }
            }
            else if (c.stats.success >= 2 && rate(c.stats) >= rate(entry.stats || newStats())) { if (this._promote(entry, c) !== false) gateLog(`PROMOTE candidate ${entry.name}${jointCtx}: ${c.stats.success} passes, trial ${c.stats.success}/${n} >= current rate ${rate(entry.stats || newStats()).toFixed(2)}`); }
            else gateLog(`candidate ${entry.name}${jointCtx} trial ${ok ? 'passed' : 'failed'} (${c.stats.success}/${n})${invCtx}; waiting for more runs`);
        } else {
            entry.stats = recordRun(entry.stats || newStats(), task, ok);
            if (!ok && entry.stats.streakFail >= 3 && entry.handwritten_original && entry.code !== entry.handwritten_original.code) { gateLog(`ROLLBACK ${entry.name}: promoted replacement failed 3 times in a row`); this.restoreHandwritten(entry.name); }
            else if (!ok && entry.stats.streakFail >= 3 && !entry.primitive && !entry.demoted) { entry.demoted = true; gateLog(`DEMOTE ${entry.name}: failed 3 times in a row (kept on disk, not replayed)`); }
        }
        this._saveSkills();
    }
    _promote(entry, c) {
        // fix88: a candidate that calls itself or closes a cycle is not installed (the same check as save and boot)
        if (typeof c.code !== 'string') throw new Error(`[fix88] promote ${entry.name}: candidate has no code`);
        if (!Array.isArray(c.deps)) throw new Error(`[fix88] promote ${entry.name}: candidate deps must be an array`);
        const violations = installViolations({ name: entry.name, code: c.code, deps: c.deps }, this.skills);
        if (violations.length > 0) {
            this._installRejection = this._recordInstallRejection(entry.name, violations);
            delete entry.candidate;
            return false;
        }
        this._proposalOutcome(entry, 'promoted');
        entry.prev = { code: entry.code, description: entry.description, deps: entry.deps, stats: entry.stats, saved: entry.saved };
        Object.assign(entry, { code: c.code, description: c.description, deps: c.deps, effects: c.effects, embedding: c.embedding, saved: new Date().toISOString(), stats: c.stats, demoted: false });
        if (Object.hasOwn(c, 'promptCounts')) entry.promptCounts = c.promptCounts;
        if (c.refactor) entry.refactorOf = c.refactor; else delete entry.refactorOf;
        delete entry.candidate;
        { const o = this.progress.outcomes || []; if (o.length >= 3) { (this.progress.watch ||= []).push({ name: entry.name, base: o.slice(-3).reduce((a, b) => a + b, 0) / 3, after: [] }); this._saveProgress(); } }   // fix32 windowed rollback
        writeAtomic(`${this.dir}/${entry.name}.js`, `// ${entry.description}\n${entry.code}\n`);
        // fix11 (B4): parents are re-validated only once the new version is actually live
        const parents = parentsOf(entry.name, this._graph());
        for (const p of parents) { const pe = this.skills.find(s => s.name === p); if (pe) pe.revalidate = entry.name; }
        if (parents.length) console.log(`[psn] promoted ${entry.name}; marked ${parents.length} parent(s) for re-validation: ${parents.join(', ')}`);
        this._saveSkills();
        return true;
    }
    // Skill-V style regression check: rerun a candidate on one recorded past task that has a deterministic inventory check
    async _regressionRun(entry, code) {
        if (!/async\s+function\s+\w+\s*\(\s*bot\s*\)/.test(code)) return null;   // parameterised: can't rerun blindly -> trial runs instead
        // fix51: a past task is a valid regression check only if its goal items are among the skill's learned effects;
        // callee skills (e.g. pickupNearbyItems) inherit their caller's task in stats and can't satisfy it alone
        if (!Array.isArray(entry.effects)) { gateLog(`regression rerun of ${entry.name}: no learned effects; trial runs instead`); return null; }
        const goalOf = t => smeltGoal(t) || countGoal(t);
        const past = (entry.stats?.tasks || []).slice().reverse().find(t => { const g = goalOf(t); return g && g.items.some(it => entry.effects.includes(it)); });
        if (!past) { gateLog(`regression rerun of ${entry.name}: no past task whose goal overlaps learned effects [${entry.effects.join(', ')}]; trial runs instead`); return null; }
        const goal = goalOf(past);
        const before = this.observe();
        gateLog(`regression rerun of candidate ${entry.name} on past task "${past}"`);
        const regClosure = new Set([entry.name, ...this._closure(entry.name)]);
        const regBundle = this._libSrcSubset(regClosure, { [entry.name]: code }) + `\n\nawait ${entry.name}(bot);`;
        const { lint, staged } = await this._stageLintExec(regBundle, regClosure, `voyager:regression:${entry.name}`);
        if (lint) { gateLog(`regression ${entry.name}: lint failed`); return false; }
        if (!staged) return false;
        this._runStart = Date.now();
        const closeJournal = this._openTrialJournal([entry.name], entry.name, past, regClosure);
        let res;
        try {
            res = await this._run(`voyager:gate:${entry.name}`, async () => {
                const bot = this._timedBotForSkillRun();
                await staged.func.main(bot);
            }, 4);   // fix28: stall watchdog on gate runs
        } finally { closeJournal(); }
        if (this._stalledInRun()) { gateLog(`regression rerun of ${entry.name} stalled; counted as a failed rerun`); return false; }
        if (res.interrupted || this.abort) return null;
        return gainedFor(goal, before, this.observe()) >= goal.count;
    }
    // fix35: serialized code-model calls with loud logging (one in flight at a time; no dual same-model Ollama generate)
    // fix37: idle practice runs during code-model waits (no separate 30s idle required)
    async _ask(system, user, meta) {
        if (!meta || typeof meta.kind !== 'string' || meta.kind.length === 0) throw new Error('[fix93] _ask requires { kind, components }');
        CALLS.code++;
        const callNum = CALLS.code;
        meta.requestId = `${meta.kind}#${callNum}`;
        // serialize code-model calls; queue if another is in flight
        const prev = this._askQ || Promise.resolve();
        let release; this._askQ = new Promise(r => release = r);
        const wasQueued = prev !== (this._askQPrev || Promise.resolve());
        this._askQPrev = prev;
        if (wasQueued) console.log(`[overlap] code-model call #${callNum} waiting for previous call to finish (serialized)`);
        // fix79: _askQ is resolve-only (release() in finally), same as _localQ in _askLocal (f850a88/fix31).
        // fix35 (714ce15) wrapped this in try/catch "previous call's error doesn't block us", but prev never rejects —
        // the previous _ask's error already surfaces to its own caller. Awaiting only serialises; a bare await matches
        // _askLocal and does not swallow or double-report.
        await prev;
        if (wasQueued) console.log(`[overlap] code-model call #${callNum} now running (previous finished)`);
        // fix33: CodeModel.sendRequest handles paid→free fallback internally; no pre/post quota check here
        const cm = this.agent.prompter.code_model;
        const t0 = Date.now(); console.log(`[timing] ${new Date().toISOString().slice(11,19)}Z composer call #${callNum} start kind=${meta.kind} (prompt ${system.length + user.length} chars)`);
        // The code model is called here, not through promptCoding, so the dump that path writes never ran.
        // compose-retry #78 overflowed and the prompt was not on disk. Write it before the request, including when the request throws.
        writeCodePromptDump(system, user);
        // fix35: overlap CPU-only maintenance with code-model wait (flush debounced saves, extract shared fragments)
        this._overlapCpuMaintenance();
        // fix37/fix93: one practice controller covers this wait and any local wait already in flight
        const cover = this._ensureInferCover();
        cover.enter(callNum);
        let r; try { r = await cm.sendRequest([{ role: 'user', content: user }], system, meta); } finally {
            // fix79: a practice error now rejects here (it fails the step); the next code-model call is released either way
            try { await cover.leave(); }   // fix70: no practice run outlives this call into the next action's window
            finally {
                release();
                console.log(`[timing] ${new Date().toISOString().slice(11,19)}Z composer call #${callNum} took ${Date.now() - t0}ms (reply ${String(r ?? '').length} chars)`);
            }
        }
        return r;
    }
    // fix37: hash a model reply for duplicate detection (djb2 algorithm, fast and deterministic)
    _hashReply(text) {
        const str = String(text).trim();
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
        return h.toString(36);
    }
    // fix35: CPU-only maintenance that can run overlapped with code-model waits (no model calls)
    _overlapCpuMaintenance() {
        const t0 = Date.now();
        let did = [];
        // flush debounced skill saves if dirty
        if (this._skillsDirty) { this._flushSkills(); did.push('flush-skills'); }
        // extract shared fragments (CPU-only analysis)
        const prevHints = JSON.stringify(this.sharedHints || []);
        this._extractShared();
        if (JSON.stringify(this.sharedHints || []) !== prevHints) did.push('extract-shared');
        // recompute shared hints if needed
        if (did.length) console.log(`[overlap] CPU maintenance overlapped with code-model: ${did.join(', ')} (${Date.now() - t0}ms)`);
    }
    // fix37/fix49: idle practice during code-model waits - runs learned skills without requiring 30s of true idle
    // Skills ranked by learning value (low rate, streakFail, few trials) and plan relevance
    // fix49: logs [idle] model_call_ms=… practice_ms=… idle_ms=… for before/after measurement
    // fix49: empty state delta doesn't count as practice
    async _startIdlePractice(callNum) {
        if (this._idlePracticeActive) return;
        this._idlePracticeActive = true;
        this._armPracticeAbort();
        const t0 = Date.now();
        console.log(`[idle-practice] starting during code-model call #${callNum}`);
        // fix74: no sleeps. fa01ee3 paused 5 s when no skill was eligible (3 times, then stopped), 5 s after 3 consecutive
        //        skips/failures, and 2 s between runs, and polled for the abort every 200 ms. Nothing the idle bot does changes
        //        which skills are eligible, so waiting and re-selecting only re-read the same state; the session ends instead
        //        and the next code-model call starts a new one. A skipped run (bot busy, threats) ends the session for the same
        //        reason. Each run's own verdict now moves its stats (and so the ranking), and a run returns only after the
        //        harness's one-tick settle (instrumentSrc waitForTicks(1)), so back-to-back runs need no pause.
        const practice = async () => {
            let practiceCount = 0, practiceMs = 0;
            const notAgain = new Map();   // skills this session cannot stage or judge -> why (not re-picked until the next session)
            while (this._idlePracticeActive && !this._idlePracticeAbort) {
                const skill = this._selectPracticeSkill(notAgain);
                if (!skill) { console.log(`[idle-practice] no eligible skill to practice; ending this session (eligibility does not change while the bot idles)`); break; }
                const runStart = Date.now();
                const r = await this._runPracticeSkill(skill);
                if (r === null) break;   // the code-model call completed
                if (r.skipped) { console.log(`[idle-practice] ending this session: ${r.skipped}`); break; }
                if (r.notRun) { notAgain.set(skill.name, r.notRun); continue; }
                const runMs = Date.now() - runStart;
                practiceMs += runMs;
                practiceCount++;
                if (r.ok === null) { notAgain.set(skill.name, r.detail); console.log(`[idle-practice] NO VERDICT ${skill.name}: ${r.detail} (stats unchanged)`); }
                else console.log(`[idle-practice] ${r.ok ? 'SUCCESS' : 'NOT SUCCESS'} ${skill.name}: ${r.detail} (practice: ${runMs}ms; stats now ${skill.stats.success}/${skill.stats.success + skill.stats.fail})`);
            }
            return { practiceCount, practiceMs };
        };
        this._idlePracticePromise = practice().then(({ practiceCount, practiceMs: pm }) => {
            const modelCallMs = Date.now() - t0;
            const idleMs = modelCallMs - pm;
            // fix49: log format for before/after measurement
            console.log(`[idle] model_call_ms=${modelCallMs} practice_ms=${pm} idle_ms=${idleMs} runs=${practiceCount}`);
        }).finally(() => {
            this._idlePracticeActive = false;
        });
        // fix79: no .catch. fa01ee3 logged "[idle-practice] ERROR: <message>; stopping practice" and resolved, so a bug in
        //        practice ended only that session, without a stack, and came back next call (live 14:43:52Z-15:02:47Z on 36ffd89:
        //        27x "Cannot convert undefined or null to object", Object.keys(skill.consumes) of a skill saved without consumes,
        //        the creator fix73 fixed). The rejection reaches _ask, which awaits this promise, and fails the step loudly
        //        (_onStepError: logged with its stack; the same error on two consecutive steps is fatal).
        return this._idlePracticePromise;
    }
    // fix74: the end of the code-model call is a signal (a promise the practice run races), not a flag polled every 200 ms
    _armPracticeAbort() {
        this._idlePracticeAbort = false;
        this._idlePracticeAborted = new Promise(resolve => { this._fireIdlePracticeAbort = resolve; });
    }
    _stopIdlePractice() {
        if (!this._idlePracticeActive) return;
        this._idlePracticeAbort = true;
        this._fireIdlePracticeAbort();
        console.log(`[idle-practice] stopping (code-model call completed)`);
    }
    // fix37/fix49: select a learned skill to practice - ranked by learning value
    // Learning value: low success rate, high streakFail, few trials
    // Plan relevance: shares needs/produces with pending goal
    // fix74: notAgain - skills this practice session could not stage or judge (name -> why); a skill nothing can judge
    //        (_practiceJudgeable) is not picked: its run could not move its stats, so it would be picked again every run
    _selectPracticeSkill(notAgain) {
        if (!(notAgain instanceof Map)) throw new Error('[idle-practice] _selectPracticeSkill: notAgain must be a Map');
        const inv = this.observe().inventory;
        const pending = this._getPendingGoalItems();  // items needed by pending/failed tasks
        const candidates = this.skills.filter(s =>
            !s.primitive && !s.handwritten && !s.demoted && !s.mergedInto && !s.candidate &&
            s.code && s.name && s.stats &&
            /async\s+function\s+\w+\s*\(\s*bot\s*(?:,\s*\w+\s*=\s*[^,)]+)*\)/.test(s.code)
        );
        if (!candidates.length) return null;
        const filtered = candidates.filter(s => {
            if (notAgain.has(s.name)) return false;
            if (!this._practiceJudgeable(s)) {
                if (!this._unjudgeableNoted.has(s.name)) { this._unjudgeableNoted.add(s.name); console.log(`[idle-practice] not practising ${s.name}: ${s.contract && s.contract.post ? `its post cannot verify a run (${s.postUnverifiable.why})` : 'no learned post-contract'} and no effects verified by run evidence, so a practice run could not be judged`); }
                return false;
            }
            const skip = this._shouldSkipPractice(s, inv, pending);
            if (skip) console.log(`[idle-practice] filtering out ${s.name}: ${skip}`);
            return !skip;
        });
        if (!filtered.length) {
            console.log(`[idle-practice] all ${candidates.length} candidate(s) filtered out`);
            return null;
        }
        // fix49: rank by Beta-posterior uncertainty * (1 + plan_relevance)
        // Uncertainty = (s+1)(f+1) / ((n+2)^2 * (n+3)) where s=successes, f=failures, n=s+f
        // Skills with n=0 get max variance naturally. No hand weights or recency constants.
        // Note: filter above ensures s.stats exists (via `s.stats &&`)
        // fix93: a post that already holds on this world is not a candidate. Relevance 0 is not usefulness.
        //        A known causal effect with no plan overlap has nothing to learn and nothing to serve.
        const obs = this.observe();
        const pendingSize = pending.size;
        const excluded = [];
        const scored = [];
        for (const s of filtered) {
            const met = this._practicePostAlreadyMet(s, obs);
            if (met.met) { excluded.push(`${s.name}: ${met.reason}`); continue; }
            const successes = s.stats.success;
            const failures = s.stats.fail;
            const n = successes + failures;
            const uncertainty = ((successes + 1) * (failures + 1)) / (Math.pow(n + 2, 2) * (n + 3));
            const effects = s.effects;
            const intersection = effects.filter(eff => pending.has(eff)).length;
            const planRelevance = pendingSize > 0 ? intersection / pendingSize : 0;
            const effectKnown = Object.hasOwn(s, 'causalEvidence') && s.causalEvidence.success > 0;
            const information = !effectKnown;
            const useful = planRelevance > 0;
            if (!information && !useful) { excluded.push(`${s.name}: no information gain and no plan usefulness`); continue; }
            const because = information && useful ? 'information gain and plan usefulness' : (information ? 'information gain' : 'plan usefulness');
            const score = uncertainty * (1 + planRelevance);
            scored.push({ s, score, reason: `n=${n} unc=${uncertainty.toFixed(4)} rel=${planRelevance.toFixed(2)} ${because}` });
        }
        scored.sort((a, b) => b.score - a.score);
        if (scored.length === 0) {
            console.log(`[idle-practice] idle: no eligible practice; ${excluded.join('; ')}`);
            return null;
        }
        console.log(`[idle-practice] top candidate: ${scored[0].s.name} (${scored[0].reason})`);
        return scored[0].s;
    }
    // fix93: the learned post, evaluated as if the skill returned true and changed nothing.
    // Missing observations are not "already met". A throw from the post is a contract bug.
    _practicePostAlreadyMet(skill, obs) {
        if (!skill.contract || typeof skill.contract.post !== 'string') return { met: false, evaluable: false, reason: 'no post-contract' };
        if (!skill.contract.post.includes('=>')) return { met: false, evaluable: false, reason: 'post is not an arrow predicate' };
        const fields = this._extractPostFields(skill.contract.post);
        const world = practiceWorld(obs);
        if ((fields.pos || fields.dist) && !world.pos) return { met: false, evaluable: false, reason: 'post reads position; observation has none' };
        if (fields.hp && typeof world.hp !== 'number') return { met: false, evaluable: false, reason: 'post reads hp; observation has none' };
        if (fields.food && typeof world.food !== 'number') return { met: false, evaluable: false, reason: 'post reads food; observation has none' };
        for (const item of fields.inv) {
            if (!world.inv || !Object.hasOwn(world.inv, item)) return { met: false, evaluable: false, reason: `post reads inv.${item}; observation has none` };
        }
        for (const slot of fields.eq) {
            if (!world.eq || !Object.hasOwn(world.eq, slot)) return { met: false, evaluable: false, reason: `post reads eq.${slot}; observation has none` };
        }
        if (skill.contract.post.includes('.alive') && typeof world.alive !== 'boolean') return { met: false, evaluable: false, reason: 'post reads alive; observation has none' };
        if (skill.contract.post.includes('.dim') && typeof world.dim !== 'string') return { met: false, evaluable: false, reason: 'post reads dim; observation has none' };
        const snap = { pos: world.pos, hp: world.hp, food: world.food, alive: world.alive, dim: world.dim, inv: world.inv, eq: world.eq, free: world.free };
        const held = this._compileContract(skill.contract.post)(this._contractCtx({ args: [], ret: true, pre: snap, post: snap, delta: {} }));
        if (held !== true && held !== false) throw new Error(`[fix93] ${skill.name} post returned ${JSON.stringify(held)}, not a boolean`);
        return { met: held === true, evaluable: true, reason: held === true ? 'postcondition already holds in the current world' : 'post does not hold' };
    }
    // fix42: get items needed by pending/failed tasks (from learned needs/produces, not hard-coded)
    // fix25: prefer smeltGoal so "Smelt X into Y" prioritizes Y (product), ingredients come from consumes
    _getPendingGoalItems() {
        const items = new Set();
        // extract items from failed and pending tasks
        for (const task of [...(this.progress.failed || []).slice(-10), ...(this.progress.pending || []).slice(-5)]) {
            const goal = smeltGoal(task) || countGoal(task);  // fix25: smelt first (product)
            if (goal?.item) items.add(goal.item);
            if (goal?.items) goal.items.forEach(it => items.add(it));
        }
        // add items that are inputs (consumes) to known producers of the pending items
        for (const item of [...items]) {
            const producers = this._producers(item);
            for (const { s } of producers) {
                for (const need of Object.keys(s.consumes || {})) items.add(need);
            }
        }
        return items;
    }
    // fix42: check if a practice skill should be skipped (postcondition already met or would consume scarce inputs)
    // Returns a skip reason string, or null if practice is allowed
    // fix49: effects/consumes/stats initialized at load time - read directly
    _shouldSkipPractice(skill, inv, pendingItems) {
        // 1) Check if postcondition is already satisfied (learned path: check effects + inventory)
        // fix74: only effects verified by run evidence (an unverified list such as [crafting_table, cobblestone] says nothing)
        const effects = verifiedEffects(skill);
        if (effects.length > 0) {
            const produced = effects.filter(eff => inv[eff] > 0);
            // if all effects are already in inventory, postcondition is likely met
            if (produced.length === effects.length) {
                return `postcondition already met (has all of: ${effects.join(', ')})`;
            }
        }
        // 2) Check if skill would consume scarce inputs needed by pending goals
        // fix70: only consumption re-verified by measured runs gates practice (verifiedConsumes); practice is how it gets measured
        const verified = verifiedConsumes(skill);
        if (!Object.hasOwn(skill, 'consumeEvidence') && Object.keys(skill.consumes).length && !this._unverifiedConsumesNoted.has(skill.name)) {
            this._unverifiedConsumesNoted.add(skill.name);
            console.log(`[idle-practice] ${skill.name}: learned consumes ${JSON.stringify(skill.consumes)} has no run evidence (never re-verified); not gating practice on it`);
        }
        const consumes = Object.keys(verified);
        if (consumes.length > 0) {
            for (const item of consumes) {
                const have = inv[item] || 0;  // inventory lookup: missing item = 0
                const need = verified[item];
                // if pending items include this consumable and we don't have much
                if (pendingItems.has(item) && have < need * 3) {
                    return `would consume scarce ${item} (have ${have}, need ${need}, pending goal needs it)`;
                }
            }
        }
        // fix76: learned food-raiser at observed food cap — practice would be an unmet eat precondition
        // (needs a live bot; unit tests that call _shouldSkipPractice without agent.bot only exercise consumes/effects gates)
        if (this.agent && this.agent.bot) {
            const sat = this._foodRaiseSaturated(skill.name, this.agent.bot.food);
            if (sat) return `${sat}: ${skill.name} is a learned food-raiser at the observed food cap`;
        }
        return null;
    }
    // fix84: surplus is what verified consumption says is above the most any skill has been seen to spend.
    //        An item with no consumption evidence is not surplus. No name list, no stack-count threshold.
    //        Returns { toss: [item names], deposit: [], uncertain: [], surplus: [{ item, count, keep }] }.
    _computeTossAndDepositLists() {
        const counts = stackableCounts(this.agent.bot);
        const surplus = surplusFromConsumption(this.skills, counts);
        const text = surplus.map(s => `${s.item}(${s.count} above ${s.keep})`).join(', ');
        console.log(`[toss] learned surplus from verified consumption: ${surplus.length} item(s)${surplus.length ? `: ${text}` : ''}`);
        return { toss: surplus.map(s => s.item), deposit: [], uncertain: [], surplus };
    }
    // fix43: populate bot.__safeToToss, __depositCandidates, and __uncertainItems before running tossClutter/freeInventory
    // fix51: also populate __knownChests from chestMemory (deposit uses ONLY learned chests)
    _prepareTossSignals() {
        const lists = this._computeTossAndDepositLists();
        this.agent.bot.__safeToToss = lists.toss;
        this.agent.bot.__depositCandidates = lists.deposit;
        this.agent.bot.__uncertainItems = lists.uncertain;
        this.agent.bot.__surplus = lists.surplus;
        this.agent.bot.__knownChests = this.chestMemory;
        const cur = this._curSub;
        if (cur && cur.slotRequest) {
            const req = cur.slotRequest;
            const slotsNeeded = emptySlotsToFit(this.agent.bot.registry, stackableCounts(this.agent.bot), req.item, req.count);
            if (slotsNeeded > 0) return { req, slotsNeeded };
            this.agent.bot.__capacityPlan = [];
        } else this.agent.bot.__capacityPlan = [];
        return null;
    }
    // fix37/fix49/fix74: run one practice skill. Returns null when the code-model call completed (abort: no verdict),
    // { skipped } when the bot cannot practice now, { notRun } when the skill could not be staged, else the run's verdict
    // { ok: true|false|null, detail }; a true/false verdict is recorded in the skill's stats (_recordRun).
    async _runPracticeSkill(skill) {
        if (this._idlePracticeAbort) return null;
        const bot = this.agent.bot;
        // safety gates: log clearly when skipped (not silent)
        if (!this.agent.isIdle()) {
            console.log(`[idle-practice] SKIPPED ${skill.name}: bot is not idle`);
            return { skipped: 'bot is not idle' };
        }
        // threats are a real-time danger (learned from environment), keep this gate
        const threats = this._threats();
        if (threats !== 'none') {
            console.log(`[idle-practice] SKIPPED ${skill.name}: threats nearby (${threats})`);
            return { skipped: `threats nearby (${threats})` };
        }
        // fix74: the practice program is traced like a replay, so the skill's learned post-contract can judge the run and its
        //        duration is measured (before, _stageLintExec ran it untraced: _postHolds had nothing to read)
        const call = `await ${skill.name}(bot);`;
        const prClosure = new Set([skill.name, ...this._closure(skill.name)]);
        const libPart = this._libSrcSubset(prClosure);
        const body = `\n\nasync function __practice(bot) {\n    try { ${call} } catch (e) { log(bot, 'PRACTICE FAILED: ' + e.message); throw e; } finally { bot.__psnOut = bot.output; }\n}\nawait __practice(bot);`;
        const full = libPart + '\n\n' + instrumentSrc(Voyager._tracedSkillNamesForInstrument(this, prClosure)) + body;
        // fix79: staging that throws is our bug (the bundle the replay of the same skill stages, voyager:replay, which has no
        //        catch): it propagates. fa01ee3 caught it, logged STAGING FAILED and went on to the next skill. A lint result is
        //        data about the skill's code, not an exception: the skill is not run this session.
        const { lint, staged } = await this._stageLintExecTraced(libPart + body, full, prClosure, `voyager:idle-practice:${skill.name}`);
        if (lint) { console.error(`[idle-practice] LINT FAILED ${skill.name}: ${lint}`); return { notRun: `lint failed: ${lint}` }; }
        if (!staged) throw new Error(`[idle-practice] ${skill.name}: staging returned no code (coder._stageCode could not write the execution file)`);
        const bound = this._practiceBound(skill);
        if (bound === null) console.log(`[idle-practice] ${skill.name}: no observed run duration yet; uncapped, ends when it returns or the code-model call completes`);
        const traceWas = bot.__psnTrace;
        clearPreconditionUnmet(bot);   // fix76: only a marker this run sets can void its verdict
        const stateBefore = this.observe();   // fix70: measured right before this run
        const practiceStart = Date.now();
        // fix70: the practice run is over only when the skill's own code has returned (live 01:07:52Z: pickupNearbyItems
        //        ABORTED at step end, still running beside the next action)
        const mainP = staged.func.main(this._timedBotForSkillRun());
        const settled = mainP.then(() => ({ kind: 'returned' }), err => ({ kind: 'threw', err }));
        // fix74: a cut or abort interrupts the skill AND what it set going. fix70's ended() only set bot.interrupt_code, which
        //        learned code reads only between its own awaits; a skill waiting in a pathfinder goto (travelWestAvoidDeathHotspot)
        //        kept walking until the goal or a stall, and _ask (#65) awaited that walk before handing back the model reply.
        //        agent.requestInterrupt is the one stop the action manager uses: stopDigging, collectBlock.cancelTask,
        //        pathfinder.stop + setGoal(null) (rejects a pending goto at once), pvp.stop.
        // fix75 (ae731ed): every interrupt names its source; this one is idle practice ending its own run (no action is
        //        executing while the bot practises, so ActionManager.noteInterrupt records nothing)
        const ended = async (why) => {
            const was = bot.interrupt_code;
            this.agent.requestInterrupt({ kind: 'practice', by: `idle-practice ${skill.name}: ${why}` });
            const s = await settled;
            if (s.kind === 'threw') console.log(`[idle-practice] ${skill.name} ended after interrupt with: ${s.err.message}`);
            bot.interrupt_code = was;   // this interrupt was only to end this practice run; the next practice run starts as this one did
            console.log(`[idle-practice] ${skill.name}: its code has returned`);
        };
        let timer = null;
        const racers = [settled, this._idlePracticeAborted.then(() => ({ kind: 'aborted' }))];
        if (bound !== null) racers.push(new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'cut' }), bound); }));
        const outcome = await Promise.race(racers);
        if (timer !== null) clearTimeout(timer);
        const finish = (verdict) => {
            const trace = bot.__psnTrace;
            bot.__psnTrace = traceWas;
            clearPreconditionUnmet(bot);   // fix76's marker belongs to this run; it must not reach the next task's verdict
            skill.stats.lastRun = Date.now();
            skill.stats.practiceRuns = (Object.hasOwn(skill.stats, 'practiceRuns') ? skill.stats.practiceRuns : 0) + 1;
            if (verdict.ok !== null) this._recordRun(skill, null, verdict.ok, false);
            else this._saveSkills();
            return { ...verdict, trace };
        };
        if (outcome.kind === 'aborted') {
            console.log(`[idle-practice] ABORTED ${skill.name}: code-model call completed`);
            await ended('code-model call completed');
            finish({ ok: null, detail: 'aborted' });
            return null;
        }
        if (outcome.kind === 'cut') {
            console.log(`[idle-practice] TIMEOUT ${skill.name}: still running after ${bound}ms, the longest it has returned in (n=${skill.runMs.n}); interrupting`);
            await ended(`cut at its learned bound ${bound}ms`);
            return finish({ ok: false, detail: `cut at its learned bound ${bound}ms` });
        }
        const after = this.observe();
        const trace = bot.__psnTrace;
        if (!Array.isArray(trace)) throw new Error(`[idle-practice] ${skill.name}: the traced practice run left no trace`);
        annotateTrace(trace, bot.__psnOut);
        this._learnRunDurations(trace);
        if (outcome.kind === 'threw') {
            console.error(`[idle-practice] EXECUTION FAILED ${skill.name}: ${outcome.err.message}`);
            const lib = this._libraryFault(trace, skill.name);
            if (lib) return finish({ ok: null, detail: `threw in library code (${lib.fn} ${lib.loc}), not the skill's fault` });
            const unmetT = this._classifyUnmetPrecondition(skill.name, stateBefore.food_value);
            if (unmetT) return finish({ ok: null, detail: `unmet precondition (${unmetT}), not evidence about the skill` });
            return finish({ ok: false, detail: `threw: ${outcome.err.message}` });
        }
        let verdict = this._practiceRunChanged(skill, stateBefore, after);
        // fix93: a post that holds only because ret is truthy, with no position, inventory, or equipment change, is not an effect success
        if (verdict.ok === true || verdict.ok === false || verdict.ok === null) {
            const root = trace.find(t => t.name === skill.name && (t.parent ?? -1) < 0);
            const changes = causalChanges({ before: stateBefore, after, traceRoot: root === undefined ? null : root });
            const ev = effectVerdict(verdict.ok, changes);
            if (verdict.ok === true && ev.effect === null) {
                console.log(`[idle-practice] NOT SUCCESS ${skill.name}: no causal state change; not an effect success`);
                verdict = { ok: null, detail: `no causal state change; not an effect success (${verdict.detail})` };
            } else if (ev.effect === true) noteCausalSuccess(skill);
        }
        // fix76 semantics for practice: a failed run whose precondition was unmet (typed marker, or a learned food-raiser
        //        started at the food cap) is no verdict on the skill, as in replay (_classifyUnmetPrecondition)
        const unmet = verdict.ok === false && this._classifyUnmetPrecondition(skill.name, stateBefore.food_value);
        if (unmet) return finish({ ok: null, detail: `${verdict.detail}; unmet precondition (${unmet}), not evidence about the skill` });
        if (verdict.ok === true) this._learnEffects(skill, stateBefore, after, null);   // a verified run is a measured run
        return finish({ ...verdict, detail: `${verdict.detail} in ${Date.now() - practiceStart}ms` });
    }

    // ---------- automatic curriculum ----------
    // fix29: restored fix19 PSN decomposition (removed with the milestone planner in fix27c while its callers stayed):
    // a goal that keeps failing is split into subgoals; each is learned as a skill, then the parent is retried.
    // fix97: the depth cap of 2 and the 30-minute cooldown were a magic number and a timer. They made an overflowing
    // prompt return false, the process exit, and the restart rebuild the same prompt. A task is not split again
    // while the subgoals of its last split are still queued. That is the recorded split, not a clock.
    // fix47: inventory-first planning + harvestTools-based tool decompose
    async _decompose(task, reason) {
        const d = (this.progress.decomposed ||= {}), q = (this.progress.subgoals ||= []);
        const depth = (this._curSub?.task === task ? this._curSub.depth : 0);
        if (q.some(s => s && s.parent === task)) { console.log(`[psn] decompose skipped for "${task}": its subgoals are still queued`); return false; }
        
        // fix97: an item goal keeps its own task. Subgoals come from the game-data plan (block loot, entity loot,
        //        recipes, furnace recipes). A learned producer's task is a subgoal only when that task's item is the
        //        goal item or a direct input. The old inventory-first path rewrote the goal with skill.task.replace,
        //        so a dirt skill whose effects listed the goal became "collect dirt".
        const goal = smeltGoal(task) || countGoal(task) || parseVerboseGoal(task);
        if (goal && typeof goal.item === 'string' && Number.isInteger(goal.count)) {
            const state = this.observe();
            const planner = this._obtainPlanner(state);
            const src = planner.sources(goal.item);
            const inputSrc = typeof goal.input === 'string' ? planner.sources(goal.input) : [];
            const perceived = [];
            for (const block of [...src, ...inputSrc]) {
                if (state.perceived_at && Object.hasOwn(state.perceived_at, block) && !perceived.includes(block)) perceived.push(block);
            }
            await this._judgeTargets(state, perceived, true);
            const inv = state.inventory || {};
            const pre = await this._withChosenSearches(state, (plannerOf) => plannerOf().prerequisites(goal.item, goal.count, inv));
            const subs = [];
            if (pre.how === 'collect') {
                if (!src.length) throw new Error(`[fix97] LOUD: ${goal.item} is collected but the game data names no source block`);
                if (!Array.isArray(state.nearby_blocks)) throw new Error(`[fix97] observe().nearby_blocks must be an array to choose a source of ${goal.item}`);
                const edges = this.progress.recipeEdges;
                if (edges === null || typeof edges !== 'object' || Array.isArray(edges)) throw new Error('[fix97] progress.recipeEdges required to choose a proven source');
                const present = src.filter(block => state.nearby_blocks.includes(block));
                const proven = Object.hasOwn(edges, goal.item) && edges[goal.item].status === 'proven';
                const pool = present.length ? present : (proven ? src : []);
                if (!pool.length) {
                    console.log(`[psn] decompose skipped for "${task}": no source of ${goal.item} is present or proven (${src.join(', ')})`);
                    return false;
                }
                const poolSeen = pool.filter(block => state.perceived_at && Object.hasOwn(state.perceived_at, block));
                const chosen = await this._judgeTargets(state, poolSeen, true);
                if (!chosen) {
                    console.log(`[psn] decompose skipped for "${task}": no perceived source of ${goal.item} is reachable (${pool.join(', ')})`);
                    return false;
                }
                const reach = `reach ${chosen}`;
                if (reach !== task) subs.push(reach);
            } else {
                for (const step of pre.plan) if (step !== task && !subs.includes(step)) subs.push(step);
            }
            const inputs = new Set([goal.item]);
            for (const ing of pre.ingredients) inputs.add(ing.item);
            for (const { s } of this._producers(goal.item)) {
                if (typeof s.task !== 'string' || s.task.length === 0 || s.task === task || subs.includes(s.task)) continue;
                const produced = smeltGoal(s.task) || countGoal(s.task) || parseVerboseGoal(s.task);
                if (!produced || typeof produced.item !== 'string' || !inputs.has(produced.item)) continue;
                subs.push(s.task);
            }
            if (!subs.length) {
                console.log(`[psn] decompose skipped for "${task}": the game-data plan is already this goal (${pre.task})`);
                return false;
            }
            d[task] = { subs, skills: [], at: Date.now(), reason: `game data ${pre.how}: ${pre.task}` };
            q.unshift(...subs.map(t => ({ task: t, parent: task, depth: depth + 1 })), { task, retry: true, depth });
            this._saveProgress();
            console.log(`[psn] DECOMPOSE (game data) "${task}" -> ${subs.join(', ')}; parent kept`);
            return true;
        }
        
        const system = `You break a Minecraft bot's failing goal into smaller steps (Voyager/PSN-style task decomposition).
Return 2-4 concrete, verifiable subgoals, in order, that together achieve the goal; each must be doable in a few minutes by ONE small reusable skill. Use the failure reason and the state. Do not repeat the goal itself.
Reply ONLY with JSON: {"subgoals": ["...", "..."]}`;
        // fix39: enriched known_skills with descriptions for primitives and space-freeing skills
        const skillLines = this.skills.length === 0 ? '[]' : (await this.retrieveSkills(`${task}\n${String(reason)}`, settings.skill_topk)).map(s => `${signatureOf(s.code, s.name)}: ${s.description}`).join('\n');
        const user = `goal: ${task}\nwhy it failed: ${String(reason)}\ndeath_hotspots: ${this._deathHotspots()}\n${this._stateText(this.observe())}\nknown_skills: ${skillLines}`;
        let subs = [];
        try { subs = (parseLocalJSON(await this._askLocal(system, user, this._inferMeta('curriculum-decompose', { system, user })), ['subgoals']).subgoals || []).map(t => String(t).trim()).filter(t => t && t !== task && !validateTask(t)).slice(0, 4); }
        catch (e) {
            if (e instanceof Error && e.code === CONTEXT_FULL) throw e;
            console.log(`[psn] decompose FAILED for "${task}": ${e.message}`);
            return false;
        }
        if (subs.length < 2) { console.log(`[psn] decompose FAILED for "${task}": model gave ${subs.length} valid subgoal(s)`); d[task] = { subs, skills: [], at: Date.now(), reason: String(reason) }; this._saveProgress(); return false; }
        d[task] = { subs, skills: [], at: Date.now(), reason: String(reason) };
        q.unshift(...subs.map(t => ({ task: t, parent: task, depth: depth + 1 })), { task, retry: true, depth });
        this._saveProgress();
        console.log(`[psn] DECOMPOSE "${task}" (${String(reason).slice(0, 120)}) -> ${subs.map((t, i) => `${i + 1}) ${t}`).join(' ')}; then retry the parent with the learned skills`);
        return true;
    }
    // fix91: missing queue is empty. A non-array is a corrupt progress file.
    _queuedSubgoalCount() {
        const q = this.progress.subgoals;
        if (q === undefined || q === null) return 0;
        if (!Array.isArray(q)) throw new Error(`[fix91] progress.subgoals must be an array, got ${typeof q}`);
        return q.length;
    }
    // fix91: why this head cannot run, from the task text and the recorded state. null means it can run.
    // A child of a backed-off parent is not stale: the child is the decomposition. Only a retry of the
    // parent itself is removed, and only when the learned posterior backs that goal off in this state.
    _staleSubgoal(it, state) {
        if (it === null || typeof it !== 'object') throw new Error(`[fix91] subgoal entry must be an object, got ${JSON.stringify(it)}`);
        if (typeof it.task !== 'string' || it.task.length === 0) return 'empty task';
        const task = it.task;
        const blocked = this._contextBlockReason(task);
        if (blocked !== null) return blocked;
        const bad = validateTask(task);
        if (bad !== null) return bad;
        const prevSub = this._curSub;
        if (it.slotRequest) this._curSub = it;
        let g;
        try { g = this._resolveGoal(task); }
        finally { this._curSub = prevSub; }
        if (g.kind === 'invalid') return g.why;
        const retry = it.retry === true;
        if (!retry && typeof it.parent === 'string' && it.parent.length > 0) {
            const parent = it.parent;
            const d = this.progress.decomposed;
            if (d === null || d === undefined || typeof d !== 'object' || !Object.hasOwn(d, parent)) return `parent "${parent}" has no decomposition`;
            const rec = d[parent];
            if (rec === null || typeof rec !== 'object') throw new Error(`[fix91] decomposed[${JSON.stringify(parent)}] must be an object`);
            if (!Array.isArray(rec.subs)) throw new Error(`[fix91] decomposed[${JSON.stringify(parent)}].subs must be an array`);
            if (!rec.subs.includes(task)) return `parent "${parent}" no longer lists "${task}"`;
            // fix95: a parent that completed once is not done forever. A recurring need (need:hunger) completes, comes back,
            //        and is decomposed again; "completed ever" dropped every later food plan as stale (live: 337 "Collect 1
            //        apple" drops, the bot never ate). Only a completion AFTER this decomposition makes the child stale.
            if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) throw new Error(`[fix95] decomposed[${JSON.stringify(parent)}].at must be a time, got ${JSON.stringify(rec.at)}`);
            const at = this.progress.completedAt;
            if (at === null || typeof at !== 'object' || Array.isArray(at)) throw new Error('[fix95] progress.completedAt must be an object');
            if (Object.hasOwn(at, parent) && at[parent] >= rec.at) return `parent "${parent}" completed after it was decomposed`;
        }
        if (retry) {
            const why = this._goalStateBackedOff(task, state);
            if (why !== null) return why;
        }
        return null;
    }
    // fix95: the one place a task is recorded as completed: the history list and when it last completed.
    _markCompleted(task) {
        if (typeof task !== 'string' || task.length === 0) throw new Error(`[fix95] _markCompleted needs a task string, got ${JSON.stringify(task)}`);
        if (!Array.isArray(this.progress.completed)) throw new Error('[fix91] progress.completed must be an array');
        const at = this.progress.completedAt;
        if (at === null || typeof at !== 'object' || Array.isArray(at)) throw new Error('[fix95] progress.completedAt must be an object');
        this.progress.completed.push(task);
        at[task] = Date.now();
    }
    _dropSubgoal(it, why) {
        const q = this.progress.subgoals;
        if (!Array.isArray(q) || q.length === 0 || q[0] !== it) throw new Error(`[fix91] cannot drop subgoal ${JSON.stringify(it && it.task)}: it is not the queue head`);
        q.shift();
        if (!Array.isArray(this.progress.failed)) throw new Error('[fix91] progress.failed must be an array');
        this.progress.failed.push(`${it.task} (stale: ${why})`);
        this._saveProgress();
        console.log(`[psn] LOUD: subgoal "${it.task}" removed (${why})`);
    }
    // Same record a pursue makes when the goal already holds: success, not a fake failure.
    _noteSatisfiedSubgoal(task, reason) {
        console.log(`[voyager] goal already satisfied: ${task} (${reason})`);
        this._markCompleted(task);
        if (!Array.isArray(this.progress.failed)) throw new Error('[fix91] progress.failed must be an array');
        this.progress.failed = this.progress.failed.filter(t => t !== task);
        if (Array.isArray(this.progress.blockers)) this.progress.blockers = this.progress.blockers.filter(b => b.task !== task);
        this._recordGoalOutcome(task, true, null);
        this._saveProgress();
        if (typeof this.agent.openChat === 'function') this.agent.openChat(`Done: ${task} (already satisfied: ${reason}).`);
        this._afterSuccess();
    }
    // fix91: the next subgoal that the state still supports. Dead heads are removed here, in this step,
    // until one can run or the queue is empty. An empty or missing queue returns null and does not call
    // _subgoalTask (callers that stub _subgoalTask still reach the planner).
    _nextSubgoal(state) {
        const q = this.progress.subgoals;
        if (q === undefined || q === null) return null;
        if (!Array.isArray(q)) throw new Error(`[fix91] progress.subgoals must be an array, got ${typeof q}`);
        while (q.length > 0) {
            const it = q[0];
            const why = this._staleSubgoal(it, state);
            if (why !== null) {
                this._dropSubgoal(it, why);
                continue;
            }
            const prev = this._curSub;
            this._curSub = it;
            let sat;
            try { sat = this._goalAlreadySatisfied(it.task, state); }
            finally { this._curSub = prev; }
            if (sat.satisfied !== true && sat.satisfied !== false) throw new Error(`[fix91] _goalAlreadySatisfied("${it.task}") returned no boolean satisfied`);
            if (sat.satisfied === true) {
                q.shift();
                this._noteSatisfiedSubgoal(it.task, sat.reason);
                continue;
            }
            return this._subgoalTask();
        }
        return null;
    }
    _subgoalTask() {
        const q = this.progress.subgoals || []; if (!q.length) return null;
        const it = q.shift(); this._saveProgress(); this._curSub = it;
        if (it.retry) { const sk = this.progress.decomposed?.[it.task]?.skills || []; console.log(`[psn] retrying decomposed goal "${it.task}" with learned subgoal skills [${sk.join(', ')}]`);
            return { task: it.task, reasoning: 'PSN: retry after decomposition', context: sk.length ? `compose these learned skills (call them in order): ${sk.join(', ')}` : 'subgoals did not produce skills; try a smaller approach' }; }
        console.log(`[psn] subgoal of "${it.parent}": ${it.task}`);
        return { task: it.task, reasoning: `PSN subgoal of "${it.parent}"`, context: '' };
    }
    _subgoalDone(name) {
        const c = this._curSub; if (!c?.parent || !name) return;
        const d = this.progress.decomposed?.[c.parent]; if (!d) return;
        if (!d.skills.includes(name)) d.skills.push(name); this._saveProgress();
        console.log(`[psn] subgoal "${c.task}" done with skill ${name} (for parent "${c.parent}")`);
    }
    // fix28 (C): plan the next task concurrently with the current action; the plan is used only if the state it was made for still holds
    // fix35: also prefetch embeddings for skills mentioned in the context (overlapped with task execution)
    _prefetchPlan(task, before) {
        if ((this.progress.subgoals || []).length) { this._plan = null; console.log(`[plan] overlap skipped: ${this.progress.subgoals.length} subgoal(s) queued`); return; }   // fix30
        const t0 = Date.now();
        const p = this.proposeTask({ ...before, note: `The bot is now doing "${task}". Propose the task to do AFTER it, assuming it succeeds.` })
            .then(r => {
                console.log(`[plan] next proposal ready in ${Date.now() - t0}ms (overlapped with "${task}"): ${r?.task}`);
                if (r?.task) this._embed(r.task).catch(e => console.log(`[plan] embed prefetch failed: ${e.message}`));
                if (r?.context) this._prefetchRelatedEmbeds(r.context);
                return r;
            }, e => { console.log(`[plan] prefetch failed: ${e.message}`); return null; });
        this._plan = { p, task, basis: before, t: t0, rec: this._recovery() };   // fix59: learned recovery outlook the plan was made under
    }
    // fix59: nowRec = learned recovery outlook now; vitals make the plan stale only when the learned outlook changed (no fixed hp/food drop)
    _planStale(pl, r, now, nowRec) {
        if (!r?.task) return 'no proposal';
        if (Date.now() - pl.t > 20 * 60e3) return 'older than 20 min';
        const last = this.progress.failed.slice(-1)[0];
        if (last === pl.task) return `it assumed "${pl.task}" would succeed, but it failed`;
        if (String(r.task).trim() === pl.task) return 'it repeats the task it was planned during';
        const P = s => s.position.split(',').map(Number), [a, b] = [P(pl.basis), P(now)];
        if (Math.hypot(a[0] - b[0], a[2] - b[2]) > 32) return 'the bot moved more than 32 blocks';
        const ph = s => s.time.split(' ')[0]; if (ph(pl.basis) !== ph(now)) return `time of day changed (${ph(pl.basis)} -> ${ph(now)})`;
        if ((now.threats === 'none') !== (pl.basis.threats === 'none')) return 'threat situation changed';
        const vit = VitalsModel.outlookChange(pl.rec, nowRec); if (vit) return vit;   // fix58/fix59
        if (now.recent_deaths !== pl.basis.recent_deaths) return 'the bot died since';
        return null;
    }
    async _takePlan(before) {
        const pl = this._plan; this._plan = null;
        if (!pl) return this.proposeTask(before);
        const r = await pl.p, why = this._planStale(pl, r, before, this._recovery());
        if (!why) { console.log(`[plan] using the overlapped proposal (planned during "${pl.task}")`); return r; }
        console.log(`[plan] overlapped proposal "${r?.task}" is stale (${why}); re-planning`);
        return this.proposeTask(before);
    }
    // fix49: get edible items in inventory using minecraft-data foods (game data, not a list)
    // Returns array of { item, count, foodPoints, saturation } for items in inventory that are food
    _getEdibleInventory(inv) {
        if (!VERSION) throw new Error('[fix49] VERSION must be set to get edible inventory');
        const md = minecraftData(VERSION);
        const edible = [];
        // md.foods is keyed by item ID; check each inventory item against it
        for (const [itemName, count] of Object.entries(inv)) {
            if (count <= 0) continue;
            const item = md.itemsByName[itemName];
            if (!item) continue;
            const food = md.foods[item.id];
            if (food) {
                edible.push({
                    item: itemName,
                    count,
                    foodPoints: food.foodPoints,
                    saturation: food.saturation
                });
            }
        }
        // sort by effective quality (foodPoints + saturation)
        return edible.sort((a, b) => (b.foodPoints + b.saturation) - (a.foodPoints + a.saturation));
    }
    
    // fix49: goal backoff multiplier = posterior mean success (s+1)/(n+2) per goal+reason
    // Decay comes only from new evidence (new successes/failures), no time constants
    // fix55: summed over every failure reason of the goal; a goal with no recorded failure has nothing to back off from (multiplier 1)
    _goalOutcomes(task) {
        const prefix = `${task}::`;
        let s = 0, f = 0;
        for (const [k, v] of Object.entries(this.progress.goalStats)) if (k.startsWith(prefix)) { s += v.success; f += v.fail; }
        return { s, f };
    }
    // posterior mean (s+1)/(n+2), uniform prior. f === 0 → 1 (nothing to back off from).
    _posteriorMean(s, f) {
        if (typeof s !== 'number' || typeof f !== 'number' || Number.isNaN(s) || Number.isNaN(f)) throw new Error(`[fix90] posterior counts must be numbers, got ${JSON.stringify(s)}, ${JSON.stringify(f)}`);
        if (f === 0) return 1;
        const n = s + f;
        return (s + 1) / (n + 2);
    }
    _goalBackoffMultiplier(task) {
        const { s, f } = this._goalOutcomes(task);
        return this._posteriorMean(s, f);
    }
    // fix55: a proposed goal runs with probability = its posterior success; otherwise it is backed off to the planner.
    // No constants: the odds come only from learned outcomes, and a backed-off goal still gets retried at that rate.
    _goalBackedOff(task) {
        const m = this._goalBackoffMultiplier(task);
        if (m === 1 || Math.random() < m) return null;
        const { s, f } = this._goalOutcomes(task);
        return `backed off: it succeeded ${s} of ${s + f} tries (posterior success ${m.toFixed(2)}); propose something else`;
    }
    _goalFailStates() {
        if (!Object.hasOwn(this.progress, 'goalFailStates')) this.progress.goalFailStates = [];
        if (!Array.isArray(this.progress.goalFailStates)) throw new Error(`[fix90] progress.goalFailStates must be an array, got ${JSON.stringify(this.progress.goalFailStates)}`);
        return this.progress.goalFailStates;
    }
    // The state a "would this goal fail again" question is about: inventory counts and nearby blocks.
    // Time, position and the food number are not part of it (hunger ticking is not a new state).
    _goalStateKey(state) {
        if (!state || typeof state !== 'object') throw new Error('[fix90] goal state required');
        if (!state.inventory || typeof state.inventory !== 'object') throw new Error('[fix90] goal state.inventory required');
        if (!Array.isArray(state.nearby_blocks)) throw new Error('[fix90] goal state.nearby_blocks required');
        const inv = Object.keys(state.inventory).sort().map(k => `${k}:${state.inventory[k]}`).join(',');
        const near = [...state.nearby_blocks].sort().join(',');
        return `inv:${inv};near:${near}`;
    }
    _noteGoalState(task, ok, reason, state) {
        if (typeof task !== 'string' || task.length === 0) throw new Error(`[fix90] goal state outcome needs a task, got ${JSON.stringify(task)}`);
        if (typeof ok !== 'boolean') throw new Error(`[fix90] goal state outcome needs a boolean ok, got ${JSON.stringify(ok)}`);
        if (ok === false && (typeof reason !== 'string' || reason.length === 0)) throw new Error('[fix90] a failed goal needs a reason');
        if (ok === true && reason !== null) throw new Error('[fix90] a success has no failure reason');
        this._goalFailStates().push({ task, ok, reason, state: this._goalStateKey(state) });
    }
    _stateCounts(task, key) {
        let s = 0, f = 0;
        for (const g of this._goalFailStates()) {
            if (g.task !== task || g.state !== key) continue;
            if (g.ok === true) s++;
            else f++;
        }
        return { s, f };
    }
    // fix90: posterior of this goal in this state. Outcomes tagged to other states are not evidence here.
    // A goal with no tagged outcomes at all still uses the global posterior (_goalBackoffMultiplier).
    _goalStateBackedOff(task, state) {
        const tagged = this._goalFailStates().filter(g => g.task === task);
        if (tagged.length === 0) return this._goalBackedOff(task);
        const key = this._goalStateKey(state);
        const { s, f } = this._stateCounts(task, key);
        if (f === 0) return null;
        const m = this._posteriorMean(s, f);
        if (Math.random() < m) return null;
        let last = null;
        for (const g of tagged) if (g.state === key && g.ok !== true) last = g;
        if (last === null) throw new Error(`[fix90] ${task} counts ${f} failure(s) in this state but none are recorded`);
        return `backed off: "${task}" failed in this state (${last.reason}; state ${key}; posterior success ${m.toFixed(2)}); propose something else`;
    }
    // fix96: failure text written by a backoff carries the full state key ("state inv:...;near:..."). When that key is the
    //        state the prompt already shows, the copy says nothing new: it is named "the current state" (lossless).
    _withCurrentState(text, key) {
        if (typeof text !== 'string') throw new Error(`[fix96] failure text must be a string, got ${JSON.stringify(text)}`);
        if (typeof key !== 'string' || key.length === 0) throw new Error('[fix96] current state key required');
        return text.split(`state ${key}`).join('the current state');
    }
    // Failures recorded in the state the curriculum is looking at, for the prompt.
    _sameStateFailureHint(state) {
        const rows = this._goalFailStates().filter(g => g.ok !== true);
        if (rows.length === 0) return '';
        if (!state || typeof state.inventory !== 'object' || state.inventory === null || !Array.isArray(state.nearby_blocks)) {
            throw new Error('[fix90] curriculum state.inventory and state.nearby_blocks required to match recorded failures');
        }
        const key = this._goalStateKey(state);
        const here = rows.filter(g => g.state === key);
        if (here.length === 0) return '';
        const byTask = new Map();
        for (const g of here) byTask.set(g.task, g);
        const parts = [];
        for (const [task, g] of byTask) {
            const { s, f } = this._stateCounts(task, key);
            parts.push(`"${task}" failed because ${this._withCurrentState(g.reason, key)} (posterior success ${this._posteriorMean(s, f).toFixed(2)})`);
        }
        // fix96: every row here is in the current state (key); it is named once, not once per row
        return `\nfailed_in_this_state (the state has not changed — propose a different task; current state ${key}): ${parts.join('; ')}`;
    }
    // fix55: gate for a proposed task: syntax check, one goal resolver, learned backoff (planner proposals only).
    // fix90: when the caller passes the state, backoff is the posterior in that state.
    _rejectTask(task, fromPlanner, state) {
        if (!task) return 'empty task';
        if (typeof task === 'string' && task.length > 0) {
            const blocked = this._contextBlockReason(task);
            if (blocked !== null) return blocked;
        }
        const bad = validateTask(task);
        if (bad) return bad;
        const g = this._resolveGoal(task);
        if (g.kind === 'invalid') return g.why;
        if (!fromPlanner) return null;
        if (state !== undefined && state !== null) return this._goalStateBackedOff(task, state);
        return this._goalBackedOff(task);
    }
    // fix90: one planner proposal. A rejection is fed back (goal, reason, state) and the model is asked once more.
    // null when the second proposal is rejected too — the caller does not run it.
    async _acceptPlannerTask(proposal, state) {
        if (proposal === null || proposal === undefined || typeof proposal !== 'object') throw new Error('[fix90] proposal required');
        if (typeof proposal.task !== 'string') throw new Error(`[fix90] proposal.task must be a string, got ${JSON.stringify(proposal.task)}`);
        let task = proposal.task.trim();
        let why = this._rejectTask(task, true, state);
        if (why === null) return { proposal, task };
        console.log(`[voyager] rejected task "${task}": ${why}`);
        this.progress.failed.push(`${task} (invalid: ${why})`);
        const prev = typeof state.note === 'string' && state.note.length > 0 ? `${state.note}\n` : '';
        const next = await this.proposeTask({ ...state, note: `${prev}Your last proposal "${task}" was rejected: ${why}` });
        if (next === null || next === undefined || typeof next !== 'object') throw new Error('[fix90] proposeTask returned nothing after a rejection');
        if (typeof next.task !== 'string') throw new Error(`[fix90] proposal.task must be a string, got ${JSON.stringify(next.task)}`);
        task = next.task.trim();
        why = this._rejectTask(task, true, state);
        if (why !== null) {
            console.log(`[voyager] rejected again "${task}": ${why}; skipping`);
            this.progress.failed.push(`${task} (invalid: ${why})`);
            this._saveProgress();
            return null;
        }
        return { proposal: next, task };
    }
    
    // fix49: record goal outcome for backoff learning (keyed by goal + failure reason)
    // goalStats initialized at load time, entry created here on first outcome
    _recordGoalOutcome(task, success, reason) {
        const key = `${task}::${reason || ''}`;
        if (!this.progress.goalStats[key]) {
            this.progress.goalStats[key] = { success: 0, fail: 0 };
        }
        const entry = this.progress.goalStats[key];
        if (success) entry.success++;
        else entry.fail++;
        this._saveProgress();
    }
    
    async proposeTask(state) {
        const system = `You are the automatic curriculum for a Minecraft bot named ${this.agent.name} (Voyager-style).
Goal: discover as many diverse things as possible and grow a small town of its own, progressing wood -> stone -> iron -> diamond tech.
Rules:
- The bot's town is at x=${TOWN.x}, y=${TOWN.y}, z=${TOWN.z} (the bot's home base; ${this._hutBuilt() ? `its 7x7 cobblestone hut stands at x ${HOME.x-3}..${HOME.x+3}, z ${HOME.z-3}..${HOME.z+3}` : 'no hut exists there yet'}).
- NEVER go near the players' village around x=${VILLAGE.x}, z=${VILLAGE.z}; never take or break player builds.
- Propose ONE concrete, verifiable task achievable in a few minutes with the current inventory and surroundings (e.g. "Mine 5 birch_log", "Craft 1 stone_pickaxe", "Smelt 3 iron_ingot", "Build a 5x5 cobblestone floor next to the hut").
- Do not repeat completed tasks unless needed for progress; avoid tasks that failed recently unless prerequisites are now met.
- Do not propose a task listed under failed_in_this_state. It already failed for the reason given and the state has not changed.
- The bot must survive: dying loses its inventory. Nothing keeps it alive automatically (no eating, fleeing, fighting or sheltering reflexes), so survival is your job too: read time, health, food, threats and inventory space in the state and decide.
- A task is either an item goal ("<verb> N <item>", "Smelt N <raw> into N <out>", "ensure <block>"), the bare name of a known skill that takes no arguments besides bot (it is verified by that skill's learned postcondition), or a short free-text task.
Reply ONLY with JSON: {"reasoning": "ONE short sentence", "task": "...", "context": "short hint how to do it"}`;
        const bot = this.agent.bot;   // fix29: current vitals as plain facts, read now (an overlapped plan's state may be minutes old)
        // AWM-style: retrieve relevant workflows for context
        const taskContext = state.note || '';
        const relevantWorkflows = this.repairMemory.getWorkflowsForTask(taskContext || this.progress.failed.slice(-3).join(' '), 2);
        const workflowHints = this.repairMemory.formatWorkflowHints(relevantWorkflows);
        // fix39: enriched known_skills with descriptions for primitives and space-freeing skills
        // fix47: use compact state for curriculum (full state too verbose for local model context)
        const compactStateText = this._compactState(state);
        // fix97: the curriculum used to JSON-embed every primitive's full description (~8k chars). Retrieval returns the
        // skills relevant to this note and the recent failures, as signature plus description, not their source.
        let knownSkillsText;
        if (this.skills.length === 0) knownSkillsText = '[]';
        else {
            const queryParts = [];
            if (typeof state.note === 'string' && state.note.length > 0) queryParts.push(state.note);
            const failed = this.progress.failed;
            if (!Array.isArray(failed)) throw new Error('[fix97] progress.failed must be an array to retrieve curriculum skills');
            for (const row of failed.slice(-3)) queryParts.push(String(row));
            if (queryParts.length === 0) queryParts.push(compactStateText);
            const query = queryParts.join('\n');
            if (query.length === 0) throw new Error('[fix97] LOUD: curriculum has skills but no state, note, or failed task to retrieve against');
            if (typeof settings.skill_topk !== 'number') throw new Error('[fix97] settings.skill_topk required');
            const related = await this.retrieveSkills(query, settings.skill_topk);
            knownSkillsText = related.map(s => `${signatureOf(s.code, s.name)}: ${s.description}`).join('\n');
        }
        const replayableTasks = this.skills.filter(s => s.task && !s.primitive).map(s => s.task.split(/\s+(?:within|at|using|from)\b/i)[0]).slice(-25);
        // fix47: include active blockers so curriculum prioritizes unblocking goals
        // fix81: blockers are structured needs { item | anyOf, count, reason, task } (from _chainNeeds); resolved once held
        // fix91b: an anyOf blocker clears when any one member is held, and the line names every member
        const inv = state.inventory || {};
        const blockerHint = this._blockerHint(inv);
        // fix49: pass edible inventory (from minecraft-data foods) to curriculum - let the model rank
        const edible = VERSION ? this._getEdibleInventory(inv) : [];
        const edibleHint = edible.length > 0 
            ? `\nedible_inventory: ${edible.map(e => `${e.item}(${e.count}, food=${e.foodPoints})`).join(', ')}`
            : '';
        // fix58: learned recovery facts (food level -> hp regen, skills' observed food change) so the ranking can weigh recovery
        // fix76: hunger facts even when hp is full (recoveryText is null at max HP)
        const rec = this._recovery(), recText = this.vitals.recoveryText(rec);
        const hun = this._hunger(), hunText = this.vitals.hungerText(hun);
        const vmax = skills.getVitalsMax(bot);   // fix59: one source for hp/food max (was literal /20)
        if (rec.blocked) console.log(`[vitals] ${recText}`);
        if (hunText) console.log(`[vitals] ${hunText}`);
        const recoveryHint = recText ? `\n${recText}` : '';
        const hungerHint = hunText ? `\n${hunText}` : '';
        const failStateHint = this._sameStateFailureHint(state);   // fix90: goal, reason, state of failures in this state
        const stateKey = this._goalStateKey(state);
        const completedText = JSON.stringify(this.progress.completed.slice(-30));
        const failedText = JSON.stringify(this.progress.failed.slice(-15).map(f => this._withCurrentState(f, stateKey)));
        const replayableText = JSON.stringify(replayableTasks);
        const user = `known_skills: ${knownSkillsText}
replayable_tasks (cheap, no new code needed): ${replayableText} plus any "Mine N <block or ore>", "Collect N <log>", "Get N <item>", "Smelt N <raw> into N <out>", "Kill N <mob>", "Harvest N <crop>"
completed_tasks: ${completedText}
failed_tasks: ${failedText}${blockerHint}${edibleHint}${recoveryHint}${hungerHint}${failStateHint}
--- state (compact) ---
${compactStateText}
current_health: ${Math.round(bot.health)}/${vmax.health}\ncurrent_food: ${bot.food}/${vmax.food} (${vmax.food}/${vmax.food} = full)${this._cursorLimited() ? '\nIMPORTANT: the code-writing model is unavailable right now, so ONLY propose a task from replayable_tasks or "Mine N <block>".' : ''}${workflowHints ? '\n' + workflowHints : ''}`;   // fix31: slow-changing lists first so Ollama reuses the cached prompt prefix
        const facts = recipeFacts(this.progress.failed.slice(-5).join(' '));
        const finalUser = facts ? user + '\n' + facts : user;
        // fix47: per-prompt breakdown logging for curriculum
        // fix96: every section of the sent prompt is counted; framing is the fixed text around them (was ~half the prompt unlogged)
        this._logPromptBreakdown('curriculum', {
            system: system.length,
            skills: knownSkillsText.length,
            replayable: replayableText.length,
            completed: completedText.length,
            failed: failedText.length,
            blockers: blockerHint.length,
            edible: edibleHint.length,
            vitals: recoveryHint.length + hungerHint.length,
            failState: failStateHint.length,
            state: compactStateText.length,
            workflows: workflowHints ? workflowHints.length : 0,
            recipes: facts.length
        }, system.length + finalUser.length);
        return parseLocalJSON(await this._askLocal(system, finalUser, this._inferMeta('curriculum', { system, user: finalUser })), ['reasoning', 'task', 'context']);
    }

    // ---------- skill library ----------
    // fix35: stable hash for description+code freshness detection (re-embed when content changes)
    _embHash(s) {
        const src = (s.description || '') + '\n' + (s.code || '');
        let h = 0; for (let i = 0; i < src.length; i++) h = ((h << 5) - h + src.charCodeAt(i)) | 0;
        return h.toString(36);
    }
    async _embed(text) {
        const em = this.agent.prompter.embedding_model;
        if (!em) throw new Error('[voyager] embedding model required (no fallback)');
        const C = (this._embCache ||= new Map());   // fix32: LRU cache (256 entries)
        if (C.has(text)) { const v = C.get(text); C.delete(text); C.set(text, v); this._embHits = (this._embHits || 0) + 1; return v; }
        // fix97: prefetches fired Promise.all of /api/embed. Each client's learned bound includes only a small `over`
        // for queue time, so sibling embeds waiting inside Ollama exceeded the bound (~23.7s). One embed at a time:
        // the bound measures the call, not the wait for another embed. No new timeout.
        const prev = this._embedQ || Promise.resolve();
        let release;
        this._embedQ = new Promise(r => { release = r; });
        await prev;
        try {
            const v0 = await em.embed(text);   // fix14: fail loudly, no word-overlap fallback
            const v = Array.isArray(v0?.[0]?.values) ? v0[0].values : v0;
            C.set(text, v); if (C.size > 256) C.delete(C.keys().next().value);
            return v;
        } finally { release(); }
    }
    // fix35: prefetch embeddings for skill names mentioned in a context string (overlapped with other work)
    _prefetchRelatedEmbeds(context) {
        if (!context) return;
        const names = (context.match(/\b[a-z][A-Za-z0-9]+\b/g) || []).filter(n => this.skills.some(s => s.name === n));
        if (!names.length) return;
        const t0 = Date.now();
        console.log(`[overlap] prefetching embeds for ${names.length} skill(s) mentioned in context: ${names.join(', ')}`);
        Promise.all(names.map(async n => {
            const s = this.skills.find(x => x.name === n);
            if (s && s.description) await this._embed(s.description);
        })).then(() => console.log(`[overlap] prefetch of ${names.length} skill embed(s) done in ${Date.now() - t0}ms`))
          .catch(e => console.log(`[overlap] prefetch failed: ${e.message}`));
    }
    async retrieveSkills(query, k = 5) {
        if (!this.skills.length) return [];
        const q = await this._embed(query);
        // fix35: re-embed skills whose description/code changed (hash-based freshness) or wrong embedding length
        let changed = false;
        for (const s of this.skills) {
            const hash = this._embHash(s);
            const stale = !s.embedding || s.embedding.length !== q.length || s._embHash !== hash;
            if (stale) {
                if (s._embHash && s._embHash !== hash) console.log(`[voyager] re-embedding ${s.name}: description/code changed`);
                s.embedding = await this._embed(s.description);
                s._embHash = hash;
                changed = true;
            }
        }
        if (changed) { this._saveSkills(); console.log('[voyager] re-embedded skill library (model mismatch or content changed)'); }
        const scored = this.skills.filter(s => !s.demoted && !s.mergedInto).map(s => ({ s, score: cosineSimilarity(q, s.embedding) }));
        scored.sort((a, b) => b.score - a.score);
        // fix35: diversity filter - skip skills with >0.95 similarity to already-selected ones (avoid near-duplicate neighbors)
        const selected = [];
        for (const cand of scored) {
            if (selected.length >= k) break;
            const tooSimilar = selected.some(sel => cosineSimilarity(sel.s.embedding, cand.s.embedding) > 0.95);
            if (tooSimilar) { console.log(`[voyager] diversity: skipping ${cand.s.name} (too similar to already-selected skill)`); continue; }
            selected.push(cand);
        }
        console.log(`[voyager] skill search (embeddings) top: ${selected.slice(0, 3).map(x => x.s.name + '=' + x.score.toFixed(2)).join(' ')}${selected.length < scored.length ? ` (${scored.length - selected.length} skipped for diversity)` : ''}`);
        return selected.map(x => x.s);
    }
    async saveSkill(name, description, code, task, opts = {}) {
        // fix73: effects observed by the run that produced this code. Every caller sets this._lastEffects right before calling
        // (writeCode success, repair, joint repair, refactor, generalise, split); it is taken here and cleared, so a caller that
        // forgot it throws instead of saving the previous save's effects (the field used to persist across calls) or a default
        const observedEffects = this._lastEffects;
        this._lastEffects = null;
        this._installRejection = null;
        if (!Array.isArray(observedEffects)) throw new Error(`[psn] saveSkill ${name}: no observed effects set by the caller (this._lastEffects=${JSON.stringify(observedEffects)})`);
        // fix26: names must include BOTH learned skills AND built-in bare API (skills.*/world.* exports)
        // so missingCalls doesn't reject repairs that call getNearestBlock, getInventoryCounts, etc.
        const bareAPI = getBareAPI();
        const names = new Set([...this.skills.map(s => s.name), ...bareAPI.names]);
        // fix68: deps are LIBRARY skills only, as _relink computes them on every start. fix26 (89b03dd) widened the name set
        // for missingCalls and deps with it, so a saved/promoted skill carried built-ins (getInventoryCounts...) in its deps
        // until the next restart; those entered replay closures and were traced (see skill_graph instrumentSrc fix68)
        const missing = missingCalls(code, name, names);
        if (missing.length) { gateLog(`REJECT ${name}: calls unknown skills ${missing.join(', ')}`); return false; }
        // fix74: the unmet-precondition marker is for repo-owned seeded primitives only (it voids a run's stats, fix76); model
        //        code (new, repaired, refactored) that names it is rejected. missingCalls cannot see it (camelCase calls only).
        // fix85: new code must not introduce the marker. A repair of code that already calls it must keep each call
        // (a collectBlock repair that replaced the reach call with a log of the comment was accepted, and that FAILED
        // line then became the evidence for mineBlocks).
        const incumbent = this.skills.find(s => s.name === name);
        const markerGap = markerCallsMissing(incumbent ? incumbent.code : '', code, PRECONDITION_UNMET_BINDING);
        if (markerGap) { gateLog(`REJECT ${name}: ${markerGap}`); return false; }
        // fix82: every path that puts model code into the library (writeCode, repair, joint repair, refactor, generalise,
        //        split) passes here. One top-level function per source (a second one is a hidden global of every bundle that
        //        stages this skill: live checkIronPickaxe, 18:23:44Z) and the static API gate writeCode already ran (only
        //        writeCode ran it: the 18:27:59Z craftItem repair with bot.recipes was HELD and threw in both trials).
        const shape = skillSourceViolations(code, name);
        if (shape.length) { gateLog(`REJECT ${name}: not one top-level function: ${shape.join('; ')}`); return false; }
        const apiErr = this.agent.coder._apiGate(code, [...names, ...markerGateNames(incumbent ? incumbent.code : '', PRECONDITION_UNMET_BINDING)]);
        if (apiErr) { gateLog(`REJECT ${name}: ${apiErr}`); return false; }
        // fix39: seeded primitives must not depend on learned skills (prevents cycles like
        // ensureCraftingTable -> depositToChest -> ensureChest -> ensureCraftingTable).
        // fix88: the same self-call and cycle check _relink throws on at boot. A violating candidate is not written.
        const deps = this._candidateDeps(name, code);
        const violations = installViolations({ name, code, deps }, this.skills);
        if (violations.length > 0) { this._installRejection = this._recordInstallRejection(name, violations); return false; }
        const embedding = await this._embed(description);
        const idx = this.skills.findIndex(s => s.name === name);
        if (idx < 0) {
            // fix73: effects are what this run observed (observedEffects); consumes starts as observed-nothing like every other entry (load-time init, split/generalise entries). It was
            // missing here, and _learnEffects compares against `e.consumes || {}`, so a run that consumed nothing never set it:
            // the skill stayed `consumes: undefined` in memory until a restart, and idle practice's Object.keys(skill.consumes)
            // threw "Cannot convert undefined or null to object" (equipBestToolForIronOre, NEW 14:43:51Z, practice 15:02:47Z)
            const entry = { name, description, task, code, deps, embedding, effects: observedEffects, consumes: {}, saved: new Date().toISOString(), stats: recordRun(newStats(), task, true) };
            if (this._promptCounts !== undefined) {
                if (this._promptCounts === null || typeof this._promptCounts !== 'object' || Array.isArray(this._promptCounts)) throw new Error(`[fix97] saveSkill ${name}: prompt counts are not an object`);
                entry.promptCounts = this._promptCounts;
                this._promptCounts = undefined;
            }
            this.skills.push(entry);
            writeAtomic(`${this.dir}/${name}.js`, `// ${description}\n${code}\n`);
            this._saveSkills();
            gateLog(`NEW ${name} deps=[${deps.join(', ')}]`);
            if (!this._cursorLimited()) await this._learnContracts([entry], 'saved');   // fix24: contract learned at save time
            this._extractShared();
            console.log(`[voyager] saved skill ${name}: ${description}`);
            return true;
        }
        // updating an existing skill (learned or handwritten): never overwrite directly
        const entry = this.skills[idx];
        if (entry.handwritten && !entry.handwritten_original) entry.handwritten_original = { code: entry.code, description: entry.description, deps: entry.deps };
        const cand = { code, description, deps, embedding, task, effects: observedEffects, stats: newStats() };   // fix11 (B2): no seeded success; trial runs only
        if (this._promptCounts !== undefined) {
            if (this._promptCounts === null || typeof this._promptCounts !== 'object' || Array.isArray(this._promptCounts)) throw new Error(`[fix97] saveSkill ${name}: prompt counts are not an object`);
            cand.promptCounts = this._promptCounts;
            this._promptCounts = undefined;
        }
        if (!opts.repair && !opts.refactor && !this._updateAllowed(entry, 'new version from a task')) return false;
        if (opts.refactor) cand.refactor = opts.refactor;
        const reg = await this._regressionRun(entry, code);
        if (reg === true) { if (this._promote(entry, cand) === false) return false; gateLog(`PROMOTE ${name}: passed regression rerun on a past task`); }
        else if (reg === false) { gateLog(`REJECT update to ${name}: failed regression rerun on a past task; keeping current version`); this._proposalOutcome(entry, 'failed regression rerun'); if (opts.refactor) this._rollbackRefactor(opts.refactor, name); }
        else if (opts.repair) { entry.candidate = cand; gateLog(`HOLD repair of ${name}: kept as candidate; needs 2+ trial runs with success rate >= current ${rate(entry.stats || newStats()).toFixed(2)}`); }   // fix11 (B3)
        else if (!entry.handwritten && !(entry.stats?.success)) { if (this._promote(entry, cand) === false) return false; gateLog(`PROMOTE ${name}: current version has no recorded successes`); }
        else { entry.candidate = cand; gateLog(`HOLD ${name}: new version kept as candidate (1/1); needs 2+ trial runs with success rate >= current ${rate(entry.stats).toFixed(2)}`); }
        this._saveSkills();
        return true;
    }
    // restore a handwritten skill to its original code
    restoreHandwritten(name) {
        const e = this.skills.find(s => s.name === name);
        if (!e?.handwritten_original) return false;
        e.prev = { code: e.code, description: e.description, deps: e.deps, stats: e.stats };
        Object.assign(e, e.handwritten_original); delete e.candidate; e.demoted = false;
        writeAtomic(`${this.dir}/${name}.js`, `// ${e.description}\n${e.code}\n`);
        this._saveSkills(); gateLog(`RESTORED handwritten original of ${name}`); return true;
    }

    // ---------- critic ----------
    async critique(task, before, after, output, label) {
        // fix37 (D): detect inventory-full as a cause of failure (stated as fact, not rule)
        const invFullFact = this._detectInventoryFullFailure(task, before, after, output);

        const system = `You are an assistant that checks whether a Minecraft bot completed its task, using its state before and after and the code output.
Be strict: success only if the evidence (inventory/position/output) shows the task is done.
Reply ONLY with JSON: {"reasoning": "ONE short sentence", "success": true|false, "critique": "how to fix it if failed (1-2 sentences), else empty"}`;
        const user = `task: ${task}\n${recipeFacts(task)}\n--- before ---\n${this._stateText(before)}\n--- after ---\n${this._stateText(after)}\n--- code output ---\n${output}${invFullFact ? `\n--- observed fact ---\n${invFullFact}` : ''}`;
        const v = parseLocalJSON(await this._askLocal(system, user, this._inferMeta('critic', { system, user })), ['reasoning', 'success', 'critique']);

        // fix37 (D): if inventory full was detected as a cause, ensure it's in the critique for contract/decompose learning
        if (invFullFact && !v.success && v.critique && !v.critique.toLowerCase().includes('inventory')) {
            v.critique = `${invFullFact}. ${v.critique}`;
        }

        try { appendFileSync(`./bots/${this.agent.name}/critic_cases.jsonl`, JSON.stringify({ at: new Date().toISOString(), task, system, user, verdict: v, label: label ?? null, invFullFact }) + '\n'); } catch (e) { console.log('[critic] case log failed: ' + e.message); }   // fix32: eval set for critic-model trials
        return v;
    }

    // fix37 (D): detect if inventory-full caused a gather/craft/pickup failure
    // Returns a fact string if detected, null otherwise. No rules, just observable facts.
    // fix25: prefer smeltGoal so "Smelt X into Y" detects by product (Y), not ingredient (X)
    _detectInventoryFullFailure(task, before, after, output) {
        const goal = smeltGoal(task) || countGoal(task);  // fix25: smelt first (product)
        if (!goal) return null;

        const emptyBefore = before.empty_inventory_slots ?? 36;
        const emptyAfter = after.empty_inventory_slots ?? 36;
        const invBefore = before.inventory || {};
        const invAfter = after.inventory || {};

        // Calculate how many items were gained
        const gained = goal.items
            ? goal.items.reduce((a, it) => a + (invAfter[it] || 0) - (invBefore[it] || 0), 0)
            : (invAfter[goal.item] || 0) - (invBefore[goal.item] || 0);

        // Detect inventory-full failure: gained +0 (or very few) with 0-2 empty slots
        if (gained < goal.count && emptyAfter <= 2) {
            const totalItems = Object.values(invAfter).reduce((a, b) => a + b, 0);
            const topItems = Object.entries(invAfter).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', ');

            if (emptyAfter === 0) {
                return `Inventory is full (0 empty slots, ${totalItems} total items). Gained +${gained} ${goal.item} (needed ${goal.count}). Largest stacks: ${topItems}`;
            } else {
                return `Inventory nearly full (${emptyAfter} empty slots, ${totalItems} total items). Gained +${gained} ${goal.item} (needed ${goal.count}). Largest stacks: ${topItems}`;
            }
        }

        // Also detect if output mentions inventory full
        if (/inventory.*full|no.*space|cannot.*pick/i.test(output) && emptyAfter <= 3) {
            const totalItems = Object.values(invAfter).reduce((a, b) => a + b, 0);
            return `Code output indicates inventory space issue (${emptyAfter} empty slots, ${totalItems} total items)`;
        }

        return null;
    }

    // fix12: is there a hut at HOME? roof over the centre plus walls on both sides, at any floor level within HOME.y±4 (unloaded chunk = not built)
    _hutBuilt() {
        const bot = this.agent.bot, V = bot.entity.position.constructor;
        const solid = (x, y, z) => { const b = bot.blockAt(new V(x, y, z)); return !!b && b.boundingBox === 'block'; };
        for (let y = HOME.y - 4; y <= HOME.y + 4; y++)
            if (solid(HOME.x, y + 3, HOME.z) && solid(HOME.x - 3, y, HOME.z) && solid(HOME.x + 3, y, HOME.z) && solid(HOME.x, y + 1, HOME.z + 3)) return true;
        return false;
    }

    // ---------- iterative prompting ----------
    // fix18: safety() and _housekeep() removed (hard-coded survival/inventory policy); see .bak-fix18
    // fix5: one-shot owner-approved commands, read once from ~/MinecraftBot/oneshot_cmds.txt, sent as chat, file deleted
    _oneshot() {
        const f = (process.env.HOME || '') + '/MinecraftBot/oneshot_cmds.txt';
        if (this._oneshotDone || !existsSync(f)) return;
        this._oneshotDone = true;
        const lines = readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
        unlinkSync(f);
        for (const l of lines) { console.log(`[oneshot] sending approved command: ${l}`); this.agent.bot.chat(l); }
    }

    _watchWindows() {
        const bot = this.agent.bot; if (this._winWatch) return; this._winWatch = true;
        bot.on('windowOpen', w => { this._winOpenedAt = Date.now(); const t = JSON.stringify(w.title); if (/CHOICE/.test(t)) { this._choiceCount = (this._choiceCount || 0) + 1; setTimeout(() => this._answerChoice(w), 300); return; } this._winSeen = this._winSeen || {}; if ((this._winSeen[t] = (this._winSeen[t] || 0) + 1) > 1) return; console.log(`[window] opened ${w.type} "${typeof w.title === 'string' ? w.title.slice(0, 60) : JSON.stringify(w.title).slice(0, 60)}" id=${w.id} during action=${this.agent.actions.currentActionLabel || 'none'}`); });
    }

    // fix7 (Mo-approved): answer A Breach Happened CHOICE dialogs with "No" (pack: No/No... = /trigger abh.choice set 1 = decline).
    // Only clicks a button labelled exactly No / No...; other dialogs (Blocks/Entities, Chunks/Life) are logged and left unanswered.
    async _answerChoice(w) {
        const bot = this.agent.bot; if (bot.currentWindow !== w) return;
        const label = it => { try { const n = it.customName; if (!n) return it.displayName || it.name; const j = typeof n === 'string' && n.startsWith('{') ? JSON.parse(n) : n; const flat = o => typeof o === 'string' ? o : (o.text || o[''] || '') + (o.extra || []).map(flat).join(''); return flat(j); } catch (e) { return String(it.customName); } };
        const items = w.slots.slice(0, w.inventoryStart ?? 27).map((it, i) => it && { i, l: label(it).replace(/§./g, '').trim() }).filter(Boolean);
        const key = items.map(x => x.l).join('|');
        const no = items.find(x => /^No(\.\.\.)?$/i.test(x.l));
        if (!no) { if (this._choiceUnans !== key) { this._choiceUnans = key; console.log(`[choice] CHOICE dialog without a No option, NOT answering: [${key.slice(0, 200)}]`); } return; }
        console.log(`[choice] answering CHOICE dialog "No" (slot ${no.i}); options: [${key.slice(0, 200)}]`);
        try { await bot.clickWindow(no.i, 0, 0); } catch (e) { console.log('[choice] click No FAILED: ' + e.message); }
    }

    // fix8 (Mo-approved standing): leave A Breach Happened dimensions (abh:truth, abh:void, abh:deeper_void, abh:the_library).
    // Pack's normal exit from abh:truth = sneak there (advancement abh:truth/leave -> function abh:truth/leave -> tp to stored overworld pos),
    // blocked only while the pack freezes the player during a monologue. Other abh dims have no player action exit in the pack.
    // If still in an abh dimension after 60s, send the ONE pre-approved command, at most once per 2 min.
    _watchDimension() {
        if (this._dimWatch) return; this._dimWatch = true;
        const bot = this.agent.bot;
        const tpCmd = () => `/execute in minecraft:overworld run tp icefox2000 ${HOME.x} ${HOME.y} ${HOME.z}`;
        this._dimTimer = setInterval(() => {
            const dim = String(bot.game?.dimension || '');
            if (dim !== this._lastDim) { this._lastDim = dim; console.log(`[dimension] now ${dim}`); }
            if (!/abh:/.test(dim)) { if (this._abhSince) { console.log(`[dimension] back in ${dim} after ${Math.round((Date.now() - this._abhSince) / 1000)}s in abh dimension`); bot.setControlState('sneak', false); } this._abhSince = 0; return; }
            if (!this._abhSince) { this._abhSince = Date.now(); console.log(`!!! [dimension] in datapack dimension ${dim}; trying normal exit${dim === 'abh:truth' ? ' (sneak)' : ' (none in pack; waiting 60s)'}`); }
            if (dim === 'abh:truth') { bot.setControlState('sneak', true); setTimeout(() => bot.setControlState('sneak', false), 1500); }
            const waited = Date.now() - this._abhSince;
            if (waited > 60000 && Date.now() - (this._abhTpAt || 0) > 120000) {
                this._abhTpAt = Date.now();
                console.log(`!!! [dimension] still in ${dim} after ${Math.round(waited / 1000)}s; sending pre-approved command: ${tpCmd()}`);
                bot.chat(tpCmd());
            }
        }, 3000);
    }

    // ---------- fix10: PSN failure attribution and targeted repair ----------
    // dependency closure of a skill (all skills it can reach through deps)
    _closure(name) { const g = this._graph(), seen = new Set(), st = [...(g[name] || [])]; while (st.length) { const n = st.pop(); if (seen.has(n)) continue; seen.add(n); st.push(...(g[n] || [])); } return seen; }
    // fix11 (B1): only hand-written/primitive skills with no skill deps are fixed leaves; learned skills stay repairable.
    // Names outside the library (freshly generated code) are not leaves.
    _isLeaf(name) { if (name.startsWith('skills.')) return true;   // fix21: traced primitives are fixed leaves
        return false; }   // fix33: seeded primitives are library skills: blamed and repaired like learned ones (e.g. travelTo learns to leave water)   // fix24: hand-written skills are repairable
    // fix79: route is the replay's route evidence for an item goal (_routeFit) or null when the run was not routed by it
    _attribute(root, task, ok, over, route) {
        if (route !== null && (typeof route !== 'object' || typeof route.fits !== 'boolean')) throw new Error(`[fix79] _attribute needs route evidence (a _routeFit result) or null, got ${JSON.stringify(route)}`);
        const bot = this.agent.bot, trace = bot.__psnTrace;
        bot.__psnTrace = null;
        if (!Array.isArray(trace) || !trace.length) { console.log('[psn] no execution trace recorded'); return; }
        annotateTrace(trace, bot.__psnOut || '');
        this._learnRunDurations(trace);   // fix74: before the cut attribution below rewrites intr
        this._checkContracts(trace, ok);   // fix22: learned pre/postconditions against real state
        this._learnVitalsEffects(trace);   // fix58
        this._learnSlotEffects(trace);   // fix59
        // re-validation of parents marked after a child repair
        let revalFail = null;
        for (const e of this.skills.filter(s => s.revalidate)) {
            const rec = trace.find(t => t.name === e.name);
            if (!rec || rec.intr) continue;
            if (rec.ok) { console.log(`[psn] re-validated ${e.name} after repair of ${e.revalidate}: contract ok`); delete e.revalidate; }
            else { console.log(`[psn] re-validation of ${e.name} after repair of ${e.revalidate}: still failing -> blaming its trace`); revalFail ||= e.name; }
            this._saveSkills();
        }
        // fix19 (6): a death is a failure of the call that was running (deepest open call) and all its ancestors
        const died = this._diedInRun();
        // fix51: pass beforeInv for items-dropped reporting
        if (died) { let i = -1; for (let k = 0; k < trace.length; k++) if ((trace[k].t0 || 0) <= died.t && (trace[k].t1 ?? Infinity) >= died.t - 1500 && (i < 0 || trace[k].depth >= trace[i].depth)) i = k; if (i < 0) i = trace.length - 1; console.log(`[psn] death attributed to the call running at death time: ${trace[i].name} (depth ${trace[i].depth})`); trace[i].ownFail = [`DIED: ${died.message} at ${died.pos}${this._deathDetail(died, this._beforeRunInv)}`]; for (; i >= 0; i = trace[i].parent) { trace[i].intr = false; trace[i].ok = false; trace[i].fail = true; } ok = false; }
        const stalled = !died && this._stalledInRun();   // fix27: a stall is a failure of the deepest call open at stall time
        if (stalled) { let i = -1; for (let k = 0; k < trace.length; k++) if ((trace[k].t0 || 0) <= stalled.t && (trace[k].t1 ?? Infinity) >= stalled.t - 1500 && (i < 0 || trace[k].depth >= trace[i].depth)) i = k; if (i < 0) i = trace.length - 1; console.log(`[psn] stall attributed to the call running at stall time: ${trace[i].name} (depth ${trace[i].depth})`); trace[i].ownFail = [`FAILED: STALLED: no progress (no new ground reached, inventory, window, lit furnace) for ${stalled.why} at ${stalled.pos}`]; for (; i >= 0; i = trace[i].parent) { trace[i].intr = false; trace[i].ok = false; trace[i].fail = true; } ok = false; }
        // fix75: from the action result (was /timed out/ on the action output; the timeout notice goes to history, so the output has it only if the skill logged those words)
        const timedOut = !died && !stalled && this._lastRunTimedOut === true;   // fix33: a timeout is a failure of the deepest call running at the cut
        if (timedOut) {
            this._lastCutKind = 'timeout';  // fix51: set structured kind field
            const ix = trace.map((r, k) => k).filter(k => trace[k].intr && trace[k].t1); const cutT = Math.min(...ix.map(k => trace[k].t1)); let i = -1;
            for (const k of ix) if (trace[k].t1 <= cutT + 1500 && (i < 0 || trace[k].depth >= trace[i].depth)) i = k;
            if (i < 0) i = trace.length - 1; while (i >= 0 && trace[i].name.startsWith('skills.') && trace[i].parent >= 0) i = trace[i].parent;
            console.log(`[psn] timeout attributed to the call running at the cut: ${trace[i].name} (depth ${trace[i].depth})`);
            trace[i].ownFail = [`FAILED: TIMED OUT while running (${String(trace[i].ownFail?.join(' | '))})`]; for (; i >= 0; i = trace[i].parent) { trace[i].intr = false; trace[i].ok = false; trace[i].fail = true; } ok = false;
        }
        // fix65: a crash (uncaught exception/rejection) during the step is a failure of the call running when it was thrown,
        // like a death or a stall; before, the step was stopped and every open call stayed `intr`, so nothing was counted
        const crashed = !died && !stalled && !timedOut && this._crashedInRun();
        if (crashed) { let i = -1; for (let k = 0; k < trace.length; k++) if ((trace[k].t0 || 0) <= crashed.t && (trace[k].t1 ?? Infinity) >= crashed.t && (i < 0 || trace[k].depth >= trace[i].depth)) i = k; if (i < 0) i = trace.length - 1; console.log(`[psn] crash attributed to the call running when it was thrown: ${trace[i].name} (depth ${trace[i].depth})`); trace[i].ownFail = [`FAILED: CRASHED: ${crashed.kind}: ${crashed.message}`]; for (; i >= 0; i = trace[i].parent) { trace[i].intr = false; trace[i].ok = false; trace[i].fail = true; } ok = false; }
        // candidate children: their contract result in this run is a trial run (regression gate).
        // fix65: read AFTER the death/stall/timeout/crash attribution above. Those cuts leave every open call `intr` until they
        // are attributed, and this loop used to run first and skip `intr` records, so a candidate that stalled, timed out or
        // crashed was never counted against.
        for (const name of Object.keys(over)) {
            if (name === root) continue;
            const rec = trace.find(t => t.name === name);
            const e = this.skills.find(s => s.name === name);
            if (rec && e && e.candidate && !rec.intr) {
                const libF = !rec.ok && this._libraryFault(trace, name);
                let unmetC = null;
                if (!rec.ok && !libF) {
                    if (rec.reportedNeed || peekPreconditionUnmet(this.agent.bot)) unmetC = 'precondition';
                    else if (rec.s0 && typeof rec.s0.food === 'number') unmetC = this._foodRaiseSaturated(name, rec.s0.food);
                    // no s0 (hung/crash before snapshot): cannot claim food_saturated; count as a normal trial fail
                }
                if (unmetC) gateLog(`candidate ${name} unmet precondition (${unmetC}): not a trial fail`);
                else if (!libF) { gateLog(`trial run of candidate ${name} inside ${root}: contract ${rec.ok ? 'ok' : 'FAILED'}`); this._recordRun(e, task, rec.ok, true); }   // fix70: not on a library fault; fix76: not on unmet precondition
            }
        }
        // fix27: no hotspot filter; deaths stay traced failures (above) and blame/repair learns avoidance
        // fix19 (5): an explicit FAILED line from a skill is a contract failure even if the task check passed (e.g. ensureChest inside a storage task)
        const explicit = trace.some(r => !r.intr && (r.ownFail || []).some(l => /FAILED|CONDITION violated/.test(l)));   // fix22: contract violations count
        if (ok && !revalFail && !explicit) return;
        if (!ok && !died && !stalled && !timedOut && !crashed) {
            const slotNeed = this._blockingSlotNeed(trace);
            if (slotNeed !== null) {
                console.log(`[slot] capacity failure item=${slotNeed.item} count=${slotNeed.count} owner=${slotNeed.owner}; not a repair`);
                return;
            }
        }
        if (ok && explicit) console.log(`[psn] task check passed but a skill reported FAILED; attributing that contract failure`);
        console.log(`[psn] execution trace of ${root} (${trace.length} calls):\n${traceText(trace)}`);
        const learned = n => !!this.skills.find(s => s.name === n);   // fix33: seeded primitives included   // fix24: includes hand-written (repairs become learned candidates)
        let bs = blameAll(trace, n => this._isLeaf(n), learned).slice(0, 3);   // at most 3 patches per failure (deepest first)
        // fix70: a blamed skill that ran its CANDIDATE code in this run failed as that candidate: the gate already counted the
        // trial against the candidate. Queuing a repair of the skill with that evidence repaired the INCUMBENT for an error its
        // code never raised (13:40Z: the 13:39Z eatCookedMutton candidate's TypeError "reading 'food'" became the evidence of
        // the 14:12Z repair of the incumbent, which only ever returned undefined).
        const ranCandidate = bs.filter(b => Object.prototype.hasOwnProperty.call(over, b.target));
        for (const b of ranCandidate) console.log(`[psn] blame of ${b.target} is its candidate's trial failure (counted by the gate); no repair of the incumbent from it: ${b.evidence.slice(0, LOG_EVIDENCE_CHARS)}`);
        bs = bs.filter(b => !ranCandidate.includes(b));
        // fix86: a callee that did not throw, whose learned produces are non-empty and disjoint from the goal, is not
        //        the failure (ensureFurnaceWithinSixteen on collectOakLog). A throw is still that skill's failure.
        if (bs.length) {
            const blamedGoal = this._resolveGoal(task);
            const blamedItems = blamedGoal.kind === 'item' ? (blamedGoal.items || [blamedGoal.item]) : blamedGoal.kind === 'ensure' || blamedGoal.kind === 'reach' ? [blamedGoal.item] : [];
            if (blamedItems.length) {
                bs = bs.filter(b => {
                    const e = this.skills.find(s => s.name === b.target);
                    const rec = trace.find(t => t.name === b.target);
                    if (!e || !rec || rec.err) return true;
                    if (!this._routeProducesFit(b.target, blamedItems)) {
                        console.log(`!!! [blame] MISROUTE: ${b.target} did not throw on "${task}" and its learned produces do not include [${blamedItems.join(', ')}]; not blamed`);
                        return false;
                    }
                    return true;
                });
            }
        }
        if (!bs.length && ranCandidate.length) return;
        // fix19 (2): no learned skill on a failure path: the root's own composition is at fault
        if (!bs.length) {
            const b0 = blame(trace, n => this._isLeaf(n));
            const why = b0 ? (b0.target ? `failure only in non-library code ${b0.target} (${b0.evidence})` : `only the fixed leaf ${b0.leaf} failed (${b0.evidence})`) : 'every call met its contract but the task outcome failed';
            // fix79: every call met its contract and the route had no learned evidence that the root produces the goal: the
            //        skill did what it does; the route that sent it here is wrong. No root blame, no repair, no decomposition.
            if (!b0 && !ok && route !== null && !route.fits) {
                console.log(`!!! [blame] MISROUTE: ${root} met its own contract on "${task}"; it has no learned evidence it produces [${route.items.join(', ')}] (learned produces [${route.produces.join(', ')}]); the route is blamed, not ${root}`);
                return MISROUTED;
            }
            if (learned(root)) { bs = [{ target: root, leaf: root, path: [root], kind: 'callee_fix', swallowed: false, evidence: why }]; console.log(`[psn] blame: root learned skill ${root} [callee_fix]: ${why}`); }
            else { console.log(`[psn] blame: ${why}; root ${root} is ${this.skills.some(s => s.name === root) ? 'primitive/hand-written' : 'freshly generated'} -> goal goes to decomposition`); this._decomposeQueue ||= { task, reason: why }; return; }
        } else console.log(`[psn] blame (top-down over ${bs.length} responsible skill(s), patched bottom-up): ${bs.map(b => `${b.target} [${b.kind}${b.swallowed ? ', swallowed' : ''}]`).join(', ')}; path ${bs[0].path.join(' > ')}; deepest failure ${bs[0].leaf}: ${bs[0].evidence}`);
        { // fix32 (PSN joint repair): a blamed child and a blamed ancestor on the same failure path are repaired together
            const kid = bs.length >= 2 && bs.find(c => bs.some(q => q !== c && (c.path || []).includes(q.target)));
            if (kid) { const par = bs.find(q => q !== kid && kid.path.includes(q.target)); bs = [{ ...kid, kind: 'joint', parent: par.target, parentKind: par.kind }, ...bs.filter(x => x !== kid && x !== par)]; console.log(`[psn] JOINT repair queued: child ${kid.target} [${kid.kind}] with its caller ${par.target} [${par.kind}] (same failure path)`); }
        }
        const rq = [...(this._repairQueue || [])];
        // fix47: hash-based deduplication - signature includes skill hash so it resets when skill changes
        const failSig = (b) => this._repairSig(b.target, b.evidence);
        const pendingSigs = new Set(rq.map(failSig));
        // fix47: track failed signatures - dedup until skill code/contract changes (hash-based, no time window)
        const failedSigs = this.progress.failedRepairSigs || {};
        for (const b of bs) {
            const sig = failSig(b);
            const skill = this.skills.find(s => s.name === b.target);
            const currentHash = this._skillHash(skill);
            if (rq.some(x => x.target === b.target)) { console.log(`[psn] repair of ${b.target} already queued`); continue; }
            // fix47: loud deduplication if same skill + signature is re-queued while pending or already failed
            if (pendingSigs.has(sig)) { 
                console.log(`[psn] WARN: repair of ${b.target} with same failure signature already pending (dedup): ${sig.slice(0, 80)}`); 
                continue; 
            }
            // fix47: hash-based dedup - only skip if signature matches AND skill hasn't changed (same hash)
            const failedEntry = failedSigs[sig];
            if (failedEntry && failedEntry.hash === currentHash) {
                console.log(`[psn] WARN: repair of ${b.target} with same failure signature already failed (skill unchanged, dedup): ${sig.slice(0, 80)}`);
                continue;
            }
            rq.push({ ...b, task, trace: traceText(trace), peers: bs.map(x => x.target), sig }); console.log(`[psn] queued REPAIR of ${b.target} (${rq.length} in queue)`);
            pendingSigs.add(sig);
        }
        rq.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0)); this._repairQueue = rq;
        // fix35: prefetch embeddings for blamed skills (overlapped with next work; embeds are used by retrieveSkills when repair runs)
        this._prefetchBlamedEmbeds(rq);
    }
    // fix35: prefetch embeddings for blamed skills while other work runs (CPU-safe, overlaps with critic/code-model waits)
    _prefetchBlamedEmbeds(rq) {
        const skills = rq.map(q => this.skills.find(s => s.name === q.target)).filter(Boolean);
        if (!skills.length) return;
        const t0 = Date.now();
        console.log(`[overlap] prefetching embeds for ${skills.length} blamed skill(s): ${skills.map(s => s.name).join(', ')}`);
        Promise.all(skills.map(async s => { if (s.description) await this._embed(s.description); }))
            .then(() => console.log(`[overlap] blamed skill embed prefetch done in ${Date.now() - t0}ms`))
            .catch(e => console.log(`[overlap] blamed skill embed prefetch failed: ${e.message}`));
    }
    // targeted repair of the blamed skill via the code model, through the normal regression gate (saveSkill)
    // fix26: a skipped repair is deferred (persisted) and re-queued when ripe, not dropped; dropped loudly after 6 deferrals
    _deferRepair(q, ms, why) {
        const d = (this.progress.deferredRepairs ||= []), dc = (this.progress.deferCounts ||= {}), key = `${q.target}:${q.kind}`;   // fix27: counter per skill+kind, persisted
        q.defers = dc[key] = (dc[key] || 0) + 1;
        if (q.defers > 6) { console.log(`[psn] repair of ${q.target} [${q.kind}] DROPPED after ${q.defers - 1} deferrals (${why})`); delete dc[key]; this.progress.deferredRepairs = d.filter(x => !(x.target === q.target && x.kind === q.kind)); this._saveProgress(); return; }
        if (!d.some(x => x.target === q.target && x.kind === q.kind)) d.push({ ...q, notBefore: Date.now() + ms }); this._saveProgress();
        console.log(`[psn] repair of ${q.target} deferred ${Math.round(ms / 60e3)} min (${why}; deferral ${q.defers}/6)`);
    }
    _requeueDeferred() {
        const d = this.progress.deferredRepairs || []; if (!d.length) return;
        const ripe = d.filter(x => Date.now() >= x.notBefore);
        if (!ripe.length) return;
        this.progress.deferredRepairs = d.filter(x => !ripe.includes(x));
        const rq = [...(this._repairQueue || [])]; for (const x of ripe) if (!rq.some(y => y.target === x.target && y.kind === x.kind)) { delete x.notBefore; rq.push(x); console.log(`[psn] deferred repair of ${x.target} [${x.kind}] re-queued`); }
        this._repairQueue = rq;
    }
    // fix96: the single-skill repair prompt, built in one place
    _repairPrompt(q, e, pastLessons) {
        const awmHints = this.repairMemory.formatHintsForCoder(pastLessons);
        // fix40: unified bare-name API - all functions called by bare name (no skills.*/world.* prefix)
        // fix96: AVAILABLE FUNCTIONS are the skills the repaired code can call: the ones it calls now (its closure). Its
        //        callers were listed too (signature and description of every skill that calls it: up to 1.3k chars for
        //        ensureCraftingTable); calling one is a cycle (_cycleLint rejects it). They are named once, as callers.
        //        The closure was also listed a second time in the user message ("skills it uses"); it is listed once.
        const relevantSkills = new Set(this._closure(e.name));
        const callers = parentsOf(e.name, this._graph());
        const usedBuiltIn = builtInsCalled(getBareAPI().sigs, e.code);
        const apiList = this.unifiedAPIList(relevantSkills, usedBuiltIn);
        const system = `You repair ONE skill in a Minecraft mineflayer skill library (PSN-style targeted fix). Return a single \`\`\`javascript code block containing ONLY the fixed function, with the SAME name and a compatible signature. First line inside the block: // DESCRIPTION: <one sentence>. Every loop must check bot.interrupt_code. If something still cannot be done, log(bot, 'FAILED: <reason>') and return a falsy value; no silent fallbacks. findBlock/findBlocks/nearestEntity/bot.entities/blockAt results can be null or empty: always null-check them before reading .position/.x or calling methods on them. bot.findBlocks(options): matching is a block id, an array of block ids, or a function; maxDistance and count are finite numbers. bot.findBlock(options) returns one block and does not take count; pass matching and maxDistance. getNearestBlocks(bot, block_types, distance, count): block_types is a block name or an array of names (null lists every block id); distance and count are finite numbers and are required. A list of names is not a distance. getNearbyBlockTypes(bot) lists blocks the bot can see (loaded, inside the server view distance, a face open to air or another non-occluding block, confirmed by bot.world.raycast). It does not take a radius. Call AVAILABLE FUNCTIONS by name. Do not paste their source into this function. If this function is too large to fix as one piece, say so in the description and keep the body a composition of the listed skills.

AVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z) - do NOT use skills.* or world.* prefix):
${apiList}

IMPORTANT: All functions use bare names. Do NOT write skills.goToPosition - write goToPosition. Do NOT write world.getNearestBlock - write getNearestBlock.`;
        const user = `Blamed skill: ${e.name} (${q.kind === 'caller_fix' ? 'it calls the leaf ' + q.leaf + ' in a situation where the leaf cannot succeed: fix how/when it calls it, e.g. obtain the missing prerequisite first' : 'its own logic failed'})\nTask that failed: ${q.task}\nFailure path: ${q.path.join(' > ')}\nEvidence: ${q.evidence}\n--- execution trace (indent = call depth) ---\n${q.trace}\n${e.contract ? `--- learned contract of ${e.name} (must hold after your fix) ---\npre: ${e.contract.pre}\npost: ${e.contract.post}\n` : ''}--- current code of ${e.name} (${e.description}) ---\n${e.code}\n${callers.length ? `--- called by (keep the signature compatible) ---\n${callers.join(', ')}\n` : ''}${(e.repairHistory || []).length ? `\n--- your last ${e.repairHistory.length} repair proposal(s) for ${e.name} (do not repeat what failed) ---\n` + e.repairHistory.map((h, i) => `${i + 1}. [${h.outcome || 'pending'}] ${h.kind}: ${h.evidence}\n   change: ${h.desc}`).join('\n') : ''}${q.peers?.length > 1 ? `\nOther skills blamed on the same failure (repaired children-first): ${q.peers.join(', ')}` : ''}${awmHints ? `\n${awmHints}` : ''}\nWrite the fixed ${e.name}:`;
        const historyText = (e.repairHistory || []).map((h, i) => `${i + 1}. [${h.outcome || 'pending'}] ${h.kind}: ${h.evidence}\n   change: ${h.desc}`).join('\n');
        const sections = {
            system: system.length - apiList.length, api: apiList.length, evidence: String(q.evidence).length, trace: String(q.trace).length,
            code: e.code.length + e.description.length, callers: callers.join(', ').length, history: historyText.length,
            lessons: awmHints ? awmHints.length : 0,
        };
        return { system, user, sections };
    }
    async _repair() {
        const rq = [...(this._repairQueue || [])], q = rq.shift(); this._repairQueue = rq;
        if (!q) return false;
        const e = this.skills.find(s => s.name === q.target);
        if (!e) { console.log(`[psn] repair FAILED: blamed skill ${q.target} not in library`); return false; }
        this._repairs = (this.progress.repairs ||= {});   // fix11 (B8): repair cap persisted in progress.json
        if (q.kind === 'joint') return await this._repairJoint(q, e);
        if (q.kind === 'contract_fix') {   // fix25b: contract-only repair is independent of code candidates and the code-repair cap
            // fix45: if the skill has a seeded contract in SEEDED_PRIMITIVES, restore it instead of learning a new one
            // This prevents LLM-generated contracts from re-introducing material-tier hard-codes for equip skills
            const prim = Voyager.SEEDED_PRIMITIVES.find(p => p.name === e.name);
            if (prim?.contract) {
                console.log(`[psn] RESTORE seeded contract of ${e.name} (seeded contracts are immutable; ${q.evidence})`);
                e.contract = { ...prim.contract, seeded: true, restored: new Date().toISOString() };
                this._saveSkills();
                this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence, desc: `seeded contract restored: ${e.contract.text}`, outcome: 'seeded contract restored' });
                return true;
            }
            // fix87: practice can unshift the same evidence during the model call, before the rejection is recorded.
            //        That item is already off the "don't queue" check. Drop it here. Do not defer it (a deferral would
            //        run it again on a timer) and do not call the model again.
            if (this._sameContractRepairRejected(e, q.evidence)) {
                console.log(`!!! [contract] LOUD: contract repair of ${e.name} not run; this evidence was already rejected (${q.evidence})`);
                return false;
            }
            if (this._cursorLimited()) { console.log(`[psn] contract repair of ${e.name} deferred: code model at its limit`); this._deferRepair(q, 10 * 60e3, 'code model at its limit'); return false; }
            delete (this.progress.deferCounts || {})[`${e.name}:contract_fix`];
            console.log(`[psn] REPAIR contract of ${e.name} (${q.evidence})`);
            const n = await this._learnContracts([e], 'contract repair', q.evidence);
            const rejected = n === 0 && this._sameContractRepairRejected(e, q.evidence);
            this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence, desc: n ? `contract -> ${e.contract.text}` : (rejected ? 'same pre/post rejected' : 'contract repair failed'), outcome: n ? 'contract replaced' : (rejected ? 'rejected same contract' : 'failed') });
            return n > 0;
        }
        if (Date.now() - (this._repairs[e.name] || 0) < 30 * 60e3) { console.log(`[psn] repair of ${e.name} skipped: already repaired in the last 30 min (cap)`); this._deferRepair(q, Math.max(60e3, 30 * 60e3 - (Date.now() - (this._repairs[e.name] || 0))), 'already repaired in the last 30 min (cap)'); return false; }
        if (e.candidate) { console.log(`[psn] repair of ${e.name} skipped: a candidate is already under trial`); this._deferRepair(q, 10 * 60e3, 'a candidate is already under trial'); return false; }
        if (this._cursorLimited()) { console.log(`[psn] repair of ${e.name} skipped: code model at its limit`); this._deferRepair(q, 10 * 60e3, 'code model at its limit'); return false; }
        // fix71: the maturity gate protects a version whose record says it works. An API-lint failure is evidence that record
        // does not hold under the current API: the version cannot even be staged. Re-lint now (the API, the library or the
        // skill may have changed since it was queued); still broken -> the gate is not consulted; clean again -> no repair.
        if (q.apiLint) {
            const api = this._apiSignature(), lint = await this._apiLintOf(e);
            if (!lint) {
                console.log(`[api-lint] repair of ${e.name} dropped: it lints against the current API ${api} (queued under API ${q.apiLint.api})`);
                this.progress.apiLint = { api, clean: { ...(this.progress.apiLint?.api === api ? this.progress.apiLint.clean : {}), [e.name]: this._skillHash(e) } };
                this._saveProgress();
                return false;
            }
            q.evidence = apiLintEvidence(e.name, lint);
            const { V, n } = this._maturity(e);
            gateLog(`maturity ${e.name}: V=${V.toFixed(2)} (${n} runs) NOT CONSULTED: that record was earned by code that does not lint against the current API ${api} [repair after ${q.kind}]`);
        } else if (!this._updateAllowed(e, `repair after ${q.kind}`)) { console.log(`[psn] repair of ${e.name} skipped: maturity gate froze it`); return false; }
        this._repairs[e.name] = Date.now(); delete (this.progress.deferCounts || {})[`${e.name}:${q.kind}`]; this._saveProgress();   // fix27: counter resets when the repair actually runs
        // AWM-style: retrieve similar past repair lessons
        // fix96: a lesson that is one of this skill's own repair proposals is already in the prompt (repair history); it is
        //        shown once, there
        const pastLessons = (await this.repairMemory.retrieveSimilar(q.evidence, 3)).filter(r => !repairLessonInHistory(r, e));
        const { system, user, sections } = this._repairPrompt(q, e, pastLessons);
        console.log(`[psn] repair memory for ${e.name}: ${(e.repairHistory || []).length} past proposal(s) in the prompt${pastLessons.length ? `, ${pastLessons.length} AWM lesson(s)` : ''}`);
        console.log(`[psn] REPAIR ${e.name} [${q.kind}] with the code model (evidence: ${q.evidence.slice(0, LOG_EVIDENCE_CHARS)})`);
        let code, body, desc, extra = '';
        let _repairStaged = null;
        let accepted = false;
        let lastRejected = null;
        for (let att = 1; att <= 2; att++) {   // fix19 (3): one retry with the rejected candidate and its exact reason
            let reply;
            // fix96: what the repair prompt is made of (repair prompts reached 33k chars; nothing is cut now, so one that does
            //        not fit fails loudly and this line says which part grew)
            this._logPromptBreakdown('repair', { ...sections, retry: extra.length }, system.length + user.length + extra.length);
            try { reply = await this._ask(system, user + extra, this._inferMeta('repair', { system, user: user + extra })); } catch (err) { console.log(err instanceof Error && err.code === CONTEXT_FULL ? `!!! [psn] repair of ${e.name} does not fit the context (${err.message}). The skill is split into smaller skills instead of resending this prompt. num_ctx is not raised.` : `[psn] repair FAILED for ${e.name}: ${err.message}`); if (err instanceof Error && err.code === CONTEXT_FULL) { if (this._splitAlreadyFailed(e.name, e.code)) throw err; this._splitHint = e.name; this._splitDue = true; this._splitBecause = 'context'; } return false; }
            const ident = executableIdentity(t => this._hashReply(t), reply, extractCode);
            if (lastRejected) {
                const repeated = repeatedRejection(lastRejected, { n: att, candidate: ident.source, identity: ident.identity });
                if (repeated) {
                    console.log(`[duplicate] DETECTED in repair: reply #${att} repeated rejected candidate ${ident.identity}`);
                    return this._finishRepeatedRejection(e, q, repeated);
                }
            }
            code = extractCode(reply);
            const fn = code && code.match(/async\s+function\s+([A-Za-z_]\w*)\s*\(/);
            let err = null;
            if (!fn || fn[1] !== e.name) err = `reply did not define async function ${e.name}`;
            else {
                desc = ((code.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || e.description).trim();
                // fix82: the repaired code gets the same static gate as writeCode (parse, timers, every bot.<member> real on the
                //        live bot, every bare call defined) and the one-function shape. Repairs were only ESLint-staged: live
                //        18:27:59Z the craftItem repair read `bot.recipes.find(...)` (mineflayer has recipesFor/recipesAll, no
                //        bot.recipes), was HELD as a candidate, and both trials threw "Cannot read properties of undefined
                //        (reading 'find')" at the table (-125,43,61) inside obtainItem and craftIronPickaxe
                // fix83: the shape first, from a script parse (as writeCode): a repair that pastes a library skill beside its own
                //        function of the same name gets the one-function feedback, not only the module parse error
                // fix84: a failed script parse returns its error text (it used to return false and the text was thrown away)
                const scriptParse = parsesAsScript(code);
                const split = scriptParse === true ? splitGeneratedCode(code, e.name) : null;
                const shape = scriptParse !== true ? `does not parse as a script: ${scriptParse}` : (split.violations.length ? oneFunctionFeedback(e.name, split.violations, pastedLibrarySkills(code, e.name, new Set(this.skills.map(s => s.name)))) : null);
                body = split !== null ? split.skillSource : null;
                const markerGap = body !== null ? markerCallsMissing(e.code, body, PRECONDITION_UNMET_BINDING) : null;
                const gate = shape === null && !markerGap ? this.agent.coder.userGeneratedCodeLintBlockers(code, [...this.skills.map(s => s.name), ...markerGateNames(e.code, PRECONDITION_UNMET_BINDING)]) : null;
                if (shape !== null) err = `lint: ${shape}`;
                else if (markerGap) err = `lint: ${markerGap}`;
                else if (gate !== null) err = `lint: ${gate}`;
                else {
                    // fix49: check for dependency cycles BEFORE lint (feedback tells model which deps to avoid)
                    const cycleErr = this._cycleLint(e.name, body);
                    if (cycleErr) err = cycleErr;
                    else {
                        const repClosure = new Set([e.name, ...this._closure(e.name)]);
                        const repBundle = this._libSrcSubset(repClosure, { [e.name]: body }) + '\n\nawait Promise.resolve();';
                        const { lint, staged } = await this._stageLintExec(repBundle, repClosure, `voyager:repair:${e.name}`);
                        _repairStaged = staged;
                        if (lint) err = `lint: ${String(lint)}`;
                    }
                }
            }
            if (!err) { accepted = true; break; }
            console.log(`[psn] repair attempt ${att} FAILED for ${e.name}: ${String(err).slice(0, 300)}${att < 2 ? '; retrying with the error fed back' : ''}`);
            if (att === 2) {
                this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence, desc: `invalid code: ${String(err)}`, outcome: 'lint failed' });
                // AWM-style: record lint failure
                await this.repairMemory.recordRepair({ errorSignature: q.evidence, fixSnippet: `invalid code: ${String(err)}`, outcome: false, taskHint: q.task, skillName: e.name });
                return false;
            }
            const rejectedSource = typeof code === 'string' && code.length > 0 ? code : String(reply);
            lastRejected = { n: att, candidate: rejectedSource, reason: String(err), identity: this._hashReply(rejectedSource) };
            extra = repairRetrySuffix({ ...lastRejected, current: e.code });
        }
        if (!accepted) throw new Error(`[fix93] repair of ${e.name} ended without an accepted reply or a named failure`);
        this._lastEffects = e.effects;
        this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence, desc });
        const saved = await this.saveSkill(e.name, desc, body, `repair: ${q.task}`, { repair: true });
        if (!saved) {
            this._proposalOutcome(e, 'rejected at submit', q.sig); this._saveSkills();
            // AWM-style: record gate rejection
            await this.repairMemory.recordRepair({ errorSignature: q.evidence, fixSnippet: desc, outcome: false, taskHint: q.task, skillName: e.name });
            console.log(`[psn] repair of ${e.name} rejected by the gate`);
            return false;
        }
        // AWM-style: record successful repair submission
        await this.repairMemory.recordRepair({ errorSignature: q.evidence, fixSnippet: desc, outcome: true, taskHint: q.task, skillName: e.name });
        if (e.candidate) this._setTrialTask(e, q);   // fix28: dedicated trial run next step (fix79: only on a task it was routed to)
        console.log(`[psn] repaired ${e.name}: submitted to the gate (parents are re-validated once it is promoted)`);
        return true;
    }
    // fix93: one named failure. The rejected candidate is not saved and the signature is recorded,
    // so the same need is not repaired again and nothing is learned from the repeat.
    _finishRepeatedRejection(e, q, failure) {
        if (failure.name !== 'repeated-rejected-reply') throw new Error(`[fix93] unexpected repair failure ${failure.name}`);
        if (!Array.isArray(failure.attempts) || failure.attempts.length < 2) throw new Error('[fix93] a repeated rejection needs both attempts');
        if (typeof q.sig !== 'string' || q.sig.length === 0) throw new Error(`[fix93] repair of ${e.name} has no signature; cannot record ${failure.name}`);
        const evidence = failure.attempts.map(a => `attempt ${a.n} identity ${a.identity}: ${a.reason}${a.repeated === true ? ' REPEATED' : ''}`).join(' || ');
        console.log(`[psn] repair FAILED for ${e.name}: ${failure.name} (${evidence})`);
        this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence, desc: failure.name, outcome: failure.name });
        this._proposalOutcome(e, failure.name, q.sig);
        this._repairTerminal = { name: failure.name, skill: e.name, evidence, attempts: failure.attempts };
        return false;
    }

    // fix37 (C): improved extraction of function bodies from joint repair replies
    // Handles multiple formatting patterns the model might use: comments before/after, export keyword, whitespace variations
    _extractJointFunctions(code, childName, parentName) {
        const fns = {};
        if (!code) return fns;

        // Try multiple regex patterns to find the function definitions
        const patterns = [
            // Pattern 1: Standard async function with optional leading comments
            /(?:^|\n)((?:\s*\/\/[^\n]*\n)*)(\s*async\s+function\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{)/g,
            // Pattern 2: Export async function
            /(?:^|\n)((?:\s*\/\/[^\n]*\n)*)(\s*export\s+async\s+function\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{)/g,
            // Pattern 3: Async function without leading newline (start of code block)
            /^((?:\s*\/\/[^\n]*\n)*)(\s*async\s+function\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{)/g,
        ];

        const matches = [];
        for (const pattern of patterns) {
            let m;
            while ((m = pattern.exec(code)) !== null) {
                const name = m[3];
                const fullMatchStart = m.index;
                // Skip the leading newline if present
                const funcStart = code.indexOf(m[2], fullMatchStart);
                if (!matches.some(x => x.name === name)) {
                    matches.push({ name, start: funcStart, comments: m[1] || '' });
                }
            }
        }

        // Sort by position and extract function bodies
        matches.sort((a, b) => a.start - b.start);
        for (let i = 0; i < matches.length; i++) {
            const { name, start, comments } = matches[i];
            const end = i + 1 < matches.length ? matches[i + 1].start : code.length;
            // Extract the full function including any leading comments
            let funcCode = code.slice(start, end).trim();
            // If comments were before, prepend them
            if (comments.trim()) {
                funcCode = comments.trim() + '\n' + funcCode;
            }
            fns[name] = funcCode;
        }

        // Fallback: if we didn't find one of the expected functions, try a simpler approach
        // Look for the function name directly followed by opening paren
        for (const expected of [childName, parentName]) {
            if (fns[expected]) continue;

            const simpleRe = new RegExp(`async\\s+function\\s+${expected}\\s*\\([^)]*\\)\\s*\\{`, 'g');
            const match = simpleRe.exec(code);
            if (match) {
                const start = match.index;
                // Find the end by brace matching
                let braceCount = 0, inStr = false, strChar = null, end = start;
                for (let j = start; j < code.length; j++) {
                    const ch = code[j];
                    if (inStr) { if (ch === strChar && code[j - 1] !== '\\') inStr = false; }
                    else if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strChar = ch; }
                    else if (ch === '{') braceCount++;
                    else if (ch === '}') { braceCount--; if (braceCount === 0) { end = j + 1; break; } }
                }
                // Look for leading comments
                let commentStart = start;
                const lines = code.slice(0, start).split('\n');
                for (let k = lines.length - 1; k >= 0; k--) {
                    if (/^\s*\/\//.test(lines[k])) commentStart -= lines[k].length + 1;
                    else break;
                }
                fns[expected] = code.slice(Math.max(0, commentStart), end).trim();
            }
        }

        return fns;
    }

    // fix32 (PSN joint repair): parent and child rewritten in ONE code-model call; both go through the gate as candidates
    // tagged with one id, so a rejection of either rolls both back (same mechanism as refactors)
    async _repairJoint(q, e) {
        const pe = this.skills.find(s => s.name === q.parent);
        const single = (why, tgt, kind) => { console.log(`[psn] joint repair ${e.name}+${q.parent} -> single repair of ${tgt.name} (${why})`); this._repairQueue = [{ ...q, target: tgt.name, kind, parent: undefined }, ...(this._repairQueue || [])]; return false; };
        if (!pe) return single('caller not in library', e, 'callee_fix');
        if (this._cursorLimited()) { this._deferRepair(q, 10 * 60e3, 'code model at its limit'); return false; }
        if (e.candidate || pe.candidate) { this._deferRepair(q, 10 * 60e3, 'a candidate is already under trial'); return false; }
        const lastPairRepair = Math.max(this._repairs[e.name] || 0, this._repairs[pe.name] || 0);
        if (Date.now() - lastPairRepair < 30 * 60e3) { this._deferRepair(q, Math.max(60e3, 30 * 60e3 - (Date.now() - lastPairRepair)), 'one of the pair was repaired in the last 30 min'); return false; }
        const okKid = this._updateAllowed(e, 'joint repair (child)'), okPar = this._updateAllowed(pe, 'joint repair (caller)');
        if (!okKid && !okPar) { console.log(`[psn] joint repair ${e.name}+${pe.name} skipped: maturity gate froze both`); return false; }
        if (!okPar) return single('caller frozen by the maturity gate', e, 'callee_fix');
        if (!okKid) return single('child frozen by the maturity gate', pe, 'caller_fix');
        this._repairs[e.name] = this._repairs[pe.name] = Date.now(); this._saveProgress();
        // fix37 (C): improved prompt with clearer format instructions
        // fix38: add live state, skill library catalogue, contracts, and AWM hints
        const pastLessons = (await this.repairMemory.retrieveSimilar(q.evidence, 2)).filter(r => !repairLessonInHistory(r, e) && !repairLessonInHistory(r, pe));   // fix96: own proposals are in the history
        const awmHints = this.repairMemory.formatHintsForCoder(pastLessons);
        // fix96: the same scope as a single repair: the built-ins the two skills call (it listed EVERY built-in signature:
        //        joint system prompts reached 10-12k chars) and the skills they can call (their closures, without the pair);
        //        their callers are named once, not listed as callable
        const relevantSkills = new Set([...this._closure(e.name), ...this._closure(pe.name)].filter(n => n !== e.name && n !== pe.name));
        const jointBuiltIn = [...new Set([...builtInsCalled(getBareAPI().sigs, e.code), ...builtInsCalled(getBareAPI().sigs, pe.code)])];
        const jointApiList = this.unifiedAPIList(relevantSkills, jointBuiltIn);
        const jointCallers = [...new Set([...parentsOf(e.name, this._graph()), ...parentsOf(pe.name, this._graph())])].filter(n => n !== e.name && n !== pe.name);
        // fix40: unified bare-name API - all functions called by bare name
        const system = `You repair TWO skills of a Minecraft mineflayer skill library together (PSN joint repair): a child skill and the caller that uses it failed on the same path.

REQUIRED FORMAT: Return ONE \`\`\`javascript code block containing EXACTLY two async function definitions:
1. First: async function ${e.name}(bot) { ... }
2. Second: async function ${pe.name}(bot) { ... }

Each function must:
- Keep the SAME name (${e.name} and ${pe.name} respectively)
- Have a compatible signature
- Be preceded by // DESCRIPTION: <one sentence>

Every loop must check bot.interrupt_code. If something cannot be done, log(bot, 'FAILED: <reason>') and return a falsy value; no silent fallbacks. findBlock/findBlocks/nearestEntity/bot.entities/blockAt results can be null or empty: always null-check them. bot.findBlocks(options): matching is a block id, an array of block ids, or a function; maxDistance and count are finite numbers. bot.findBlock(options) returns one block and does not take count; pass matching and maxDistance. getNearestBlocks(bot, block_types, distance, count): block_types is a block name or an array of names (null lists every block id); distance and count are finite numbers and are required. A list of names is not a distance. getNearbyBlockTypes(bot) lists blocks the bot can see (loaded, inside the server view distance, a face open to air or another non-occluding block, confirmed by bot.world.raycast). It does not take a radius.
Fix the child's own logic and how/when the caller uses it. No top-level call, no extra functions.

AVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z) - do NOT use skills.* or world.* prefix):
${jointApiList}

IMPORTANT: All functions use bare names. Do NOT write skills.goToPosition - write goToPosition. Do NOT write world.getNearestBlock - write getNearestBlock.`;
        const jointState = this._stateText(this.observe());
        const user = `Task that failed: ${q.task}\nEvidence: ${q.evidence}\n--- current bot state ---\n${jointState}\n--- execution trace ---\n${extractFeedback(q.trace)}\n--- child ${e.name} ---\n${e.code}\n--- caller ${pe.name} ---\n${pe.code}${jointCallers.length ? `\n--- called by (keep the signatures compatible) ---\n${jointCallers.join(', ')}` : ''}${e.contract ? `\n--- contract of ${e.name} ---\npre: ${e.contract.pre}\npost: ${e.contract.post}` : ''}${pe.contract ? `\n--- contract of ${pe.name} ---\npre: ${pe.contract.pre}\npost: ${pe.contract.post}` : ''}${awmHints ? `\n${awmHints}` : ''}\nWrite both fixed functions (${e.name} first, then ${pe.name}):`;
        console.log(`[psn] REPAIR JOINT ${e.name} + ${pe.name} with the code model (evidence: ${String(q.evidence).slice(0, LOG_EVIDENCE_CHARS)})`);
        this._logPromptBreakdown('repair-joint', {
            system: system.length - jointApiList.length, api: jointApiList.length, evidence: String(q.evidence).length, state: jointState.length,
            trace: extractFeedback(q.trace).length, code: e.code.length + pe.code.length, callers: jointCallers.join(', ').length, lessons: awmHints ? awmHints.length : 0,
        }, system.length + user.length);
        let reply; try { reply = await this._ask(system, user, this._inferMeta('repair-joint', { system, user })); } catch (err) { console.log(`[psn] joint repair FAILED: ${err.message}`); return false; }

        // fix37 (C): improved extraction with better logging on failure
        const code = extractCode(reply) || '';
        const fns = this._extractJointFunctions(code, e.name, pe.name);

        if (!fns[e.name] || !fns[pe.name]) {
            // Log the raw reply (truncated) so we can see what came back
            const rawSnippet = String(reply);   // fix96: the whole reply, nothing cut
            console.log(`[psn] joint repair FAILED: reply did not define both ${e.name} and ${pe.name}`);
            console.log(`[psn] extracted functions: [${Object.keys(fns).join(', ')}], expected: [${e.name}, ${pe.name}]`);
            console.log(`[psn] raw model reply (for debugging):\n${rawSnippet}`);
            this._noteProposal(e, { task: q.task, kind: 'joint', evidence: String(q.evidence), desc: `joint reply incomplete (got [${Object.keys(fns).join(', ')}], needed [${e.name}, ${pe.name}])`, outcome: 'failed' });
            return false;
        }
        const strip = c => c.replace(/^\s*\/\/[^\n]*\n/gm, '').trim(), desc = (c, d) => ((c.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || d).trim();
        const jointSet = new Set(relevantSkills);
        const jointBundle = this._libSrcSubset(jointSet, { [e.name]: strip(fns[e.name]), [pe.name]: strip(fns[pe.name]) }) + '\n\nawait Promise.resolve();';
        const { lint } = await this._stageLintExec(jointBundle, jointSet, `voyager:joint-repair:${e.name}+${pe.name}`);
        if (lint) { console.log(`[psn] joint repair FAILED lint: ${String(lint).slice(0, 300)}`); return false; }
        const id = `jr${Date.now()}`;
        this.progress.refactors = { ...(this.progress.refactors || {}), [id]: { helper: null, skills: [e.name, pe.name], at: Date.now(), joint: true } }; this._saveProgress();
        // fix38: detailed logging when joint repair skills go through the gate
        for (const x of [e, pe]) {
            this._lastEffects = x.effects;
            this._noteProposal(x, { task: q.task, kind: 'joint', evidence: String(q.evidence), desc: `joint with ${x === e ? pe.name : e.name}` });
            console.log(`[psn] joint repair ${id}: submitting ${x.name} to gate (deps check, cycle check, regression rerun if past tasks exist)`);
            const saved = await this.saveSkill(x.name, desc(fns[x.name], x.description), strip(fns[x.name]), `repair: ${q.task}`, { repair: true, refactor: id });
            if (!saved) {
                // saveSkill logs the gate reason via gateLog; summarize the failure context here
                console.log(`[psn] joint repair ${id}: GATE REJECTED ${x.name}. Check gateLog above for specific reason (unknown skill calls, dependency cycle, or failed regression rerun). Rolling back the pair.`);
                this._rollbackRefactor(id, `${x.name} rejected at gate`);
                return false;
            }
        }
        if (pe.candidate) this._setTrialTask(pe, q);
        console.log(`[psn] joint repair ${id}: ${e.name} + ${pe.name} both passed gate checks and submitted as candidates (both rolled back if either fails trial runs)`);
        return true;
    }

    // fix79: a dedicated trial replays the repaired skill AS THE ROUTE of q.task, so it is set only when the skill was the root of
    //        the failed run (blame path starts at it). c3025b8 (fix28) set it to q.task for every repair, so a callee repaired
    //        from a caller's failure (scanForIronOreBlocks inside mineOneDiamondOre, path mineOneDiamondOre > scanForIronOreBlocks)
    //        was replayed alone on the caller's goal "Mine 1 diamond_ore" every 5 min. Its trials come from that caller instead.
    _setTrialTask(e, q) {
        if (!Array.isArray(q.path) || !q.path.length) throw new Error(`[fix79] repair record of ${e.name} has no blame path: ${JSON.stringify(q.path)}`);
        if (q.path[0] !== e.name) { gateLog(`no dedicated trial of ${e.name} on "${q.task}": it ran inside ${q.path[0]} (path ${q.path.join(' > ')}), not as the route of that task; its trials come from callers`); return; }
        e.candidate.trialTask = q.task; e.candidate.trialAfter = Date.now(); this._saveSkills();
    }
    // fix28: a repaired candidate gets its trial runs in a short dedicated run on the task that failed, instead of waiting for a caller
    async _gateTrial() {
        const e = this.skills.find(s => s.candidate?.trialTask && Date.now() >= (s.candidate.trialAfter || 0)); if (!e) return false;
        const c = e.candidate, task = c.trialTask.replace(/^repair:\s*/, '');
        const sig = (c.code.match(new RegExp(`async\\s+function\\s+${e.name}\\s*\\(([^)]*)\\)`)) || [])[1] || 'bot';
        const extra = sig.split(',').slice(1).map(x => x.trim()).filter(Boolean);
        if (extra.some(x => !x.includes('='))) { gateLog(`dedicated trial of ${e.name} not possible: required parameters (${extra.join(', ')}); its trials come from callers`); delete c.trialTask; this._saveSkills(); return false; }
        // fix79: the route of a dedicated trial is chosen from learned evidence: the candidate must be learned to produce the goal
        //        (the fix44 predicate _replay uses to decide whether the candidate runs at all)
        const g = this._resolveGoal(task);
        if (g.kind === 'item' && !this._candidateFitsGoal(e, g.items)) {
            gateLog(`LOUD: no dedicated trial of ${e.name} on "${task}": candidate learned effects [${c.effects.join(', ')}] (skill learned produces [${this._learnedProduces(e).join(', ')}]) do not include [${g.items.join(', ')}]; that route would run the incumbent and charge it the goal. Its trials come from callers`);
            delete c.trialTask; this._saveSkills(); return false;
        }
        c.trialAfter = Date.now() + 5 * 60e3; this._saveSkills();
        gateLog(`dedicated trial run of candidate ${e.name} on "${task}" (candidate ${c.stats.success}/${c.stats.success + c.stats.fail})`);
        const before = this.observe();
        const rp = await this._replay(task, before, { name: e.name, call: `await ${e.name}(bot);`, dedicatedTrial: true });
        if (rp?.interrupted) return true;
        if (!this.skills.find(s => s.name === e.name)?.candidate) gateLog(`candidate ${e.name} resolved after dedicated trial (${rp?.ok ? 'passed' : 'failed'})`);
        return true;
    }
    // fix20 (PSN refactoring with rollback): merge a code fragment repeated in 3+ skills into one new helper skill;
    // the rewritten skills enter the gate as candidates tagged with the refactor id. If any rewrite is rejected
    // (trial runs or regression rerun), every candidate of that refactor is rolled back.
    async _refactor() {
        const h = (this.sharedHints || [])[0];
        if (!h || this._cursorLimited()) return false;
        const P = this.progress; if (!this._refactorDue) return false;   // fix32: triggered by successes (see _afterSuccess)
        this._refactorDue = false; P.lastRefactor = Date.now(); this._saveProgress();
        const ents = h.skills.map(n => this.skills.find(s => s.name === n)).filter(e => e && !e.handwritten && !e.primitive && !e.candidate);
        if (ents.length < 2) { console.log(`[psn] refactor skipped: fragment shared by ${h.skills.join(', ')} but <2 learned skills without a pending candidate`); return false; }
        const id = `rf${Date.now()}`;
        // fix40: unified bare-name API
        const system = `You refactor a Minecraft mineflayer skill library (PSN canonical refactor: extract shared subroutine). Return ONE \`\`\`javascript block with: first a NEW helper async function (bot, ...params) that implements the repeated fragment, preceded by // DESCRIPTION: <one sentence>; then each listed skill rewritten to call the helper, SAME names and signatures, behaviour unchanged. Every loop checks bot.interrupt_code. No other functions.

AVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z) - do NOT use skills.* or world.* prefix):
${this.scopedAPIList(ents)}

IMPORTANT: All functions use bare names. Do NOT write skills.X or world.X - call functions directly by name.`;
        const user = `Repeated fragment:\n${h.fragment}\n${ents.map(e => `--- ${e.name} ---\n${e.code}`).join('\n')}\nWrite the helper then the rewritten skills:`;
        console.log(`[psn] REFACTOR ${id}: extracting the fragment shared by ${ents.map(e => e.name).join(', ')}`);
        let reply; try { reply = await this._ask(system, user, this._inferMeta('refactor', { system, user })); } catch (err) { console.log(`[psn] refactor FAILED: ${err.message}`); return false; }
        const code = extractCode(reply) || '';
        const fns = []; const re = /(?:^|\n)async\s+function\s+([A-Za-z_]\w*)\s*\(/g; let mm, idx = [];
        while ((mm = re.exec(code))) idx.push([mm[1], mm.index]);
        for (let i = 0; i < idx.length; i++) fns.push([idx[i][0], code.slice(idx[i][1], i + 1 < idx.length ? idx[i + 1][1] : code.length).trim()]);
        const helper = fns.find(([n]) => !this.skills.some(s => s.name === n));
        const rewrites = fns.filter(([n]) => ents.some(e => e.name === n));
        if (!helper || rewrites.length < 2) { console.log(`[psn] refactor ${id} FAILED: reply had ${helper ? 'a' : 'no'} new helper and ${rewrites.length} rewritten skill(s)`); return false; }
        const hdesc = ((code.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || `shared helper extracted from ${rewrites.map(r => r[0]).join(', ')}`).trim();
        const over = { [helper[0]]: helper[1] }; for (const [n, c] of rewrites) over[n] = c;
        const rfNames = new Set(Object.keys(over));
        for (const n of Object.keys(over)) for (const d of this._closure(n)) rfNames.add(d);
        const rfBundle = this._libSrcSubset(rfNames, over) + `\n\n${helper[1]}\n\nawait Promise.resolve();`;
        const { lint } = await this._stageLintExec(rfBundle, rfNames, `voyager:refactor:${id}`);
        if (lint) { console.log(`[psn] refactor ${id} FAILED lint: ${String(lint).slice(0, 300)}`); return false; }
        this._lastEffects = [];
        if (!(await this.saveSkill(helper[0], hdesc, helper[1], `refactor ${id}`))) { console.log(`[psn] refactor ${id} FAILED: helper rejected`); return false; }
        P.refactors = { ...(P.refactors || {}), [id]: { helper: helper[0], skills: rewrites.map(r => r[0]), at: Date.now() } }; this._saveProgress();
        for (const [n, c] of rewrites) { const e = this.skills.find(s => s.name === n); this._lastEffects = e.effects; await this.saveSkill(n, e.description, c, `refactor ${id}`, { refactor: id }); }
        console.log(`[psn] refactor ${id}: helper ${helper[0]} added; ${rewrites.length} rewritten skill(s) under verification (all rolled back if any is rejected)`);
        return true;
    }
    _rollbackRefactor(id, by) {
        const rf = this.progress.refactors?.[id]; let n = 0;
        for (const e of this.skills) if (e.candidate?.refactor === id) { delete e.candidate; n++; }
        for (const e of this.skills) if (e.refactorOf === id && e.prev) { Object.assign(e, { code: e.prev.code, description: e.prev.description, deps: e.prev.deps, stats: e.prev.stats }); writeAtomic(`${this.dir}/${e.name}.js`, `// ${e.description}\n${e.code}\n`); delete e.refactorOf; n++; }
        if (rf) { const h = this.skills.find(s => s.name === rf.helper); if (h && !this.skills.some(s => !s.mergedInto && (s.deps || []).includes(rf.helper))) h.demoted = true; rf.rolledBack = by; this._saveProgress(); }
        this._saveSkills(); gateLog(`ROLLBACK refactor ${id} (rejected: ${by}): ${n} rewritten skill(s) restored; helper ${rf?.helper || '?'} retired if unused`);
    }
    // fix34 (PSN prune): demote unused low-maturity skills; no code model call, just mark demoted
    async _prune() {
        if (!this._pruneDue || this._cursorLimited()) return false;
        this._pruneDue = false;
        const unused = this.skills.filter(s => !s.primitive && !s.handwritten && !s.demoted && !s.mergedInto && !s.candidate
            && this._maturity(s).V < 0.25 && (s.stats?.success || 0) + (s.stats?.fail || 0) >= 3
            && !this.skills.some(o => !o.demoted && !o.mergedInto && (o.deps || []).includes(s.name)));
        if (!unused.length) { console.log('[psn] prune skipped: no unused low-V skills'); return false; }
        let n = 0;
        for (const s of unused.slice(0, 3)) {
            s.demoted = true; s.prunedAt = Date.now(); n++;
            gateLog(`PRUNE ${s.name}: V=${this._maturity(s).V.toFixed(2)} unused by other skills`);
        }
        this._saveSkills();
        this._windowCheck(true);
        console.log(`[psn] PRUNE: ${n} low-V unused skill(s) demoted`);
        return n > 0;
    }
    // fix34 (PSN generalise): convert similar specific skills into one parameterized skill
    async _generalise() {
        if (!this._generaliseDue || this._cursorLimited()) return false;
        this._generaliseDue = false;
        const names = this._generaliseHint || [];
        const ents = names.map(n => this.skills.find(s => s.name === n)).filter(e => e && !e.handwritten && !e.primitive && !e.candidate && !e.demoted && !e.mergedInto);
        if (ents.length < 3) { console.log(`[psn] generalise skipped: <3 eligible skills from hint`); return false; }
        const id = `gn${Date.now()}`;
        // fix40: unified bare-name API
        const system = `You refactor a Minecraft mineflayer skill library (PSN generalise: combine similar specific skills into one parameterized skill). Return ONE \`\`\`javascript block with: first a NEW parameterized async function (bot, param) that generalises the common pattern, preceded by // DESCRIPTION: <one sentence>; then each listed skill rewritten as a thin wrapper calling the new function with the appropriate argument. Keep SAME names and signatures for wrappers. Every loop checks bot.interrupt_code.

AVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z) - do NOT use skills.* or world.* prefix):
${this.scopedAPIList(ents)}

IMPORTANT: All functions use bare names. Do NOT write skills.X or world.X - call functions directly by name.`;
        const user = `Similar skills to generalise:\n${ents.map(e => `--- ${e.name} ---\n${e.description}\n${e.code}`).join('\n')}\nWrite the parameterized helper then the wrapper skills:`;
        console.log(`[psn] GENERALISE ${id}: parameterising ${ents.map(e => e.name).join(', ')}`);
        let reply; try { reply = await this._ask(system, user, this._inferMeta('generalise', { system, user })); } catch (err) { console.log(`[psn] generalise FAILED: ${err.message}`); return false; }
        const code = extractCode(reply) || '';
        const fns = []; const re = /(?:^|\n)async\s+function\s+([A-Za-z_]\w*)\s*\(/g; let mm, idx = [];
        while ((mm = re.exec(code))) idx.push([mm[1], mm.index]);
        for (let i = 0; i < idx.length; i++) fns.push([idx[i][0], code.slice(idx[i][1], i + 1 < idx.length ? idx[i + 1][1] : code.length).trim()]);
        const helper = fns.find(([n]) => !this.skills.some(s => s.name === n));
        const wrappers = fns.filter(([n]) => ents.some(e => e.name === n));
        if (!helper || wrappers.length < 2) { console.log(`[psn] generalise ${id} FAILED: reply had ${helper ? 'a' : 'no'} new helper and ${wrappers.length} wrapper(s)`); return false; }
        const hdesc = ((code.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || `parameterized helper generalising ${wrappers.map(r => r[0]).join(', ')}`).trim();
        const over = { [helper[0]]: helper[1] }; for (const [n, c] of wrappers) over[n] = c;
        const gnNames = new Set(Object.keys(over));
        for (const n of Object.keys(over)) for (const d of this._closure(n)) gnNames.add(d);
        const gnBundle = this._libSrcSubset(gnNames, over) + `\n\n${helper[1]}\n\nawait Promise.resolve();`;
        const { lint } = await this._stageLintExec(gnBundle, gnNames, `voyager:generalise:${id}`);
        if (lint) { console.log(`[psn] generalise ${id} FAILED lint: ${String(lint).slice(0, 300)}`); return false; }
        this._lastEffects = [];
        if (!(await this.saveSkill(helper[0], hdesc, helper[1], `generalise ${id}`))) { console.log(`[psn] generalise ${id} FAILED: helper rejected`); return false; }
        this.progress.refactors = { ...(this.progress.refactors || {}), [id]: { helper: helper[0], skills: wrappers.map(r => r[0]), kind: 'generalise', at: Date.now() } }; this._saveProgress();
        for (const [n, c] of wrappers) { const e = this.skills.find(s => s.name === n); this._lastEffects = e.effects; await this.saveSkill(n, e.description, c, `generalise ${id}`, { refactor: id }); }
        console.log(`[psn] generalise ${id}: helper ${helper[0]} added; ${wrappers.length} wrapper(s) under verification`);
        return true;
    }
    // fix34 (PSN split): split large monolithic skills into sub-skills
    async _split() {
        if (!this._splitDue || this._cursorLimited()) return false;
        this._splitDue = false;
        const name = this._splitHint;
        const because = this._splitBecause;
        this._splitBecause = null;
        const e = this.skills.find(s => s.name === name && !s.demoted && !s.mergedInto && !s.candidate);
        // fix97: a repair that does not fit the context is split even when the skill is under 40 lines. The repair prompt
        // carries the trace and the history; the split prompt is the skill. The 40-line rule stays for the size detector.
        if (!e || (because !== 'context' && (e.code || '').split('\n').length <= 40)) { console.log(`[psn] split skipped: ${name} no longer qualifies`); return false; }
        if (this._splitAlreadyFailed(e.name, e.code)) { console.log(`[psn] split of ${e.name} already failed for this code; not repeating it`); return false; }
        const id = `sp${Date.now()}`;
        // fix40: unified bare-name API
        const system = `You refactor a Minecraft mineflayer skill library (PSN split: break a large skill into smaller reusable sub-skills). Return ONE \`\`\`javascript block with: first 2-3 NEW sub-skill async functions (bot) that each do one logical piece of the work, each preceded by // DESCRIPTION: <one sentence>; then the original skill rewritten to call those sub-skills. Keep the SAME name and signature for the original. Every loop checks bot.interrupt_code.

AVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z) - do NOT use skills.* or world.* prefix):
${this.scopedAPIList([e])}

IMPORTANT: All functions use bare names. Do NOT write skills.X or world.X - call functions directly by name.`;
        const user = `Large skill to split:\n--- ${e.name} ---\n${e.description}\n${e.code}\nWrite the sub-skills then the rewritten main skill:`;
        console.log(`[psn] SPLIT ${id}: breaking ${e.name} (${e.code.split('\n').length} lines) into sub-skills`);
        let reply; try { reply = await this._ask(system, user, this._inferMeta('split', { system, user })); } catch (err) { console.log(`[psn] split FAILED: ${err.message}`); this._recordSplitFailure(e.name, e.code, err.message); return false; }
        const code = extractCode(reply) || '';
        const fns = []; const re = /(?:^|\n)async\s+function\s+([A-Za-z_]\w*)\s*\(/g; let mm, idx = [];
        while ((mm = re.exec(code))) idx.push([mm[1], mm.index]);
        for (let i = 0; i < idx.length; i++) fns.push([idx[i][0], code.slice(idx[i][1], i + 1 < idx.length ? idx[i + 1][1] : code.length).trim()]);
        const subs = fns.filter(([n]) => !this.skills.some(s => s.name === n));
        const main = fns.find(([n]) => n === e.name);
        if (subs.length < 2 || !main) { console.log(`[psn] split ${id} FAILED: reply had ${subs.length} sub-skill(s) and ${main ? 'the' : 'no'} rewritten main`); this._recordSplitFailure(e.name, e.code, `reply had ${subs.length} sub-skill(s)`); return false; }
        const over = { [main[0]]: main[1] }; for (const [n, c] of subs) over[n] = c;
        const spNames = new Set(Object.keys(over));
        for (const n of Object.keys(over)) for (const d of this._closure(n)) spNames.add(d);
        const spBundle = this._libSrcSubset(spNames, over) + `\n\n${subs.map(s => s[1]).join('\n\n')}\n\nawait Promise.resolve();`;
        const { lint } = await this._stageLintExec(spBundle, spNames, `voyager:split:${id}`);
        if (lint) { console.log(`[psn] split ${id} FAILED lint: ${String(lint).slice(0, 300)}`); this._recordSplitFailure(e.name, e.code, String(lint)); return false; }
        for (const [n, c] of subs) {
            this._lastEffects = [];   // fix73: a new sub-skill has no run of its own yet (saveSkill takes the effects per call)
            const desc = ((c.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || `sub-skill of ${e.name}`).trim();
            if (!(await this.saveSkill(n, desc, c, `split ${id}`))) { console.log(`[psn] split ${id} FAILED: sub-skill ${n} rejected`); this._recordSplitFailure(e.name, e.code, `sub-skill ${n} rejected`); return false; }
        }
        this.progress.refactors = { ...(this.progress.refactors || {}), [id]: { main: e.name, subs: subs.map(s => s[0]), kind: 'split', at: Date.now() } }; this._saveProgress();
        this._lastEffects = e.effects;
        await this.saveSkill(e.name, e.description, main[1], `split ${id}`, { refactor: id });
        console.log(`[psn] split ${id}: ${subs.length} sub-skill(s) added; ${e.name} rewritten and under verification`);
        return true;
    }

    // SkillWeaver-style idle practice (https://arxiv.org/abs/2504.07079)
    // When idle with no pending tasks/repairs, propose a small practice goal from gaps/weak skills
    async _idlePractice() {
        const check = this.idlePractice.isReadyForPractice(
            !!(this._repairQueue?.length),
            !!(this.progress.subgoals?.length) || !!this._decomposeQueue
        );
        if (!check.ready) {
            if (check.reason !== 'not idle' && check.reason !== 'practice disabled') {
                console.log(`[idle-practice] not ready: ${check.reason}`);
            }
            return false;
        }

        const goal = this.idlePractice.proposePracticeGoal(
            this.skills,
            this.npGraph,
            this.progress.failed.slice(-10)
        );
        if (!goal) return false;

        console.log(`[idle-practice] STARTING practice: ${goal.goal}`);
        this.idlePractice.startPractice(goal);

        try {
            const before = this.observe();
            let ok = false;
            let skillLearned = null;

            if (goal.skill && goal.type !== 'producer_gap') {
                const entry = this.skills.find(s => s.name === goal.skill && !s.demoted);
                if (entry) {
                    const rp = await this._replay(entry.task || goal.goal, before, { name: entry.name, call: `await ${entry.name}(bot);` });
                    ok = !!rp?.ok;
                    if (ok) skillLearned = entry.name;
                }
            } else {
                const route = this._findReplay(goal.goal) || await this._embedReplay(goal.goal);
                if (route) {
                    const rp = await this._replay(goal.goal, before, route);
                    ok = !!rp?.ok;
                    if (ok) skillLearned = route.name;
                }
            }

            this.idlePractice.endPractice(ok, skillLearned);
            if (ok && skillLearned) {
                console.log(`[idle-practice] SUCCESS: practiced ${skillLearned}`);
                this._afterSuccess();
            }
            return true;
        } catch (e) {
            console.error(`[idle-practice] practice FAILED with error: ${e.message}`);
            try { this.idlePractice.endPractice(false, null); } catch (e2) { /* fail-loud already threw */ }
            return true;
        }
    }

    async step() {
        // The stall heartbeat is a setInterval, so it runs in the timers phase. Node's event loop is
        // timers, pending callbacks, poll (I/O), check (setImmediate), then close
        // (https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick/). A setImmediate scheduled
        // from a poll callback runs in that same iteration's check phase, after timers have already
        // been considered, so it does not give a due heartbeat a turn. The joined post-run tail and
        // hunger serve were the synchronous planner; the smelt index and the recipe and edge memos
        // are what remove that block.
        const now = Date.now(); console.log(`[timing] ${new Date().toISOString().slice(11,19)}Z step start (gap since last step end ${this._stepEnd ? now - this._stepEnd : 0}ms)`);   // fix27
        try { return await this._step(); } finally { this._flushSkills(); this._stepEnd = Date.now(); console.log(`[timing] ${new Date().toISOString().slice(11,19)}Z step end (took ${this._stepEnd - now}ms)`); }
    }
    // fix80: shared pursue path used by _step and by cold-start _serveUrgent (replay then generate-code).
    // Does not set currentTask — caller sets it (need:hunger for a need serve; the task string otherwise).
    async _pursueProposedTask(task, proposal, before) {
        this._prefetchPlan(task, before);   // fix28 (C): the next proposal is planned while this task runs
        VERSION = this.agent.bot.version;

        // fix37 (B): check if the goal is ALREADY SATISFIED before running anything (learned postcondition check)
        const alreadySatisfied = this._goalAlreadySatisfied(task, before);
        if (alreadySatisfied.satisfied) {
            console.log(`[voyager] goal already satisfied: ${task} (${alreadySatisfied.reason})`);
            this._markCompleted(task);
            this.progress.failed = this.progress.failed.filter(t => t !== task);
            // fix47: clear blockers for this task when it passes
            this.progress.blockers = (this.progress.blockers || []).filter(b => b.task !== task);
            this._recordGoalOutcome(task, true, null);  // fix49: backoff tracking
            this._saveProgress();
            this.agent.openChat?.(`Done: ${task} (already satisfied: ${alreadySatisfied.reason}).`);
            this._afterSuccess();
            return false;   // fix91: nothing ran; the caller may take the next queued subgoal
        }
        console.log(`[voyager] goal "${task}" not yet satisfied: ${alreadySatisfied.reason}`);

        // fix55: a skill goal runs exactly that skill (never a different skill whose task text matches)
        const goalKind = this._resolveGoal(task);
        // fix56: an open goal is routed only by identity/parsed routes or by the embedding match (nearest skill among all candidates AND above
        // the learned replay threshold); never by lexical word overlap, which picks unrelated well-rated skills
        let route;
        if (goalKind.kind === 'skill') {
            let call = `await ${goalKind.skill.name}(bot);`;
            if (goalKind.skill.name === 'tossClutter' && this._curSub && this._curSub.task === task && this._curSub.slotRequest) call = await this._tossClutterCall(this._curSub);
            route = { name: goalKind.skill.name, call };
        }
        else if (goalKind.kind === 'reach') {
            // fix86: a learned skill whose traced runs brought this block into nearby is the search. No surface or wood special case.
            const bringer = this._reachBringer(goalKind.item);
            route = bringer ? { name: bringer.name, call: `await ${bringer.name}(bot);` } : (this._findReplay(task) || await this._embedReplay(task));
        } else if (goalKind.kind === 'open') route = this._structuredReplay(task) || await this._embedReplay(task);
        else route = this._findReplay(task) || await this._embedReplay(task);   // fix28 (D): replay a matching learned skill before any code-model call
        let rp = route ? await this._replay(task, before, route) : null;
        if (route?.embed) this._learnReplayThreshold(rp);
        if (!rp?.ok && !rp?.interrupted) { const bc = await this._backchain(task, rp ? this.observe() : before, rp ? rp.needs : null); if (bc) rp = { ...bc, needs: rp ? rp.needs : null }; }   // fix32 PSN backward chaining (fix81: on the missing item too)
        if (rp?.interrupted) { console.log('[voyager] task interrupted'); return true; }
        if (rp?.ok) {
            this._noteEdgeOutcome(task, true);   // fix81
            this._markCompleted(task); this.progress.failed = this.progress.failed.filter(t => t !== task);
            // fix47: clear blockers for this task when it passes
            this.progress.blockers = (this.progress.blockers || []).filter(b => b.task !== task);
            this._noteGoalState(task, true, null, before);   // fix90
            this._recordGoalOutcome(task, true, null);  // fix49: backoff tracking
            this._saveProgress();
            this._subgoalDone(rp.name);
            this.agent.openChat?.(`Done: ${task} (replayed ${rp.name}).`);
            this._afterSuccess();
            return true;
        }
        if (rp && !rp.ok && !rp.interrupted && !rp.unmetPrecondition) {
            const why = typeof rp.reason === 'string' && rp.reason.length > 0 ? rp.reason : 'replay failed';
            this._noteGoalState(task, false, why, before);   // fix90: same-state posterior
            this._recordGoalOutcome(task, false, why);  // fix49: backoff tracking
            this.progress.failed.push(task); this._saveProgress(); this._windowCheck(false);
        }
        // fix81: the run said what it lacks: chain on that (subgoals) instead of writing new code for a goal that cannot pass yet
        // fix90: while a need serve is current, the chain belongs to that need (need:hunger), not the skill name.
        //        fix89 chained only in the raiser branch; a curriculum replay of the skill left the serve free to cold-start again.
        if (rp && !rp.ok && !rp.interrupted) this._noteEdgeOutcome(task, false);
        if (rp && !rp.ok && Array.isArray(rp.needs)) {
            const seen = this.observe();
            await this._judgeItems(seen, this._needItems(rp.needs), true);
            if (await this._withChosenSearches(seen, () => this._chainNeeds(this._chainOwner(task), rp.needs, seen))) return true;
        }
        // fix55: a skill goal is that skill; its failure is already blamed/queued for repair by _attribute, so no new code is written for it
        if (goalKind.kind === 'skill') { console.log(`[voyager] skill goal ${task} failed its learned post-contract; repair of the skill handles it (no code generation)`); return true; }
        if (this._cursorLimited()) {
            console.log(`[voyager] skipped "${task}": needs new code but Cursor is at its limit (replay-only mode)`);
            // fix91: a replay that already ran used the step. No route and no replay means nothing ran.
            if (rp === null) return false;
            return true;
        }
        this.agent.openChat?.(`New goal: ${task}`);
        // fix28 (B): the prompt carries only the skills nomic-embed-text ranks relevant, plus their dependency closures (all skills stay defined in scope)
        // fix47: use configurable skill_topk and api_topk from settings (no fallback - must be set)
        if (typeof settings.skill_topk !== 'number') {
            throw new Error('[fix47] FAIL LOUD: skill_topk must be set in settings.js (number)');
        }
        if (typeof settings.api_topk !== 'number') {
            throw new Error('[fix47] FAIL LOUD: api_topk must be set in settings.js (number)');
        }
        const skillTopK = settings.skill_topk;
        const apiTopK = settings.api_topk;
        const related = await this.retrieveSkills(task + ' ' + (proposal.context || ''), skillTopK);
        for (const n of (proposal.context || '').match(/\b[a-z][A-Za-z0-9]+\b/g) || []) { const e = this.skills.find(s => s.name === n && !s.demoted); if (e && !related.includes(e)) related.push(e); }
        const shown = new Set(related.map(s => s.name)); for (const s of related) for (const d of this._closure(s.name)) shown.add(d);
        const prompter = this.agent.prompter;
        
        // fix47: get relevant built-in API functions via embedding search + skill deps
        const relevantBuiltIn = await this._relevantBuiltInAPI(task + ' ' + (proposal.context || ''), apiTopK, shown);
        
        let system = voyagerCodingInstructions(prompter.profile.coding, this.agent.name);
        // fix40: unified bare-name API - all functions called by bare name
        // fix47: use relevantBuiltIn instead of full API list
        const apiList = this.unifiedAPIList(shown, relevantBuiltIn);
        system += `\n\nVOYAGER MODE: write ONE reusable async function \`async function camelCaseName(bot) {...}\` that completes the task, then call it at the end with \`await camelCaseName(bot);\`.
The first line of the code block must be a comment: // DESCRIPTION: <one sentence of what the function does>.
The state lists every item and the count held right now. Do not write one of those counts into a comparison, a default, or a comment. A count observed now is not a threshold. Read it with getInventoryCounts(bot) when the function runs.

AVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z) - do NOT use skills.* or world.* prefix):
${apiList}

IMPORTANT: All functions use bare names. Do NOT write skills.goToBlock or skills.goToPosition - write goToPosition(bot, x, y, z) directly. Do NOT write world.getNearestBlock - write getNearestBlock(bot, ...) directly.

COMPOSE: build your function out of these skills (they can take arguments). Your new skill may take extra parameters with defaults, e.g. \`async function makeIronTools(bot, count = 1)\`. Do not create call cycles between skills, and do not call a skill from inside itself with the same parameters.${this.sharedHints?.length ? `
SHARED CODE: these fragments are repeated in several skills; if you need this logic, put it in its own small reusable async function skill (named, with parameters) and call it, instead of inlining it again:
${this.sharedHints.map(h => '// used in ' + h.skills.join(', ') + '\n' + h.fragment).join('\n')}` : ''}
Interrupts: the bot may be interrupted at any time (danger, getting stuck, a player talking). Every loop must start with \`if (bot.interrupt_code) return;\` and you must return immediately after any await when bot.interrupt_code is true. Every async function must contain an await. Never catch an error and keep looping; no unbounded loops (always cap attempts). There is no setTimeout/setInterval in scope; to wait use \`await sleep(ms)\`. findBlock/findBlocks/nearestEntity/bot.entities/blockAt results can be null or empty: always null-check them before reading .position/.x or calling methods on them. bot.findBlocks(options): matching is a block id, an array of block ids, or a function; maxDistance and count are finite numbers. bot.findBlock(options) returns one block and does not take count; pass matching and maxDistance. getNearestBlocks(bot, block_types, distance, count): block_types is a block name or an array of names (null lists every block id); distance and count are finite numbers and are required. A list of names is not a distance. getNearbyBlockTypes(bot) lists blocks the bot can see (loaded, inside the server view distance, a face open to air or another non-occluding block, confirmed by bot.world.raycast). It does not take a radius.`;
        // only `related` are shown as context; the library is already in the execution scope, so its source is not copied into the prompt
        // fix97: the comment above said the library is already in scope and its source is not copied. The next line pasted
        // the top 3 bodies anyway, so each rewrite was trained on (and returned) a longer function. Signature, description
        // and contract only.
        const ctx = related.slice(0, 3).map(s => `${signatureOf(s.code, s.name)}: ${s.description}${s.contract ? ` | pre ${s.contract.pre} | post ${s.contract.post}` : ''}`).join('\n');

        // fix37 (D): include inventory-full fact from replay failure in feedback for code gen
        // fix38: use extractFeedback to preserve FAILED lines
        let feedback = rp?.cut ? codeRetryFeedback({ cut: rp.cut, output: String(rp.output || ''), trace: null, critique: `Replay of ${rp.name} failed`, invFull: rp.invFullFact || '', behaviorLog: '' }) : '';
        let lastCode = '', anyCut = rp?.cut || '', prevCrit = null, lastTrace = null, duplicateStuck = false;
        // fix37: duplicate-reply detection state
        let prevReplyHash = null, consecutiveDupes = 0;
        for (let i = 1; i <= MAX_ATTEMPTS; i++) {
            if (this.abort) { console.log('[voyager] aborted for player'); return true; }
            // fix37: escalating duplicate feedback (changes each time to nudge the model)
            const dupeEscalation = consecutiveDupes > 0 ? `\n\n!!! CRITICAL: Your previous ${consecutiveDupes} reply(ies) were IDENTICAL to the one before. You MUST write DIFFERENT code this time. The previous code did not work. Change your approach, use different skills, or try a simpler strategy. Repeating the same code will cause this task to fail. !!!` : '';
            // Counts stay in the state. snapshotThresholdFeedback rejects a comparison that copies one of them.
            const currentState = this.observe();
            this._promptCounts = currentState.inventory;
            const codeStateText = this._codeState(currentState);
            const user = `Task: ${task}\nHint: ${proposal.context || ''}\n${recipeFacts(task)}\n--- state ---\n${codeStateText}
--- learned skills you can call (already defined for your code: call them by name, never paste their source) ---\n${ctx || '(none)'}
${lastCode ? `--- your previous code ---\n${lastCode}\n` : ''}${feedback ? `--- feedback from last attempt ---\n${feedback}\n` : ''}${dupeEscalation}Attempt ${i}/${MAX_ATTEMPTS}. Write the code block:`;
            // fix47: per-prompt breakdown logging
            if (i === 1) {
                this._logPromptBreakdown('code', {
                    system: system.length - apiList.length,   // fix96: apiList is inside system; counted once, as prelude
                    skills: ctx.length,
                    prelude: apiList.length,
                    state: codeStateText.length,
                    task: task.length + (proposal.context || '').length,
                    retry: 0
                }, system.length + user.length);
                console.log(`[voyager] code prompt: ${shown.size} of ${this.skills.filter(s => !s.demoted).length} skills in the catalogue (relevant + deps), ${Math.min(3, related.length)} as signature and description; prompt ${system.length + user.length} chars`);
            } else {
                // Log retry prompt size breakdown
                this._logPromptBreakdown('code-retry', {
                    system: system.length - apiList.length,
                    skills: ctx.length,
                    prelude: apiList.length,
                    state: codeStateText.length,
                    history: lastCode.length,
                    retry: feedback.length + dupeEscalation.length
                }, system.length + user.length);
            }
            const reply = await this._ask(system, user, this._inferMeta(i === 1 ? 'compose' : 'compose-retry', { system, user }));
            // fix37: duplicate-reply detection - hash and compare to previous
            const replyHash = this._hashReply(reply);
            if (prevReplyHash !== null && replyHash === prevReplyHash) {
                consecutiveDupes++;
                console.log(`[duplicate] DETECTED: code model reply #${i} is identical to reply #${i - 1} (hash ${replyHash}, consecutive dupes: ${consecutiveDupes})`);
                if (consecutiveDupes >= 2) {
                    // fix86: returning here skipped the failure chain, so "reach oak_log" died on duplicate replies
                    //        and never decomposed or retried. The post-loop records the failure and continues.
                    console.error(`[duplicate] ABORT: 2 consecutive duplicate replies; task "${task}" failed (code model is stuck). Continuing to the failure chain.`);
                    duplicateStuck = true;
                    break;
                }
                // don't lint/exec, just reprompt with stronger feedback
                feedback = `ERROR: Your reply was IDENTICAL to your previous attempt. The code model returned the exact same response twice. This is not acceptable. You MUST change your approach.\n\nPrevious code that failed:\n${lastCode}\n\nDo NOT repeat this code. Try a completely different strategy.`;
                continue;
            }
            prevReplyHash = replyHash;
            consecutiveDupes = 0;
            const code = extractCode(reply);
            if (!code) { feedback = 'Error: no code block. Reply with a ```javascript``` code block.'; continue; }
            const fn = code.match(/async\s+function\s+([A-Za-z_]\w*)\s*\(/);
            if (!fn) { feedback = 'Error: code must define `async function name(bot)` and call it.'; lastCode = code; continue; }
            const desc = (code.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || task;
            const own = fn[1];
            const over = {}; for (const s of this.skills) if (s.candidate) over[s.name] = s.candidate.code;   // fix24: candidates get trial runs in every task
            // Staging uses dependency closure from what the NEW code actually calls — not the embedding "shown" catalogue (which unions many irrelevant skills and inflates SES/eval 86k+ chars).
            const libraryNames = new Set(this.skills.map(s => s.name));
            const directLearnedCalls = new Set(depsOf(code, own, libraryNames));
            const stageNameSet = new Set([own, ...directLearnedCalls]);
            for (const d of directLearnedCalls) for (const n of this._closure(d)) stageNameSet.add(n);
            // fix70: every name the generated code declares is defined by the code itself in this bundle (as `own` always was): a
            // library skill of the same name, reached through a dep's closure, is not staged next to it (one scope, one definition)
            const codeDeclares = declaredNames(code);
            const libSkills = this.skills.filter(s => stageNameSet.has(s.name) && s.name !== own && !codeDeclares.has(s.name));
            const libSrc = libSkills.map(s => over[s.name] ?? s.code).join('\n\n');
            const traced = Voyager._tracedSkillNamesForInstrument(this, stageNameSet, over);
            const execBundle = libSrc + (libSrc ? '\n\n' : '') + instrumentSrc(traced) + '\n\n' + code;
            console.log(`[staging] voyager:writeCode task="${task}" attempt=${i} bundle=${execBundle.length} chars closure_skills=${stageNameSet.size}`);
            // fix82: one top-level function (+ its call) before staging: a second top-level declaration is saved with the skill
            //        and becomes a hidden global of every later bundle (live 18:23:44Z checkIronPickaxe, see skill_graph)
            // fix83: the shape is read FIRST, from a script parse: a reply with a library skill pasted beside its own function of
            //        the same name is not module code, so the lint's parse error came first and this rule never ran (live 19:07:36)
            // fix84: a failed script parse is the lint the model sees, text and all (it used to be swallowed as false)
            const scriptParse = parsesAsScript(code);
            const split = scriptParse === true ? splitGeneratedCode(code, own) : null;
            let lint = scriptParse !== true ? `does not parse as a script: ${scriptParse}` : (split.violations.length ? oneFunctionFeedback(own, split.violations, pastedLibrarySkills(code, own, libraryNames)) : null);
            if (lint === null) lint = this.agent.coder.userGeneratedCodeLintBlockers(code, this.skills.map(s => s.name));
            if (lint === null && scriptParse === true) {
                const copiedCounts = Voyager.snapshotThresholdFeedback(code, currentState.inventory);
                if (copiedCounts.length) lint = copiedCounts.join('\n');
            }
            // fix85: the executed reply must call the new function. The saved skill source still has the call cut off.
            if (lint === null && !split.entry) lint = entryCallFeedback(own);
            if (lint === null) { const introduced = markerCallsMissing('', code, PRECONDITION_UNMET_BINDING); if (introduced) lint = introduced; }
            // fix88: the saved source is checked before it runs. A self-call or a cycle is lint feedback, and saveSkill rejects it again.
            if (lint === null) {
                const recur = installViolations({ name: own, code: split.skillSource, deps: this._candidateDeps(own, split.skillSource) }, this.skills);
                if (recur.length > 0) lint = this._installViolationText(recur);
            }
            let staged = null;
            if (!lint) {
                const { lint: lint2, staged: st } = await this._stageLintExecTraced(libSrc + (libSrc ? '\n\n' : '') + code, execBundle, stageNameSet, `voyager:writeCode:${task}:att${i}`);
                lint = lint2;
                staged = st;
            }
            if (!lint && !staged) throw new Error('[psn] staging of traced generated code failed');
            if (lint) { console.log('[voyager] lint failed: ' + String(lint)); feedback = 'Lint error:\n' + lint; lastCode = code; continue; }

            // fix70: this attempt's own window (see _replay): `before` is the task-start snapshot taken before the proposal, any
            //        replay/backchain, every code-model call (with idle practice running beside it) and the earlier attempts
            const runBefore = this.observe();
            this._runStart = Date.now();
            // fix78: the journal records every library skill this run can execute; for generated code that is exactly the staged
            //        closure (own + what it calls + their closures), the same set staging and tracing use above
            const closeJournal = this._openTrialJournal(Object.keys(over).filter(n => stageNameSet.has(n)), own, task, stageNameSet);
            let res;
            try {
                res = await this._run(`voyager:${task}`, async () => {
                    const bot = this._timedBotForSkillRun();
                        await staged.func.main(bot);
                }, 5);
            } finally { closeJournal(); }
            console.log(`[timing] game action attempt ${i} took ${Date.now() - this._runStart}ms`);   // fix23: measurement
            if (this.abort) { console.log('[voyager] task interrupted'); return true; }
            const cut = res.interrupted || this._diedInRun() || this._stalledInRun() ? this._interruptReason(res) : '';   // fix14: cut-off code counts as a failed attempt
            if (this._diedInRun()) this._noteDeath(this._diedInRun(), task);
            if (cut) anyCut = cut;
            if (cut) console.log(`[voyager] attempt ${i} ${cut}; counting as a failure`);
            const output = String(res.message || '') + (cut ? `\n${cut}` : '');
            const after = this.observe();
            const goal = countGoal(task);
            const gained = goal ? gainedFor(goal, before, after) : 0;
            const reachG = this._resolveGoal(task);   // fix83: a reach goal is verified by observation, never by the critic alone
            const reached = reachG.kind === 'reach' ? this._reachHolds(reachG, after) : null;
            const verdict = cut ? { success: false, critique: `the attempt was ${cut}; it did not finish`, reasoning: 'cut off (critic skipped)' }   // fix23: a cut-off run is already a failure
                : reached === true ? { success: true, critique: '', reasoning: `${reachG.item} observed nearby` }
                : reached === false ? await this.critique(task, before, after, output, false)
                : (goal && gained >= goal.count)
                ? { success: true, critique: '', reasoning: `inventory +${gained} ${goal.item}` }
                : await this.critique(task, before, after, output, goal ? false : undefined);   // count goal not met by inventory -> ground truth false
            if (goal && gained >= goal.count) console.log(`[voyager] verified from inventory (+${gained} ${goal.item}), critic skipped`);
            console.log(`[voyager] attempt ${i} critic: success=${verdict.success} ${verdict.critique || ''}`);
            // fix86: _attribute nulls bot.__psnTrace. The success workflow and the post-loop failure record read the snapshot.
            const attemptTrace = this.agent.bot.__psnTrace;
            if (!Array.isArray(attemptTrace)) throw new Error(`[fix86] attempt ${i} of "${task}" ran and left no __psnTrace`);
            lastTrace = attemptTrace;
            this._attribute(own, task, !!verdict.success, over, null);   // fix11 (B7); fix79: generated code is not a route
            if (this._repairQueue?.some(x => x.target === own)) { console.log(`[psn] blame lands on the generated ${own} itself; the critic feedback loop fixes it (no library repair)`); this._repairQueue = this._repairQueue.filter(x => x.target !== own); }
            const same = !verdict.success && i >= 2 && prevCrit !== null && String(verdict.critique || '').trim() === prevCrit; prevCrit = String(verdict.critique || '').trim();   // fix32
            const lastTry = i >= MAX_ATTEMPTS || same || (!verdict.success && /travel|underground|died/.test(cut) && i >= 2);   // fix23: repeated travel cut-offs -> stop at 2 and decompose; fix32: unchanged critique -> stop
            if (this._decomposeQueue?.task === task && !lastTry) this._decomposeQueue = null;   // still iterating; decomposition decided after the last attempt
            if (verdict.success) {
                // fix73: no cap of 8 (b2e2338); _learnEffects below unions the full observation into the same entry anyway
                this._lastEffects = Object.keys(after.inventory).filter(k => (after.inventory[k] || 0) > (runBefore.inventory[k] || 0));   // fix70: this attempt only
                const saved = await this.saveSkill(own, desc.trim(), split.skillSource, task);   // fix82: the call cut by AST position
                // fix88: a self-call or a cycle is not a learned skill. The violation goes back to the model; the task is not done.
                if (saved === false && typeof this._installRejection === 'string') {
                    console.error(`[voyager] ${own} rejected before it was saved:\n${this._installRejection}`);
                    feedback = this._installRejection;
                    lastCode = code;
                    continue;
                }
                this._markCompleted(task);
                this.progress.failed = this.progress.failed.filter(t => t !== task);
                // fix47: clear blockers for this task when it passes
                this.progress.blockers = (this.progress.blockers || []).filter(b => b.task !== task);
                this._recordGoalOutcome(task, true, null);  // fix49: backoff tracking
                this._saveProgress();
                this._subgoalDone(fn[1]);
                // fix44: pass goal items to filter learned effects and produces (denoise)
                const goalItems = goal?.items || (goal?.item ? [goal.item] : null);
                { const e = this.skills.find(s => s.name === fn[1]); if (e && !e.candidate) this._learnEffects(e, runBefore, after, goalItems); }
                // ADAM-style: record inventory delta for needs/produces learning (fix70: over this attempt's run only)
                this.npGraph.recordDelta(fn[1], runBefore.inventory, after.inventory, goalItems);
                // AWM-style: extract workflow from multi-step trace
                const trace = attemptTrace;
                if (Array.isArray(trace) && trace.length >= 2) {
                    const steps = collapseRepeats(trace.filter(t => !t.name.startsWith('skills.')).map(t => t.name));   // fix96: every step, repeats counted
                    if (steps.length >= 2) {
                        this.repairMemory.recordWorkflow({ steps, task, outcome: true });
                    }
                }
                this.agent.openChat?.(`Done: ${task}. Learned skill ${fn[1]}.`);
                this._afterSuccess();
                return true;
            }
            // fix37 (D): detect inventory-full when code gen fails
            const invFullFact = !verdict.success ? this._detectInventoryFullFailure(task, before, after, output) : null;
            if (invFullFact) console.log(`[voyager] attempt ${i} INVENTORY FULL DETECTED: ${invFullFact}`);

            feedback = codeRetryFeedback({ cut, output, trace: attemptTrace, critique: String(verdict.critique || ''), invFull: invFullFact, behaviorLog: this.agent.bot.modes.flushBehaviorLog() });
            lastCode = code;
            if (lastTry) { if (i < MAX_ATTEMPTS) console.log(`[voyager] stopping after attempt ${i}: ${same ? 'critique unchanged from the previous attempt' : `${cut} (travel/death cut-off)`}`); break; }
        }
        this._recordGoalOutcome(task, false, anyCut || `failed ${MAX_ATTEMPTS}x`);  // fix49: backoff tracking
        this.progress.failed.push(task);
        this._saveProgress(); this._windowCheck(false);
        console.log(`[voyager] task failed after ${MAX_ATTEMPTS} attempts: ${task}`);

        // SkillWeaver-style: record gap for idle practice
        this.idlePractice.recordGap(task, anyCut || `failed ${MAX_ATTEMPTS}x`);

        // fix37 (D): include inventory-full in decomposition reason if relevant
        const finalInvFull = this._detectInventoryFullFailure(task, before, this.observe(), '');
        const invFullReason = finalInvFull ? ` Inventory state: ${finalInvFull}` : '';

        // fix51: track per-goal::reason failures using learned (s+1)/(n+2) Laplace-smoothed rate
        // Key by normalized structured source: skill name (from trace) + failure kind (set by _interruptReason)
        if (anyCut) {
            // _lastCutKind is set by _interruptReason when a cut occurs
            if (!this._lastCutKind) throw new Error('anyCut set but _lastCutKind missing (structured failure kind not recorded)');
            const failKind = this._lastCutKind;
            // fix80: kind 'need' / 'threat' never feed skill or goal backoff
            if (isUnblamedInterruptKind(failKind)) {
                console.log(`[fix80] cut kind ${failKind}: not blamed on skill or goal backoff`);
                this._lastCutKind = null;
            } else {
            const trace = lastTrace;
            if (!Array.isArray(trace)) throw new Error(`[fix86] __psnTrace missing when recording failure of "${task}"`);
            const failingCalls = trace.filter(t => t.fail && !t.intr);
            // Only record backoff if there's a failing skill to attribute
            if (failingCalls.length > 0) {
                const failSkill = failingCalls[0].name;
                const reasonKey = `${task}::${failSkill}::${failKind}`;
                const goalStats = (this.progress.goalFailures ||= {});
                const gs = (goalStats[reasonKey] ||= { success: 0, fail: 0 });
                gs.fail++;
                gs.lastFail = Date.now();
                const rate = (gs.success + 1) / (gs.success + gs.fail + 2);  // Laplace-smoothed
                console.log(`[fix51] goal::reason "${reasonKey}" rate=${rate.toFixed(2)} (${gs.success}s/${gs.fail}f)`);
                gs.rate = rate;
            }
            this._lastCutKind = null;  // reset for next run
            }
        }
        this._saveProgress();

        // fix81: the last failed run's structured needs (reported marker, violated contract, game data) chain first
        if (!anyCut) {
            const bot = this.agent.bot, reported = peekPreconditionUnmet(bot);
            clearPreconditionUnmet(bot);
            const seen = this.observe();
            await this._judgeItems(seen, this._goalSourceItems(task), true);
            const needs = await this._withChosenSearches(seen, () => this._failureNeeds(task, reported, lastTrace, seen));
            if (needs !== null) await this._judgeItems(seen, this._needItems(needs), true);
            this._noteEdgeOutcome(task, false);
            if (needs !== null && await this._withChosenSearches(seen, () => this._chainNeeds(this._chainOwner(task), needs, seen))) return true;
        }
        // fix19 (1): failed twice (recently) or cut off -> decompose
        const fails = this.progress.failed.slice(-20).filter(t => t === task).length;
        if (fails >= 2 || anyCut || duplicateStuck || this._decomposeQueue?.task === task) { if (this._decomposeQueue?.task === task) this._decomposeQueue = null; await this._decompose(task, duplicateStuck ? 'duplicate replies' : (anyCut || `failed ${fails}x; last critic: ${String(feedback)}${invFullReason}`)); }
        else if (this._curSub?.parent) console.log(`[psn] subgoal "${task}" failed; moving on`);
        return true;
    }

    async _step() {
        this._checkHomeGround();   // fix27: perception upkeep (was called from the removed milestone planner)
        this._watchWindows();
        this._watchDimension();
        if (this.agent.bot.currentWindow) { const w = this.agent.bot.currentWindow; if (/CHOICE/.test(JSON.stringify(w.title))) { if (!this._choiceNoted) { this._choiceNoted = 1; console.log("[window] datapack dialog CHOICE (A Breach Happened multi_action dialog via ViaProxy) left open; not answering"); } } else console.log(`[window] STRAY ${w.type} id=${w.id} still open at step start (opened ${Math.round((Date.now() - (this._winOpenedAt || 0)) / 1000)}s ago); closing`); if (!/CHOICE/.test(JSON.stringify(w.title))) try { this.agent.bot.closeWindow(w); } catch (e) { console.log('[window] close failed: ' + e.message); } }
        this._oneshot();
        // fix18: no hard-coded survival/housekeeping policy; the curriculum proposes it and the PSN learns it
        this._requeueDeferred();   // fix26
        if (this._apiLinted !== this._apiSignature()) { this._apiLinted = this._apiSignature(); await this._queueApiLintRepairs(); }   // fix67
        if (this._repairQueue?.length) {
            const repaired = await this._repair();
            if (repaired === true) return;
            if (repaired !== false) throw new Error(`[fix91] _repair returned ${JSON.stringify(repaired)}; expected true or false`);
            if (this._repairTerminal) {
                const t = this._repairTerminal;
                this._repairTerminal = null;
                console.log(`[fix93] repair ${t.name} for ${t.skill}: ${t.evidence}`);
            } else console.log('[fix91] repair produced nothing; the step continues');
        }
        // fix80: one shared pre-emption slot (hunger now; fix77 threat later). After repairs, BEFORE decompose/subgoals
        // so a fresh decomposition cannot starve the need for a whole LLM call. Queues stay untouched (BT re-tick).
        // fix91: a serve that did not act returns false and the step continues to the queued subgoals.
        if (await this._serveUrgent()) return;
        if (this._decomposeQueue) {
            const dq = this._decomposeQueue; this._decomposeQueue = null;
            const decomposed = await this._decompose(dq.task, dq.reason);
            if (decomposed === true) return;
            if (decomposed !== false) throw new Error(`[fix91] _decompose returned ${JSON.stringify(decomposed)}; expected true or false`);
            console.log(`[fix91] decompose of "${dq.task}" produced nothing; the step continues`);
        }
        if (!this.progress.fix25) this._fix25Migrate();
        if (await this._gateTrial()) return;   // fix28
        if (await this._backfillContracts()) return;   // fix22
        if (await this._refactor()) return;
        if (await this._prune()) return;   // fix34
        if (await this._generalise()) return;   // fix34
        if (await this._split()) return;   // fix34
        if (await this._retention()) return;   // fix32
        // SkillWeaver-style: idle practice when no pending work (gated: idle, no repairs, no subgoals)
        if (await this._idlePractice()) return;
        const before = this.observe();
        this._curSub = null;
        const sub = this._nextSubgoal(before), ms = null, fromCurr = sub === null && ms === null;
        let proposal = sub || ms || await this._takePlan(before);
        let task;
        if (fromCurr) {
            // fix90: planner proposals are accepted or backed off in this state; the failure goes back into the next prompt
            const accepted = await this._acceptPlannerTask(proposal, before);
            if (accepted === null) return;
            proposal = accepted.proposal;
            task = accepted.task;
        } else {
            if (typeof proposal.task !== 'string' || proposal.task.trim().length === 0) throw new Error(`[fix91] taken subgoal has no task string: ${JSON.stringify(proposal)}`);
            task = proposal.task.trim();
            // fix91: _nextSubgoal already dropped invalid heads. A taken subgoal that still fails the gate is a bug,
            // and asking the planner here used to end the step while the rest of the queue sat there.
            const invalid = this._rejectTask(task, false);
            if (invalid !== null) throw new Error(`[fix91] queued subgoal "${task}" failed the task gate after it was taken: ${invalid}`);
        }
        console.log(`[voyager] new task: ${task} (${proposal.reasoning})`);
        this.currentTask = task;
        await this._pursueProposedTask(task, proposal, before);
    }
}

// fix42: SEEDED_PRIMITIVES as static property - single source of truth for seeded primitive names and bodies
// Used by both _migrateToBarenames (to derive seeded names) and _seedPrimitives (to seed/reheal)
Voyager.SEEDED_PRIMITIVES = [
    {
        name: 'travelTo',
        description: 'Travel long distances (hundreds of blocks) in short hops of up to 32 blocks, so chunks load and paths stay short. Returns true once within 4 blocks (horizontally) of the target.',
        task: 'travel to a distant location',
        // fix49: use GoalNearXZ (pathfinder goal with heuristic method), not Vec3 which lacks goal interface
        code: `async function travelTo(bot, x, y, z, maxHops = 120) {
    let fails = 0;
    for (let hop = 0; hop < maxHops; hop++) {
        if (bot.interrupt_code) return false;
        const p = bot.entity.position;
        const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
        if (d <= 4) { log(bot, \`Arrived near \${x}, \${y}, \${z}.\`); return true; }
        if (d <= 32) { if (await goToPosition(bot, x, y, z, 3)) continue; }
        const step = Math.min(32, d);
        const side = fails ? (fails % 2 ? 1 : -1) * 10 * fails : 0;
        const tx = Math.round(p.x + dx / d * step - dz / d * side), tz = Math.round(p.z + dz / d * step + dx / d * side);
        try { await goToGoal(bot, new GoalNearXZ(tx, tz, 3)); fails = 0; }
        catch (err) {
            if (bot.interrupt_code) return false;
            if (++fails >= 6) { log(bot, \`travelTo gave up at \${p.floored()} after 6 failed hops: \${err?.message}\`); return false; }
        }
    }
    log(bot, \`travelTo ran out of hops; still \${Math.round(Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z))} blocks away.\`);
    return false;
}`,
        deps: [],
    },
    {
        name: 'collectBlock',
        description: 'Collect blocks of the given type. Handles ore variants (iron->iron_ore, deepslate_iron_ore), equips proper tools, and picks up drops.',
        task: 'collect blocks or ores',
        // fix44: add exclude list for unreachable blocks; fail loud when no progress
        code: `async function collectBlock(bot, blockType, num = 1) {
    if (!blockType || typeof blockType !== 'string') { log(bot, 'collectBlock: invalid blockType'); return false; }
    let types = [blockType];
    if (['coal','diamond','emerald','iron','gold','lapis_lazuli','redstone'].includes(blockType)) types.push(blockType + '_ore');
    if (blockType.endsWith('ore')) types.push('deepslate_' + blockType);
    if (blockType === 'dirt') types.push('grass_block');
    if (blockType === 'cobblestone') types.push('stone');
    let collected = 0;
    const excluded = new Set();
    const posKey = p => \`\${Math.floor(p.x)},\${Math.floor(p.y)},\${Math.floor(p.z)}\`;
    for (let i = 0; i < num; i++) {
        if (bot.interrupt_code) break;
        // fix86: findBlocks calls the matcher on palette blocks (Block.fromStateId, position null) before a block is placed.
        //        A matching type with no position means the section is scanned. posKey runs only on a placed block.
        const found = getNearestBlocksWhere(bot, b => {
            if (!types.includes(b.name)) return false;
            if (b.position === null) return true;
            return !excluded.has(posKey(b.position));
        }, 64, 1);
        const block = found.length ? found[0] : null;
        if (!block) {
            if (excluded.size) log(bot, \`FAILED: no reachable \${blockType} nearby (\${excluded.size} unreachable block(s) excluded)\`);
            else log(bot, collected ? \`No more \${blockType} nearby.\` : \`No \${blockType} nearby.\`);
            // fix83: no source within reach is a structured need (as tossClutter's chest proximity): the learner chains "reach <block>"
            const sources = types.filter(t => Object.hasOwn(bot.registry.blocksByName, t));
            if (sources.length === 0) throw new Error(\`collectBlock: \${blockType} names no block in the game data (searched \${types.join(', ')})\`);
            for (const t of sources) {
                const blockDrops = bot.registry.blocksByName[t].drops;
                if (!Array.isArray(blockDrops)) throw new Error(\`collectBlock: \${t} has no drops list in the game data\`);
                if (!blockDrops.length) throw new Error(\`collectBlock: \${t} drops nothing in the game data; a reach need cannot obtain it\`);
            }
            __mcPreconditionUnmet__(bot, { need: sources.length === 1 ? { item: sources[0], count: num - collected, reason: 'reach' } : { anyOf: sources, count: num - collected, reason: 'reach' } });
            break;
        }
        await equipToolForBlock(bot, block);   // fix62: cheapest tool that works on this block (was mineflayer-tool equipForBlock: fastest dig = top tier)
        const itemId = bot.heldItem ? bot.heldItem.type : null;
        if (!block.canHarvest(itemId)) {
            if (!block.harvestTools) throw new Error(\`collectBlock: \${block.name} failed canHarvest but the game data lists no harvestTools (it drops by hand)\`);
            __mcPreconditionUnmet__(bot, { need: { anyOf: Object.keys(block.harvestTools).map(id => bot.registry.items[id].name), count: 1, reason: 'tool' } });
            log(bot, \`Don't have right tools to harvest \${blockType}.\`);
            return false;
        }
        // fix84: no free slot is the same kind of structured need as the reach marker above (a chest then chains through planks to logs)
        const drops = bot.registry.blocksByName[block.name].drops;
        if (!Array.isArray(drops)) throw new Error(\`collectBlock: \${block.name} has no drops list in the game data\`);
        if (drops.length) {
            const dropId = drops[0];
            const id = typeof dropId === 'number' ? dropId : dropId.drop.id;
            const dropItem = bot.registry.items[id];
            if (!dropItem) throw new Error(\`collectBlock: drop \${id} of \${block.name} is not an item\`);
            if (roomForItem(bot, dropItem.name) < 1) {
                __mcPreconditionUnmet__(bot, { need: { item: dropItem.name, count: num - collected, reason: 'slot' } });
                log(bot, \`PREREQUISITE FAILED: no free slot for \${dropItem.name}.\`);
                return false;
            }
        }
        const before = getInventoryCounts(bot);
        const startPos = bot.entity.position.clone();
        const targetDist = startPos.distanceTo(block.position);
        try {
            const reached = await goToPosition(bot, block.position.x, block.position.y, block.position.z, 4);
            const endPos = bot.entity.position;
            const movedToward = startPos.distanceTo(block.position) - endPos.distanceTo(block.position);
            if (!reached || (targetDist > 8 && movedToward < 2)) {
                excluded.add(posKey(block.position));
                log(bot, \`Cannot reach \${blockType} at \${posKey(block.position)} (moved \${movedToward.toFixed(1)} blocks toward it); trying another\`);
                continue;
            }
            await bot.dig(block, true);
            await pickupNearbyItems(bot);
        } catch (err) {
            excluded.add(posKey(block.position));
            log(bot, \`Failed to collect \${blockType} at \${posKey(block.position)}: \${err.message}; trying another\`);
            continue;
        }
        const after = getInventoryCounts(bot);
        if (Object.keys(after).some(k => (after[k] || 0) > (before[k] || 0))) collected++;
    }
    log(bot, \`Collected \${collected} \${blockType}.\`);
    return collected > 0;
}`,
        deps: ['pickupNearbyItems', 'equipToolForBlock'],
    },
    {
        name: 'craftRecipe',
        description: 'Craft an item using the crafting recipe. Places and retrieves crafting table if needed.',
        task: 'craft an item',
        // fix42: retry placing crafting_table at multiple cells (no same-cell reuse on failure)
        code: `async function craftRecipe(bot, itemName, num = 1) {
    if (!itemName) { log(bot, 'craftRecipe: no item specified'); return false; }
    const target = bot.registry.itemsByName[itemName];
    if (!target) { log(bot, \`craftRecipe: \${itemName} is not an item in this version\`); return false; }
    // fix81: recipesFor returns only what the inventory can make now, so [] was "No recipe for X or missing ingredients"
    //        ("No recipe for stick" x25 with 0 planks/logs). recipesAll (every recipe) tells the two apart; missing
    //        ingredients are a structured unmet precondition (the recipe closest to makeable) the planner backchains on.
    const unmakeable = () => {
        const all = bot.recipesAll(target.id, null, true);
        if (!all.length) { log(bot, \`No recipe for \${itemName}.\`); return false; }
        const inv = getInventoryCounts(bot);
        const shortOf = r => r.delta.filter(d => d.count < 0).map(d => {
            const name = bot.registry.items[d.id].name, have = Object.hasOwn(inv, name) ? inv[name] : 0;
            return { item: name, need: -d.count * num, have };
        }).filter(m => m.have < m.need);
        const units = ms => ms.reduce((t, m) => t + m.need - m.have, 0);
        const closest = all.map(r => ({ r, missing: shortOf(r) })).sort((a, b) => units(a.missing) - units(b.missing))[0];
        const missing = closest.missing;
        if (!missing.length) { log(bot, \`FAILED: craftRecipe(\${itemName}): no recipe is makeable now, yet every ingredient of the closest one is held\`); return false; }
        // fix86: num equal to the count already held is that total, not a shortfall of crafts. Reporting num * yield
        //        and then adding the held count turned a torch craft of 79 (79 already held) into Craft 316 torch.
        const haveOut = Object.hasOwn(inv, itemName) ? inv[itemName] : 0;
        if (haveOut === num) {
            log(bot, \`FAILED: craftRecipe(\${itemName}, \${num}): \${num} is already held. That count is the total on hand, not a shortfall of crafts.\`);
            return false;
        }
        // the need is the item itself: which ingredient variant to get (oak or birch planks ...) is the planner's choice
        __mcPreconditionUnmet__(bot, { need: { item: itemName, count: num * closest.r.result.count, reason: 'ingredients' }, missing });
        log(bot, \`Cannot craft \${itemName}: missing ingredients \${missing.map(m => \`\${m.item} (need \${m.need}, have \${m.have})\`).join(', ')}.\`);
        return false;
    };
    let recipes = bot.recipesFor(target.id, null, 1, null);
    let craftingTable = null, placedTable = false;
    if (!recipes.length) {
        recipes = bot.recipesFor(target.id, null, 1, true);
        if (!recipes.length) return unmakeable();
        craftingTable = getNearestBlock(bot, 'crafting_table', 16);
        if (!craftingTable) {
            // fix51: call ensureCraftingTable to get/craft/place a table (fail loud if can't)
            const ensured = await ensureCraftingTable(bot);
            if (!ensured) { log(bot, \`FAILED: craftRecipe(\${itemName}) needs a crafting table but ensureCraftingTable failed\`); return false; }
            craftingTable = getNearestBlock(bot, 'crafting_table', 16);
            if (!craftingTable) { log(bot, \`FAILED: ensureCraftingTable returned true but no table found\`); return false; }
            placedTable = true;
        }
        if (craftingTable) recipes = bot.recipesFor(target.id, null, 1, craftingTable);
    }
    if (!recipes.length) { if (placedTable) await collectBlock(bot, 'crafting_table', 1); return unmakeable(); }
    // fix60: walk to a spot that sees and reaches a face of the table (GoalLookAtBlock, game reach), not just near it
    if (craftingTable) {
        const reached = await goToReachBlock(bot, craftingTable);
        if (!reached) { log(bot, \`FAILED: craftRecipe(\${itemName}) no reachable spot with line of sight to crafting table at \${craftingTable.position}\`); if (placedTable) await collectBlock(bot, 'crafting_table', 1); return false; }
    }
    const before = getInventoryCounts(bot)[itemName] || 0;
    try { await bot.craft(recipes[0], Math.min(num, 64), craftingTable); }
    catch (err) { log(bot, \`FAILED: craftRecipe(\${itemName}) threw: \${err.message}\`); if (placedTable) await collectBlock(bot, 'crafting_table', 1); return false; }
    const after = getInventoryCounts(bot)[itemName] || 0;
    if (placedTable) await collectBlock(bot, 'crafting_table', 1);
    if (after > before) { log(bot, \`Crafted \${itemName}, now have \${after}.\`); return true; }
    log(bot, \`FAILED: Crafting \${itemName} produced no items.\`); return false;
}`,
        deps: ['placeBlock', 'collectBlock', 'ensureCraftingTable'],
    },
    {
        name: 'attackNearest',
        description: 'Attack the nearest mob of the given type. Equips best weapon and fights until the mob is dead or bot is interrupted.',
        task: 'attack a mob',
        code: `async function attackNearest(bot, mobType, kill = true) {
    if (!mobType) { log(bot, 'attackNearest: no mob type specified'); return false; }
    bot.modes.pause('cowardice');
    const waterMobs = ['drowned', 'cod', 'salmon', 'tropical_fish', 'squid'];
    if (waterMobs.includes(mobType)) bot.modes.pause('self_preservation');
    const mob = getNearbyEntities(bot, 24).find(e => e.name === mobType);
    if (!mob) { log(bot, \`Could not find any \${mobType} to attack.\`); return false; }
    const weapons = bot.inventory.items().filter(it => it.name.includes('sword') || (it.name.includes('axe') && !it.name.includes('pickaxe')));
    if (weapons.length) { weapons.sort((a, b) => (b.attackDamage || 0) - (a.attackDamage || 0)); await bot.equip(weapons[0], 'hand'); }
    if (!kill) {
        if (bot.entity.position.distanceTo(mob.position) > 5) await goToPosition(bot, mob.position.x, mob.position.y, mob.position.z, 2);
        await bot.attack(mob); return true;
    }
    bot.pvp.attack(mob);
    while (getNearbyEntities(bot, 24).includes(mob)) {
        await sleep(1000);
        if (bot.interrupt_code) { bot.pvp.stop(); return false; }
    }
    log(bot, \`Successfully killed \${mob.name}.\`);
    await pickupNearbyItems(bot);
    return true;
}`,
        deps: ['pickupNearbyItems'],
    },
    {
        name: 'placeBlock',
        description: 'Place a block at the given position. Finds an adjacent block to build off and handles common block types.',
        task: 'place a block',
        // fix42: added direct state verification after bot.placeBlock (fail loud if block not placed)
        code: `async function placeBlock(bot, blockType, x, y, z, placeOn = 'bottom') {
    if (!blockType) { log(bot, 'placeBlock: no block type specified'); return false; }
    const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const existing = bot.blockAt(target);
    if (existing && existing.name === blockType) { log(bot, \`\${blockType} already at \${target}.\`); return false; }
    const empty = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (existing && !empty.includes(existing.name)) {
        await breakBlockAt(bot, x, y, z);
        await sleep(200);
    }
    let itemName = blockType === 'redstone_wire' ? 'redstone' : blockType;
    let block = bot.inventory.findInventoryItem(itemName);
    if (!block) { log(bot, \`Don't have any \${itemName} to place.\`); return false; }
    const dirs = { top: [0,1,0], bottom: [0,-1,0], north: [0,0,-1], south: [0,0,1], east: [1,0,0], west: [-1,0,0] };
    const order = placeOn === 'side' ? ['north','south','east','west','bottom','top'] : [placeOn, 'bottom','top','north','south','east','west'];
    let buildOff = null, faceVec = null;
    for (const dir of order) {
        const d = dirs[dir]; if (!d) continue;
        const adj = bot.blockAt(target.offset(d[0], d[1], d[2]));
        if (adj && !empty.includes(adj.name)) { buildOff = adj; faceVec = new Vec3(-d[0], -d[1], -d[2]); break; }
    }
    if (!buildOff) { log(bot, \`Cannot place \${blockType}: no adjacent block to build off.\`); return false; }
    if (bot.entity.position.distanceTo(target) > 4) await goToPosition(bot, target.x, target.y, target.z, 3);
    await bot.equip(block, 'hand');
    await bot.lookAt(buildOff.position.offset(0.5, 0.5, 0.5));
    try { await bot.placeBlock(buildOff, faceVec); await sleep(300);
        const check = bot.blockAt(target);
        if (check && check.name === blockType) { log(bot, \`Placed \${blockType} at \${target}.\`); return true; }
        log(bot, \`FAILED: placeBlock returned but \${blockType} not at \${target} (found \${check?.name || 'null'})\`); return false;
    } catch (err) { log(bot, \`FAILED to place \${blockType}: \${err.message}\`); return false; }
}`,
        deps: ['breakBlockAt'],
    },
    {
        name: 'breakBlockAt',
        description: 'Break the block at the given position. Equips the best available tool from inventory (no crafting) and moves within range if needed.',
        task: 'break a block',
        // fix49: equips from inventory only (no crafting) to avoid dep cycles; obtaining a missing tool is the planner's job (harvestTools decompose)
        // fix62: the tool is chosen for THIS block by equipToolForBlock (cheapest tool that works), not the strongest of each type
        code: `async function breakBlockAt(bot, x, y, z) {
    if (x == null || y == null || z == null) { log(bot, 'breakBlockAt: invalid coordinates'); return false; }
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) { log(bot, \`breakBlockAt: blockAt(\${x}, \${y}, \${z}) returned null (unloaded chunk?)\`); return false; }
    if (block.name === 'air' || block.name === 'water' || block.name === 'lava') {
        log(bot, \`No solid block at \${x}, \${y}, \${z}.\`); return false;
    }
    if (!withinInteractionRange(bot, block.position)) {
        await goToPosition(bot, block.position.x, block.position.y, block.position.z, 4);
    }
    if (bot.game.gameMode !== 'creative') {
        await equipToolForBlock(bot, block);
        const itemId = bot.heldItem ? bot.heldItem.type : null;
        if (!block.canHarvest(itemId)) { log(bot, \`FAILED: Don't have right tools to break \${block.name}. Need one of: \${Object.keys(block.harvestTools || {}).map(id => bot.registry.items[id].name).join(', ') || 'any tool'}\`); return false; }
    }
    await bot.dig(block, true);
    log(bot, \`Broke \${block.name} at \${x.toFixed(1)}, \${y.toFixed(1)}, \${z.toFixed(1)}.\`);
    return true;
}`,
        deps: ['equipToolForBlock'],
    },
    {
        name: 'pickupNearbyItems',
        description: 'Pick up all nearby dropped items within 8 blocks. Waits for drops to settle first.',
        task: 'pick up items',
        code: `async function pickupNearbyItems(bot) {
    const distance = 8;
    const getNearestItem = () => bot.nearestEntity(e => e.name === 'item' && e.isValid && bot.entity.position.distanceTo(e.position) < distance);
    let nearestItem = getNearestItem();
    let pickedUp = 0;
    while (nearestItem) {
        // fix84: the drop names its item (prismarine-entity getDroppedItem); no room is a slot need, same marker as collectBlock
        if (typeof nearestItem.getDroppedItem !== 'function') throw new Error('pickupNearbyItems: dropped item entity has no getDroppedItem()');
        const dropped = nearestItem.getDroppedItem();
        if (dropped === null || typeof dropped !== 'object' || typeof dropped.name !== 'string' || !Number.isInteger(dropped.count) || dropped.count < 1) throw new Error('pickupNearbyItems: dropped entity has no item');
        if (roomForItem(bot, dropped.name) < 1) {
            __mcPreconditionUnmet__(bot, { need: { item: dropped.name, count: dropped.count, reason: 'slot' } });
            log(bot, \`PREREQUISITE FAILED: no free slot for \${dropped.count} \${dropped.name}.\`);
            return false;
        }
        let collected = false;
        const onCollect = (_who, entity) => { if (entity === nearestItem) collected = true; };
        bot.on('playerCollect', onCollect);
        if (typeof nearestItem.width !== 'number') throw new Error('pickupNearbyItems: dropped item has no width');
        const followRange = nearestItem.width;
        let reached;
        try { reached = await goToGoal(bot, new GoalFollow(nearestItem, followRange)); }
        finally { bot.removeListener('playerCollect', onCollect); }
        if (!reached && bot.interrupt_code) {
            log(bot, \`Picked up \${pickedUp} items before being interrupted.\`);
            return false;
        }
        if (!nearestItem.isValid || collected) {
            pickedUp++;
            nearestItem = getNearestItem();
            continue;
        }
        log(bot, 'No progress: dropped item is still on the ground and the inventory did not gain it.');
        return false;
    }
    log(bot, \`Picked up \${pickedUp} items.\`);
    return true;
}`,
        deps: [],
    },
    // fix38: seeded primitives for inventory management (freeing space)
    // These are basic building blocks; WHICH items and WHEN stay learned by the agent
    {
        name: 'depositToChest',
        description: 'Deposit items to a nearby chest to free inventory space. Parameters (which item, how many) are chosen by the agent.',
        task: 'deposit items to free inventory space',
        code: `async function depositToChest(bot, itemName, count = 64) {
    if (!itemName) { log(bot, 'FAILED: depositToChest requires an item name'); return false; }
    if (!bot.__knownChests) {
        log(bot, 'FAIL LOUD: bot.__knownChests not initialized (voyager._prepareTossSignals not called before depositToChest)');
        return false;
    }
    const item = bot.inventory.items().find(it => it.name === itemName);
    if (!item) { log(bot, \`[deposit] reject \${itemName}: not in inventory\`); return false; }
    const toDeposit = Math.min(count, item.count);
    const chestKeys = Object.keys(bot.__knownChests);
    if (chestKeys.length === 0) {
        const chestBlock = bot.registry.blocksByName.chest;
        if (!chestBlock) throw new Error('depositToChest: the game data has no chest block');
        __mcPreconditionUnmet__(bot, { need: { item: chestBlock.name, count: 1, reason: 'proximity' } });
        log(bot, \`[deposit] reject all chests: chestMemory empty (0 known positions); have \${toDeposit} \${itemName} to deposit\`);
        return false;
    }
    const botPos = bot.entity.position;
    const candidates = [];
    for (const key of chestKeys) {
        const parts = key.split(',');
        if (parts.length !== 3) { console.log(\`[deposit] reject \${key}: invalid memory key\`); continue; }
        const cx = Number(parts[0]), cy = Number(parts[1]), cz = Number(parts[2]);
        if (Number.isNaN(cx)) { console.log(\`[deposit] reject \${key}: non-numeric coordinates\`); continue; }
        const block = bot.blockAt(new Vec3(cx, cy, cz));
        if (!block) { console.log(\`[deposit] reject \${key}: blockAt null (chunk unloaded or position invalid)\`); continue; }
        candidates.push({ block, key, dist: Math.hypot(cx - botPos.x, cy - botPos.y, cz - botPos.z) });
    }
    candidates.sort((p, q) => p.dist - q.dist);
    for (const cand of candidates) {
        if (bot.entity.position.distanceTo(cand.block.position) > 4) {
            const reached = await goToPosition(bot, cand.block.position.x, cand.block.position.y, cand.block.position.z, 3);
            if (!reached) { console.log(\`[deposit] reject \${cand.key}: pathfinder could not reach\`); continue; }
        }
        let containerWindow;
        try { containerWindow = await bot.openContainer(cand.block); }
        catch (err) { console.log(\`[deposit] reject \${cand.key}: \${err.message}\`); continue; }
        try {
            const slot = bot.inventory.items().find(it => it.name === itemName);
            if (!slot) throw new Error(\`depositToChest: \${itemName} not in inventory after opening \${cand.key}\`);
            await containerWindow.deposit(slot.type, null, toDeposit);
            log(bot, \`[chest] Deposited \${toDeposit} \${itemName} to known chest at \${cand.key}.\`);
        } finally {
            containerWindow.close();
        }
        return true;
    }
    log(bot, \`[deposit] reject all \${chestKeys.length} known chest candidate(s): none opened\`);
    return false;
}`,
        deps: [],
    },
    {
        name: 'tossItem',
        description: 'Toss (drop) items from inventory to free space. Parameters (which item, how many) are chosen by the agent.',
        task: 'toss items to free inventory space',
        code: `async function tossItem(bot, itemName, count = 64) {
    if (!itemName) { log(bot, 'FAILED: tossItem requires an item name'); return false; }
    const item = bot.inventory.items().find(it => it.name === itemName);
    if (!item) { log(bot, \`Don't have any \${itemName} to toss.\`); return false; }
    const toToss = Math.min(count, item.count);
    await bot.toss(item.type, null, toToss);
    log(bot, \`[toss] Tossed \${toToss} \${itemName}.\`);
    return true;
}`,
        deps: [],
    },
    {
        // fix92: the caller passes the slot deficit and the whole-slot plan. Success is measured empty slots.
        name: 'tossClutter',
        description: 'Toss the whole-slot capacity plan passed by the caller. slotsNeeded is how many empty slots must be gained. Success is emptySlotCount increasing by at least that many, not an item count dropping.',
        task: 'toss clutter to free inventory space',
        code: `async function tossClutter(bot, slotsNeeded, plan) {
    if (!Number.isInteger(slotsNeeded) || slotsNeeded < 1) throw new Error('[fix92] tossClutter: slotsNeeded must be a positive integer, got ' + JSON.stringify(slotsNeeded));
    if (!Array.isArray(plan) || plan.length < 1) throw new Error('[fix92] tossClutter: plan must list removals, got ' + JSON.stringify(plan));
    const before = bot.inventory.emptySlotCount();
    if (!Number.isInteger(before) || before < 0) throw new Error('[fix92] tossClutter: emptySlotCount is not a non-negative integer');
    for (const row of plan) {
        if (bot.interrupt_code) return false;
        if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('[fix92] tossClutter: removal is not an object: ' + JSON.stringify(row));
        if (typeof row.item !== 'string' || !Number.isInteger(row.remove) || row.remove < 1) throw new Error('[fix92] tossClutter: removal needs item and a positive remove: ' + JSON.stringify(row));
        if (!Number.isInteger(row.keep) || row.keep < 0) throw new Error('[fix92] tossClutter: removal keep is not a non-negative integer: ' + JSON.stringify(row));
        const regItem = bot.registry.itemsByName[row.item];
        if (!regItem) throw new Error('[fix92] tossClutter: ' + row.item + ' is not an item in the game data');
        const stacks = [];
        for (const x of bot.inventory.items()) if (x.name === row.item) stacks.push(x);
        let held = 0;
        for (const x of stacks) held += x.count;
        if (held < row.remove + row.keep) throw new Error('[fix92] tossClutter: stale plan for ' + row.item + '; held ' + held + ', remove ' + row.remove + ', keep ' + row.keep);
        if (bot.currentWindow) {
            const win = bot.currentWindow;
            bot.closeWindow(win);
            await new Promise(resolve => {
                const onClose = (w) => {
                    if (w === win) { bot.off('windowClose', onClose); resolve(); return; }
                    if (w) return;
                    bot.off('windowClose', onClose);
                    resolve();
                };
                bot.on('windowClose', onClose);
            });
        }
        await bot.toss(stacks[0].type, null, row.remove);
    }
    const after = bot.inventory.emptySlotCount();
    if (!Number.isInteger(after) || after < 0) throw new Error('[fix92] tossClutter: emptySlotCount after the toss is not a non-negative integer');
    const actual = after - before;
    console.log('[slot] verified empty_before=' + before + ' empty_after=' + after + ' actual_freed=' + actual);
    if (actual < slotsNeeded) return false;
    return actual;
}`,
        deps: [],
        contract: {
            pre: 'c => c.pre.alive === true && Number.isInteger(c.args[0]) && c.args[0] > 0',
            post: 'c => c.post.free > c.pre.free',
            text: 'success is measured empty slots increasing, not an item-count drop',
        },
    },
    // fix43/47: ensureCraftingTable with multi-cell retry AND inline 2x2 crafting (no craftRecipe dep)
    // Generic: for each missing ingredient, find a 2x2 recipe from recipesAll and craft it
    // NO hard-coded item names, ratios, or patterns - all derived from mineflayer recipe data
    {
        name: 'ensureCraftingTable',
        description: 'Ensure a crafting table is placed nearby for 3x3 recipes. If not in inventory, crafts one inline (2x2, no table needed). For missing ingredients, finds and crafts from available recipes. Uses multi-cell retry. Returns true if a table is available.',
        task: 'ensure a crafting table is placed nearby',
        code: `async function ensureCraftingTable(bot) {
    let table = getNearestBlock(bot, 'crafting_table', 16);
    if (table) { log(bot, \`Crafting table already nearby at \${table.position}.\`); return true; }
    let hasTable = (getInventoryCounts(bot)['crafting_table'] || 0) > 0;
    
    if (!hasTable) {
        console.log('[ensureCraftingTable] no crafting_table in inventory, attempting inline 2x2 craft...');
        const tableId = bot.registry.itemsByName['crafting_table']?.id;
        if (!tableId) { log(bot, 'FAILED: ensureCraftingTable - crafting_table not in registry'); return false; }
        
        let recipes = bot.recipesFor(tableId, null, 1, null);
        const allRecipes = bot.recipesAll(tableId, null, null);
        if (!allRecipes.length) { log(bot, 'FAILED: ensureCraftingTable - no recipe for crafting_table in registry'); return false; }
        let inv = getInventoryCounts(bot);
        let canCraft = false;
        
        // Try to craft with current inventory
        for (const recipe of recipes) {
            const ingredients = recipe.delta?.filter(d => d.count < 0) || [];
            const haveAll = ingredients.every(ing => {
                const ingItem = bot.registry.items[ing.id];
                return ingItem && (inv[ingItem.name] || 0) >= Math.abs(ing.count);
            });
            if (haveAll) {
                try {
                    const beforeCount = (getInventoryCounts(bot)['crafting_table'] || 0);
                    await bot.craft(recipe, 1, null);
                    const afterCount = (getInventoryCounts(bot)['crafting_table'] || 0);
                    if (afterCount > beforeCount) {
                        log(bot, 'Crafted crafting_table (2x2, inline).');
                        hasTable = true;
                        canCraft = true;
                        break;
                    }
                } catch (e) {
                    console.log(\`[ensureCraftingTable] inline craft failed: \${e.message}\`);
                }
            }
        }
        
        // fix96: every crafting_table recipe is considered (the game data has one per plank type). This used to read only
        //        allRecipes[0], the oak_planks one, so a bot holding stripped_cherry_wood (4 cherry_planks, a table) was told it
        //        "needs 4 more oak_planks but cannot craft it (no 2x2 recipe ...)" and went looking for oak logs underground.
        if (!canCraft && !hasTable) {
            const held = name => (Object.hasOwn(inv, name) ? inv[name] : 0);
            const variants = [];
            for (const tableRecipe of allRecipes) {
                if (!Array.isArray(tableRecipe.delta)) { log(bot, 'FAILED: ensureCraftingTable - a crafting_table recipe has no delta'); return false; }
                const short = [];
                for (const ing of tableRecipe.delta.filter(d => d.count < 0)) {
                    const ingItem = bot.registry.items[ing.id];
                    if (!ingItem) { log(bot, \`FAILED: ensureCraftingTable - recipe ingredient id \${ing.id} is not an item\`); return false; }
                    const need = -ing.count;
                    if (held(ingItem.name) < need) short.push({ item: ingItem, need, count: need - held(ingItem.name) });
                }
                // a shortfall is covered when one of its own recipes (2x2: no table) runs on what is held now
                const steps = [], uncovered = [];
                for (const sh of short) {
                    let found = null;
                    for (const r of bot.recipesAll(sh.item.id, null, null)) {
                        if (!r.result || typeof r.result.count !== 'number') { log(bot, \`FAILED: ensureCraftingTable - recipe for \${sh.item.name} has no result.count\`); return false; }
                        const times = Math.ceil(sh.count / r.result.count);
                        const subs = r.delta.filter(d => d.count < 0).map(d => ({ item: bot.registry.items[d.id], count: -d.count * times }));
                        if (subs.every(x => x.item && held(x.item.name) >= x.count)) { found = { r, times }; break; }
                    }
                    if (found) steps.push({ sh, ...found });
                    else uncovered.push(sh);
                }
                variants.push({ short, steps, uncovered });
            }
            const workable = variants.find(v => v.uncovered.length === 0);
            if (!workable) {
                // every variant lacks something no held item makes. When each lacks exactly one ingredient, any one of them
                // will do (one of the plank types): the need is anyOf, counted as the recipe's amount of one member.
                const single = variants.every(v => v.uncovered.length === 1);
                const counts = [...new Set(variants.map(v => (single ? v.uncovered[0].need : null)))];
                const need = single && counts.length === 1
                    ? { anyOf: [...new Set(variants.map(v => v.uncovered[0].item.name))], count: counts[0], reason: 'ingredients' }
                    : { item: variants[0].uncovered[0].item.name, count: variants[0].uncovered[0].count, reason: 'ingredients' };
                __mcPreconditionUnmet__(bot, { need });
                const named = Object.hasOwn(need, 'anyOf') ? \`\${need.count} of one of \${need.anyOf.join(', ')}\` : \`\${need.count} \${need.item}\`;
                log(bot, \`PREREQUISITE FAILED: ensureCraftingTable needs \${named}: none of the \${variants.length} crafting_table recipes can be made from the inventory (each lacks an ingredient whose own recipes need items not held). Decompose to obtain it first.\`);
                return false;
            }
            for (const st of workable.steps) {
                console.log(\`[ensureCraftingTable] crafting \${st.times}x \${st.sh.item.name} (produces \${st.r.result.count} each)...\`);
                await bot.craft(st.r, st.times, null);
            }
            inv = getInventoryCounts(bot);
            recipes = tableId ? bot.recipesFor(tableId, null, 1, null) : [];
            for (const recipe of recipes) {
                const beforeCount = (getInventoryCounts(bot)['crafting_table'] || 0);
                await bot.craft(recipe, 1, null);
                const afterCount = (getInventoryCounts(bot)['crafting_table'] || 0);
                if (afterCount > beforeCount) {
                    log(bot, 'Crafted crafting_table (2x2, inline after crafting ingredients).');
                    hasTable = true;
                    canCraft = true;
                    break;
                }
            }
            if (!canCraft) {
                log(bot, \`FAILED: ensureCraftingTable - crafted \${workable.steps.map(st => st.sh.item.name).join(', ')} but no crafting_table recipe is craftable from the inventory now (\${JSON.stringify(getInventoryCounts(bot))})\`);
                return false;
            }
        }
    }
    
    // fix25: multi-cell retry pattern
    const freeSpaces = getAllFreeSpaces(bot, 1, 6, 5);
    if (!freeSpaces.length) { log(bot, 'FAILED: ensureCraftingTable - no free space within 6 blocks to place crafting_table'); return false; }
    let placed = false;
    const tried = [];
    for (const pos of freeSpaces) {
        if (bot.interrupt_code) return false;
        tried.push(\`(\${Math.floor(pos.x)},\${Math.floor(pos.y)},\${Math.floor(pos.z)})\`);
        const ok = await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
        const check = bot.blockAt(pos.floored ? pos.floored() : pos);
        if (ok && check && check.name === 'crafting_table') {
            log(bot, \`Placed crafting_table at \${tried[tried.length - 1]}.\`);
            placed = true;
            break;
        }
        if (!ok) console.log(\`[ensureCraftingTable] placeBlock failed at \${tried[tried.length - 1]}, trying next cell...\`);
        else console.log(\`[ensureCraftingTable] placeBlock returned true at \${tried[tried.length - 1]} but block is \${check?.name || 'null'}, trying next cell...\`);
    }
    if (!placed) {
        log(bot, \`FAILED: ensureCraftingTable - could not place crafting_table at any of \${tried.length} free space(s): \${tried.join(', ')}\`);
        return false;
    }
    return true;
}`,
        deps: ['placeBlock'],
    },
    // fix44: equipBestTool with eq-based contract (idempotent: already-equipped = success)
    // fix62: "best" (ported from ODYSSEY equipPickaxe/equipSword: equip the strongest before a fight/dig) is now ranked from game data
    // (blocks it can harvest, dig-speed multiplier, max durability) instead of a hand-written tier list. Same contract.
    {
        name: 'equipBestTool',
        description: 'Equip the best tool of toolType (pickaxe, axe, sword, shovel, hoe) in the inventory; returns the item name or null.',
        task: 'equip a tool',
        code: `async function equipBestTool(bot, toolType = 'pickaxe') {
    const reg = bot.registry;
    const harvests = id => reg.blocksArray.filter(b => b.harvestTools && b.harvestTools[id]).length;
    const speed = id => Math.max(...Object.values(reg.materials).map(m => m[id] || 0));
    const cands = bot.inventory.items().filter(it => it.name.endsWith('_' + toolType));
    if (!cands.length) return null;
    const key = it => [harvests(it.type), speed(it.type), reg.items[it.type].maxDurability];
    cands.sort((a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i]; return 0; });
    await bot.equip(cands[0], 'hand');
    return cands[0].name;
}`,
        deps: [],
        // fix44/45: contract uses c.post.eq.heldItem NOT c.delta - idempotent (already-equipped = success)
        // fix45: explicit false when eq missing but ret non-null (fail loud, don't return undefined)
        contract: {
            pre: 'c => true',
            post: 'c => c.ret === null || (c.post.eq ? c.post.eq.heldItem === c.ret : false)',
            text: 'returns null (no tool) or the equipped tool name matches c.post.eq.heldItem',
        },
    },
    // fix62: per-block tool choice. Picks the CHEAPEST inventory item that works on this block, all from game data + live inventory:
    //   works       - block.harvestTools has it (required to get the drop) or, when nothing is required, its material speeds it up
    //   capability  - how many registry blocks the item is required for or speeds up; spending a more capable tool on this block
    //                 wears capability the block does not need (an iron_pickaxe on iron_ore when a stone_pickaxe also harvests it)
    //   wear cost   - its recipe ingredients weighted by inventory scarcity 1/(1+have), per point of max durability (uncraftable: Infinity)
    //   remaining   - durability left (item.durabilityUsed); among equals the more worn one is used up first
    // With nothing that works and nothing required, the hand is emptied so an unrelated tool is not worn (2 points per dig).
    {
        name: 'equipToolForBlock',
        description: 'Equip the cheapest inventory tool that can harvest (or speeds up) the given block; returns the item name, or null when the hand is used.',
        task: 'equip the cheapest tool for a block',
        code: skills.equipToolForBlock.toString(),   // fix62: one source of truth, the library function (bot + log only, so it runs bare in the sandbox)
        deps: [],
        contract: {
            pre: 'c => c.args.length >= 1 && c.args[0] === null',
            post: 'c => c.ret === null || (c.post.eq ? c.post.eq.heldItem === c.ret : false)',
            text: 'a placed block was passed (objects are null in c.args); returns null (hand) or the equipped tool name matches c.post.eq.heldItem',
        },
    },
];
