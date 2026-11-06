import { wordOverlapScore } from '../utils/text.js';
import settings from '../../settings.js';
// Voyager-style lifelong learning loop (after MineDojo/Voyager):
// automatic curriculum -> iterative code generation with env feedback -> self-verification critic -> skill library.
// Learning upgrades (Mo-approved):
//   - ADAM-style needs/produces graph (https://arxiv.org/abs/2410.22194)
//   - AWM repair/workflow memory (https://arxiv.org/abs/2409.07429)
//   - SkillWeaver-style idle practice (https://arxiv.org/abs/2504.07079)
import { AsyncLocalStorage } from 'async_hooks';
import * as acorn from 'acorn';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync, statSync, copyFileSync, truncateSync, appendFileSync, readdirSync } from 'fs';
import { NeedsProducesGraph } from './needs_produces.js';
import { RepairMemory } from './repair_memory.js';
import { IdlePractice } from './idle_practice.js';
import { VitalsModel } from './vitals_model.js';   // fix58
import { SlotEffects } from './slot_effects.js';   // fix59
// fix14: crash-safe writes (tmp file + rename)
export function writeAtomic(fp, text) { const tmp = `${fp}.tmp-${process.pid}`; writeFileSync(tmp, text); renameSync(tmp, fp); }
import * as world from './library/world.js';
import * as skills from './library/skills.js';
import { makeCompartment } from './library/lockdown.js';
import { getAllItems, getAllBlocks, getItemCraftingRecipes, isHostile, isDatapackHostile } from '../utils/mcdata.js';
import { cosineSimilarity } from '../utils/math.js';
import minecraftData from 'minecraft-data';
import { Ollama } from '../models/ollama.js';
import { signatureOf, depsOf, missingCalls, findCycle, findAllCycles, newStats, recordRun, rate, gateLog, instrumentSrc, annotateTrace, traceText, blame, blameAll, parentsOf } from './skill_graph.js';
import { getBareAPI, collectBareApiUsedInSource } from './coder.js';   // fix40: unified bare-name API helper
import { withStallPhase } from '../utils/event_loop_guard.js';
import { wrapBotForApiTiming } from '../utils/bot_api_timing.js';
import { logPromptBreakdown, extractBareCalls } from './prompt_utils.js';   // fix47: shared prompt utilities
const LOCAL = { model: 'qwen3:4b-instruct-2507-q4_K_M', url: 'http://192.168.1.215:11434', params: { format: 'json', options: { num_ctx: 8192, num_predict: 512 } } };   // fix38: raised from 150 to 512 - short JSON replies still need room for reasoning; truncation fails loudly (fix31)
export const CALLS = { local: 0, code: 0, replay: 0 };

globalThis.__psnALS ||= new AsyncLocalStorage();   // fix11 (B6): call-parent tracking for PSN traces

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
export function extractFeedback(output, maxChars = 1800) {
    const text = String(output || '');
    const lines = text.split('\n');
    const failedLines = lines.filter(l => /FAILED|CONDITION violated|ERROR|threw error/i.test(l));
    const nonFailedLines = lines.filter(l => !/FAILED|CONDITION violated|ERROR|threw error/i.test(l));
    if (failedLines.length === 0) {
        return text.slice(-maxChars);
    }
    const failedSection = '--- FAILED/ERROR LINES ---\n' + failedLines.slice(0, 20).join('\n');
    const remainingBudget = maxChars - failedSection.length - 60;
    if (remainingBudget <= 0) {
        return failedSection.slice(0, maxChars);
    }
    const headN = Math.floor(remainingBudget / 3 / 80);
    const tailN = Math.floor(remainingBudget * 2 / 3 / 80);
    const head = nonFailedLines.slice(0, Math.max(3, headN));
    const tail = nonFailedLines.slice(-Math.max(10, tailN));
    const headTail = head.length + tail.length >= nonFailedLines.length
        ? nonFailedLines
        : [...head, '... (middle truncated) ...', ...tail];
    const result = failedSection + '\n--- HEAD+TAIL ---\n' + headTail.join('\n');
    if (failedLines.length > 0 && result.trim().length < 50) {
        throw new Error('[feedback] LOUD FAIL: failures occurred but feedback is nearly empty - this is a bug');
    }
    return result.slice(0, maxChars);
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
function recipeFacts(text) {
    const ids = [...new Set((String(text).toLowerCase().match(/\b[a-z]+(?:_[a-z]+)*\b/g) || []))];
    const out = [];
    for (let id of ids) {
        if (id.endsWith('es') && id !== 'glasses') { const t = id === 'torches' ? 'torch' : id.slice(0, -1); if (getItemCraftingRecipes(t)) id = t; }
        else if (id.endsWith('s') && getItemCraftingRecipes(id.slice(0, -1))) id = id.slice(0, -1);
        let rs = null; try { rs = getItemCraftingRecipes(id); } catch (e) {}
        if (!rs?.length) continue;
        const forms = [...new Set(rs.map(([ing, r]) => Object.entries(ing).map(([k, v]) => `${v} ${k}`).join(' + ') + ` -> ${r.craftedCount} ${id}`))];
        // collapse wood variants: any *_planks/_log works
        const generic = forms.some(f => /oak_planks|oak_log/.test(f)) ? ' (any wood type works: birch/spruce/oak... planks are interchangeable)' : '';
        out.push(`${id}: ${forms.slice(0, 3).join(' | ')}${forms.length > 3 ? ` | ...${forms.length - 3} more` : ''}${generic}`);
        if (out.length >= 6) break;
    }
    return out.length ? 'RECIPES (from minecraft-data, authoritative):\n' + out.join('\n') : '';
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

function countGoal(task) {
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

// fix49: parse "ensure X" goals - places a block/item nearby (furnace, crafting_table, chest, etc.)
// The goal item must be placed, not just in inventory - so satisfaction requires the item to exist as a block nearby
// Uses observed state (findBlock) to check satisfaction, not skill name patterns
function ensureGoal(task) {
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

// "Smelt 6 raw_iron into 6 iron_ingot" -> verify by output gained
function smeltGoal(task) {
    const m = task.match(/^(?:smelt|cook)\s+(\d+)\s+([a-z_]+)\s+into\s+(\d+)\s+([a-z_]+)/i);
    return m ? { count: parseInt(m[1]), input: m[2].toLowerCase(), verb: 'smelt', item: m[4].toLowerCase(), items: [m[4].toLowerCase()] } : null;
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
export class Voyager {
    constructor(agent) {
        this.agent = agent;
        this.dir = `./bots/${agent.name}/skills`;
        mkdirSync(this.dir, { recursive: true });
        this.indexFile = `${this.dir}/index.json`;
        this.progressFile = `${this.dir}/progress.json`;
        this.skills = existsSync(this.indexFile) ? JSON.parse(readFileSync(this.indexFile, 'utf8')) : [];
        // fix49: ensure every skill has effects/consumes/stats (older skill files may not have them)
        for (const s of this.skills) {
            if (!s.effects) s.effects = [];
            if (!s.consumes) s.consumes = {};
            if (!s.stats) s.stats = newStats();
        }
        this.progress = existsSync(this.progressFile) ? JSON.parse(readFileSync(this.progressFile, 'utf8'))
            : { completed: [], failed: [], enabled: true, goalStats: {} };
        // fix49: ensure goalStats exists (older progress files may not have it)
        if (!this.progress.goalStats) this.progress.goalStats = {};
        // fix58: learned vitals relations (food level -> hp regen, skill -> food/hp change), persisted with progress
        if (!this.progress.vitals) this.progress.vitals = { regen: {}, runs: {} };
        this.vitals = new VitalsModel(this.progress.vitals);
        // fix59: learned per-skill inventory-slot effect (replaces the fix39 free-space name regex/list)
        if (!this.progress.slots) this.progress.slots = { runs: {} };
        this.slotEffects = new SlotEffects(this.progress.slots);
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
        if (!globalThis.__logRotate) { globalThis.__logRotate = setInterval(() => rotateLog('./logs/mindcraft.log', 25e6, 3), 60e3); rotateLog('./logs/mindcraft.log', 25e6, 3); }   // fix28
        this._migrateToBarenames();  // fix40: one-time migration from skills.*/world.* to bare names
        this._seedPrimitives();
        this._relink();
        this._polyMerge();
        this._extractShared();
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
            return nodes.slice().sort();
        }
        return out;
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
        }
        // fix47: comprehensive cycle check over ALL skills (seeded + stored)
        // Detect self-recursion (skill calls itself) and mutual recursion (A->B->A)
        const selfRecursive = [];
        for (const s of this.skills) {
            if (!s.code) continue;
            // hotfix: only flag an unconditional self-forward (calls itself with its own params unchanged, inside its own body)
            // - bounded recursion with different args (obtainItem(bot, smelt[x], need)) and top-level invocations are not loops
            const fnMatch = s.code.match(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/);
            if (!fnMatch) continue;
            const fnName = fnMatch[1];
            const params = fnMatch[2].split(',').map(p => p.split('=')[0].trim()).filter(Boolean);
            let bi = fnMatch.index + fnMatch[0].length, depth = 1; const bstart = bi;
            while (bi < s.code.length && depth) { const ch = s.code[bi]; if (ch === '{') depth++; else if (ch === '}') depth--; bi++; }
            const body = s.code.slice(bstart, bi - 1);
            let callsItself = false;
            for (const m of body.matchAll(new RegExp(`(?<![.\\w])${fnName}\\s*\\(([^)]*)\\)`, 'g'))) {
                const args = m[1].split(',').map(a => a.trim()).filter(Boolean);
                if (args.length === params.length && args.every((a, k) => a === params[k])) { callsItself = true; break; }
            }
            if (callsItself) {
                selfRecursive.push(s.name);
            }
        }
        if (selfRecursive.length > 0) {
            const msg = `[psn] SELF-RECURSION DETECTED in ${selfRecursive.length} skill(s): ${selfRecursive.join(', ')} - these will cause stack overflow at runtime`;
            console.error(msg);
            throw new Error(msg);
        }
        // Check for mutual recursion cycles in the dependency graph
        const graph = this._graph();
        const allCycles = findAllCycles(graph);
        if (allCycles.length > 0) {
            // fix51: one-time data migration - demote promoted skills that create cycles back to prev/handwritten_original
            let demoted = 0;
            for (const cycle of allCycles) {
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
                const graphAfter = this._graph();
                const cyclesAfter = findAllCycles(graphAfter);
                if (cyclesAfter.length === 0) {
                    console.log(`[fix51] demoted ${demoted} skill(s), cycles resolved`);
                } else {
                    const cycleStrs = cyclesAfter.map(c => c.join(' -> ')).join('; ');
                    const msg = `[psn] DEPENDENCY CYCLES PERSIST after demoting ${demoted} skill(s): ${cycleStrs}`;
                    console.error(msg);
                    throw new Error(msg);
                }
            } else {
                const cycleStrs = allCycles.map(c => c.join(' -> ')).join('; ');
                const msg = `[psn] DEPENDENCY CYCLES DETECTED: ${cycleStrs}`;
                console.error(msg);
                throw new Error(msg);
            }
        }
        // Original per-skill cycle check (kept for completeness)
        for (const s of this.skills) { const c = findCycle(s.name, s.deps, this._graph(s.name)); if (c) throw new Error(`[psn] relink: dependency cycle ${c.join(' -> ')}`); }
        console.log(`[psn] relink: ${this.skills.length} skills, ${n} edge set(s) changed`);
        if (n) this._saveSkills();
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
    _noteProposal(e, p) { e.repairHistory = [...(e.repairHistory || []), { at: new Date().toISOString(), ...p }].slice(-5); this._saveSkills(); }
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
  c.delta = inventory change {item: +n/-n}
  c.dist(a, b) = euclidean distance between two {x,y,z}
pre: what must hold before the call for it to be able to succeed (use "c => true" if nothing).
post: what the call promises afterwards when it reports success (state the observable effect: arrived near target, item gained, still alive, not stranded underground, etc.). If the call returns false/null it already reported failure, so post may return true in that case.
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
    _compileContract(src) { const f = makeCompartment(this._getContractEndowments()).evaluate(`(${src})`); if (typeof f !== 'function') throw new Error('not a function'); return f; }
    _validContract(ct) {
        if (!ct || typeof ct.post !== 'string' || typeof ct.pre !== 'string') return 'missing pre/post string';
        // fix43: include eq (equipment state) in test state for contract validation
        const eq = { heldItem: null, offHand: null, helmet: null, chestplate: null, leggings: null, boots: null };
        const s = { pos: { x: 0, y: 64, z: 0 }, hp: skills.VITALS_MAX.health, food: skills.VITALS_MAX.food, sky: 15, alive: true, dim: 'overworld', inv: {}, free: 0, eq };   // fix59: max from VITALS_MAX
        const c = { args: [0, 64, 0, 'x', 1], ret: true, pre: s, post: s, delta: {}, dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) };
        try { for (const k of ['pre', 'post']) { const r = this._compileContract(ct[k])(c); if (typeof r !== 'boolean') return `${k} returned ${typeof r}, not boolean`; } } catch (e) { return `throws: ${e.message}`; }
        return null;
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
    // evaluate contracts on every traced library call; violations become contract failures in the trace
    _checkContracts(trace, taskOk) {
        const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        for (const r of trace) {
            if (r.intr || !r.s0 || !r.s1) continue;
            const e = this.skills.find(s => s.name === r.name);
            if (!e?.contract) continue;
            const c = { args: r.argv, ret: r.rv, pre: r.s0, post: r.s1, delta: r.delta, dist };
            for (const k of ['pre', 'post']) {
                // fix51: when skill explicitly returns false, skip postcondition checking
                // The skill already signaled failure; evaluating post would just mark VIOLATED for expected failure
                // This fixes craftSticks/tossClutter VIOLATED when they legitimately can't succeed
                if (k === 'post' && r.rv === false) continue;
                let ok;
                try { ok = this._compileContract(e.contract[k])(c); }
                catch (err) { console.log(`!!! [contract] ${e.name}.${k} THREW: ${err.message}; queued contract repair`); this._queueContractFix(e, `${k} threw: ${err.message}`); continue; }
                if (ok !== false) continue;
                if (k === 'pre' && !r.fail && r.rv !== false && r.rv !== null) { console.log(`[contract] ${e.name} precondition violated but the call succeeded -> precondition is wrong; queued contract repair`); this._queueContractFix(e, `precondition ${e.contract.pre} was false but the call succeeded (ret ${r.ret})`); continue; }
                // fix45: when task passed and the skill's delta shows positive gain for its effects, don't attribute VIOLATED
                // The delta is the ground truth; if the contract formula disagrees, the contract is wrong, not the skill
                if (taskOk && k === 'post') {
                    const effects = e.effects || [];
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
                r.ownFail = [...(r.ownFail || []), `${k === 'pre' ? 'PRECONDITION' : 'POSTCONDITION'} violated: ${e.contract.text || e.contract[k]} (post pos ${r.s1.pos ? [r.s1.pos.x, r.s1.pos.y, r.s1.pos.z].map(Math.round).join(',') : '?'}, sky ${r.s1.sky}, alive ${r.s1.alive})`];
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
    _queueContractFix(e, why) {
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
        const user = learnable.map(e => `--- ${e.name} ---\ndescription: ${e.description}\nobserved effects: ${JSON.stringify(e.effects || [])}\n${e.contract ? `current contract (${fixNote || 'to fix'}): ${JSON.stringify(e.contract)}\n` : ''}code:\n${String(e.code).slice(0, 1800)}`).join('\n');
        console.log(`[contract] learning contracts for ${learnable.length} skill(s) (${why}): ${learnable.map(e => e.name).join(', ')}`);
        let out; try { out = parseJSON(await this._ask(system, user)); } catch (err) { console.log(`[contract] learning FAILED: ${err.message}`); return 0; }
        let n = 0;
        for (const e of learnable) {
            const ct = out?.[e.name], bad = this._validContract(ct);
            e.contractTried = Date.now();
            if (bad) { console.log(`[contract] FAILED for ${e.name}: ${bad}`); continue; }
            // fix56: a repair that returns the same post means the contract was not the problem (e.g. the trace state it was judged on was wrong)
            if (why === 'contract repair' && e.contract && e.contract.pre === ct.pre && e.contract.post === ct.post) console.log(`!!! [contract] LOUD: contract repair of ${e.name} returned the SAME pre/post; the violation (${fixNote}) is not explained by the contract`);
            if (e.contract) e.contractPrev = e.contract;
            e.contract = { pre: ct.pre, post: ct.post, text: String(ct.text || '').slice(0, 200), learned: new Date().toISOString(), why };
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
    // fix27: an action with no position/inventory change for 60s is stopped and traced as a failure (no waiting out the 5-min timeout)
    async _run(label, fn, timeout) {
        // fix42: populate bot.__safeToToss before any skill run (for tossClutter/freeInventory)
        this._prepareTossSignals();
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
        let last = sig(), since = Date.now(); this._stall = null;
        const iv = setInterval(() => { try { const s = sig(); if (s !== last) { last = s; since = Date.now(); return; }
            if (Date.now() - since >= 60e3 && this.agent.actions.executing && !this._stall) { const p = bot.entity.position; this._stall = { t: Date.now(), pos: `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` }; console.log(`[stall] ${label}: no progress (no new ground reached, inventory, window, lit furnace) for 60s at ${this._stall.pos}; stopping the action`); this.agent.actions.stop(); } } catch (e) { console.log('[stall] watchdog error: ' + e.message); } }, 5000);
        this._lastRunMsg = '';
        try { const r = await this.agent.actions.runAction(label, fn, { timeout }); this._lastRunMsg = String(r?.message || ''); return r; } finally { clearInterval(iv); }
    }
    _stalledInRun() { const s = this._stall; return s && s.t >= (this._runStart || Infinity) ? s : null; }
    _diedInRun() { const d = this.agent.lastDeath; return d && d.t >= (this._runStart || Infinity) ? d : null; }
    _interruptReason(output = '') {
        const died = this._diedInRun();
        // fix51: set structured kind field (no text parsing needed later)
        if (died) {
            this._lastCutKind = 'death';
            return `died: ${died.message} at ${died.pos}${this._deathDetail(died, this._beforeRunInv)}`;
        }
        const st = this._stalledInRun();
        if (st) {
            this._lastCutKind = 'stall';
            return `stalled: no progress (no new ground reached, inventory, window, lit furnace) for 60s at ${st.pos}`;
        }
        const bot = this.agent.bot, p = bot.entity.position, by = this.agent.actions.lastInterruptBy;
        if (!by) throw new Error('_interruptReason called but no interrupt source (lastInterruptBy missing)');
        const s = this._surfaceY(p.x, p.z), under = s !== null && p.y < s - 4;
        const travelling = /travelTo|goToPosition|goToSurface|path|Moving|travell/i.test(String(output).slice(-800));
        const what = by === 'mode:unstuck' ? 'stuck' : `cut off by ${by}`;
        this._lastCutKind = 'interrupt';
        return `interrupted: ${what}${travelling ? ' while travelling' : ''}${under ? ` (underground: y=${Math.floor(p.y)}, surface y=${s})` : ''}`;
    }

    // fix59: process-level uncaught error/rejection. Kept alive ONLY while a task step is running: the error is that step's
    // (generated code), so the step is failed and stopped and the update loop keeps acting. Outside a step nothing owns the
    // error and nothing will act on it, so it is fatal (agent.fatal: exit 1, launchd restarts) instead of a silent stall.
    _onProcessError(kind, err) {
        if (!this.running) return this.agent.fatal(`${kind} outside a task step`, err);
        const t = this.currentTask;
        console.error(`[voyager] !!! ${kind} during task step "${t}" - counted as FAILED, step stopped, process kept alive: ${err instanceof Error ? err.stack : String(err)}`);
        if (t) { this.progress.failed.push(t); this._saveProgress(); }
        this.agent.bot.interrupt_code = true;
        this.agent.actions.stop();
    }
    // a real player spoke: they take priority
    notePlayerMessage() {
        this.lastPlayerMsg = Date.now();
        if (this.running) this.interrupt();
    }
    interrupt() {
        this.abort = true;
        if (this.running) this.agent.actions.stop().catch(() => {});
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
        if (now - this.lastPlayerMsg < PLAYER_QUIET_MS || now < (this._backoffUntil || 0)) {
            this.idlePractice.markBusy();
            return;   // fix31: no fixed task cooldown; only an error backoff
        }
        if (!this.agent.isIdle() || this.agent.self_prompter.isActive() || this.agent.prompter.awaiting_coding) {
            this.idlePractice.markBusy();
            return;
        }
        // SkillWeaver-style: track idle state for practice opportunities
        this.idlePractice.markIdle();
        // fix33: quota check removed; CodeModel handles paid→free fallback internally
        this.running = true; this.abort = false;
        const t0 = Date.now(), c0 = { ...CALLS };
        this.step().then(() => { this._errStreak = 0; }, e => {
            console.error('[voyager] step failed: ' + (e?.message ?? e));
            if (e?.stack) console.error('[voyager] stack:', e.stack);  // fix41: log stack for debugging
            // fix31 runaway guard: consecutive failing steps back off exponentially, scaled by the failing step's own duration
            this._errStreak = (this._errStreak || 0) + 1; const ms = Math.max(Date.now() - t0, 1000) * 2 ** this._errStreak;
            this._backoffUntil = Date.now() + ms; console.log(`[voyager] ${this._errStreak} failing step(s) in a row; next step in ${Math.round(ms / 1000)}s`);
        }).finally(() => { this.running = false; this.lastTaskEnd = Date.now(); this.idlePractice.markBusy();
            console.log(`[timing] step model calls: local ${CALLS.local - c0.local}, code ${CALLS.code - c0.code}, replay ${CALLS.replay - c0.replay}`); });
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
            // fix58: learned: hp below max and not recovering at the current food level (from the bot's own vitals history)
            health_recovery_blocked: this._recovery().blocked,
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
            nearby_blocks: world.getNearbyBlockTypes(bot, 16),
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
                    const summary = Object.entries(counts).map(([n, c]) => `${n}:${c}`).slice(0, 12).join(',');
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
    // Includes full inventory as k:v pairs (no slice - hiding items causes bugs like raw_iron:28 invisible)
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
    async _askLocal(system, user) {
        CALLS.local++;
        const prev = this._localQ || Promise.resolve(); let release; this._localQ = new Promise(r => release = r);
        const tq = Date.now(); await prev; const waited = Date.now() - tq; if (waited > 500) console.log(`[timing] local call waited ${waited}ms for the previous local call`);
        let r; const t0 = Date.now(); try { r = await this._local().sendRequest([{ role: 'user', content: user }], system); } finally { release(); } console.log(`[timing] ${new Date().toISOString().slice(11,19)}Z local call took ${Date.now() - t0}ms`);   // fix27
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
            if (s.name.toLowerCase() === taskLower) return { name: s.name, call: `await ${s.name}(bot);` };
            // exact task match (case-insensitive)
            if (s.task && s.task.toLowerCase().trim() === taskLower) return { name: s.name, call: `await ${s.name}(bot);` };
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
        if (goal && ['get', 'obtain'].includes(goal.verb) && has('obtainItem'))
            return { name: 'obtainItem', call: `await obtainItem(bot, ${JSON.stringify(goal.item)}, ${goal.count});` };
        if (goal && ['mine', 'collect', 'gather', 'chop'].includes(goal.verb) && this.skills.some(s => s.name === 'mineBlocks'))
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
        const IMPORTANT_PRIMITIVES = new Set(['tossClutter', 'tossItem', 'depositToChest']);
        for (const s of this.skills) {
            // fix41: allow important primitives (inventory freeing skills) even if s.primitive is true
            if (s.demoted || s.mergedInto || !s.task || /^(repair|refactor)\b/.test(s.task)) continue;
            if (s.primitive && !IMPORTANT_PRIMITIVES.has(s.name)) continue;
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
                const ids = [b.id, md.blocksByName['deepslate_' + c.item]?.id].filter(x => x !== undefined);
                return bot.findBlock({ matching: ids, maxDistance: 64 }) ? { ok: true } : { ok: false, why: `no ${c.item} within 64 blocks` };
            }
            if (c.pre === 'mob') return Object.values(bot.entities).some(e => e.name === c.mob && e.position.distanceTo(bot.entity.position) <= 48) ? { ok: true } : { ok: false, why: `no ${c.mob} within 48 blocks` };
            if (c.pre === 'input') return (inv[c.input] || 0) > 0 ? { ok: true } : { ok: false, why: `no ${c.input} in inventory` };
        } catch (e) { return { ok: false, why: `precheck error ${e.message}` }; }
        return { ok: true };
    }
    async _replay(task, before, forced) {
        let r = forced || this._findReplay(task);
        if (!r) return null;
        const pc = this._precheck(r);
        const ct = this._contract(r);
        if (ct) console.log(`[contract] ${r.name}: pre=${ct.pre} post=${ct.item ? '+' + (ct.count || 1) + ' ' + ct.item : ct.mob ? 'killed ' + ct.mob : 'smelted ' + ct.input}`);
        if (!pc.ok) {
            if (pc.reroute && r.name !== pc.reroute && this.skills.some(s => s.name === pc.reroute && !s.demoted)) {
                console.log(`[skillv] precheck ${r.name}: not applicable (${pc.why}); rerouting to ${pc.reroute} to fetch prerequisites`);
                r = { name: pc.reroute, call: `await ${pc.reroute}(bot, ${JSON.stringify(pc.item)}, ${pc.count});` };
            } else { console.log(`[skillv] precheck ${r.name}: not applicable (${pc.why}); skipping replay, writing code instead`); return null; }
        } else if (ct) console.log(`[skillv] precheck ${r.name}: applicable`);
        // fix55: one goal resolver; item/smelt goals are verified by gain, ensure by placement, skill/open goals by a learned post-contract
        const g = this._resolveGoal(task);
        if (g.kind === 'invalid') { console.log(`[fix55] LOUD: not replaying ${r.name} for invalid goal "${task}": ${g.why}`); return { ok: false, name: r.name, output: '', reason: `invalid goal: ${g.why}` }; }
        const goal = g.kind === 'item' ? g : null;
        CALLS.replay++;
        console.log(`[voyager] REPLAY skill ${r.name} for "${task}" (no code model)`);
        const entry = this.skills.find(s => s.name === r.name);
        // fix44: gate trials only when candidate effects overlap with task goal
        // Prevents trialing e.g. craftIronHelmet on an iron_pickaxe goal (wastes ingots, wrong outcome)
        let trial = false;
        if (entry?.candidate) {
            const candidateEffects = entry.candidate.effects || entry.effects || [];
            const goalItems = goal?.items || (goal?.item ? [goal.item] : []);
            const effectsOverlap = goalItems.length === 0 || candidateEffects.some(eff => goalItems.includes(eff));
            if (effectsOverlap) {
                trial = true;
                gateLog(`trial run of candidate ${r.name} (candidate ${entry.candidate.stats.success}/${entry.candidate.stats.success + entry.candidate.stats.fail}, current ${entry.stats?.success || 0}/${(entry.stats?.success || 0) + (entry.stats?.fail || 0)})`);
            } else {
                gateLog(`SKIP trial of candidate ${r.name}: effects [${candidateEffects.join(', ')}] do not overlap goal [${goalItems.join(', ')}]`);
            }
        }
        const over = {}; for (const s of this.skills) if (s.candidate && trial && (s.name === r.name || this._closure(r.name).has(s.name))) over[s.name] = s.candidate.code;   // fix10: candidates of children are trialled in place too (only if trial enabled)
        const replayClosure = new Set([r.name, ...this._closure(r.name)]);
        const tracedNames = Voyager._tracedSkillNamesForInstrument(this, replayClosure, over);
        const libPart = this._libSrcSubset(replayClosure, over);
        const full = libPart + '\n\n' + instrumentSrc(tracedNames) + '\n\nasync function __replay(bot) {\n    try { ' + r.call + ' } finally { bot.__psnOut = bot.output; }\n}\nawait __replay(bot);';
        const { lint, staged } = await this._stageLintExec(full, replayClosure, `voyager:replay:${r.name}`);
        if (lint) { console.error(`[voyager] replay ${r.name}: lint failed before run`); return { ok: false }; }
        if (!staged) return { ok: false };
        this._runStart = Date.now();
        const res = await this._run(`voyager:replay:${task}`, async () => {
            const bot = this._timedBotForSkillRun();
            bot.__psnALS = globalThis.__psnALS;
            await staged.func.main(bot);
        }, 5);
        if (this.abort) return { ok: false, interrupted: true };
        const after = this.observe();
        let ok, unverified = false;
        const cut = res.interrupted || this._diedInRun() || this._stalledInRun() ? this._interruptReason(res.message) : '';   // fix14: a cut-off replay is a failure
        if (this._diedInRun()) this._noteDeath(this._diedInRun(), task);
        if (cut) { ok = false; console.log(`[voyager] replay ${r.name} ${cut}; counting as a failure`); } else
        if (!res.success) { ok = false; console.log(`[voyager] replay ${r.name} EXEC_FAILED: ${String(res.message)}`); } else
        if (r.free) { const e = this.agent.bot.inventory.emptySlotCount(); ok = e >= r.free; console.log(`[voyager] inventory check: ${e} empty slots (need ${r.free})`); }
        else if (r.at) { const p = this.agent.bot.entity.position; ok = Math.hypot(p.x - r.at.x, p.z - r.at.z) <= 8; }
        else if (g.kind === 'item') ok = gainedFor(goal, before, after) >= goal.count;
        else if (g.kind === 'ensure') { ok = this._ensureHolds(g, after); console.log(`[psn] fix55 ensure goal ${g.item}: placed nearby -> ${ok}`); }
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
                if (held && !v.ok) {
                    // fix56: the post held but would also hold for a run that did nothing -> it cannot verify an open goal
                    console.log(`!!! [psn] LOUD: open goal "${task}" NOT verified: ${r.name} post ${entry.contract.post} cannot verify it (${v.why}); queued contract repair`);
                    this._queueContractFix(entry, `post cannot verify a goal: ${v.why}`);
                    unverified = true;
                }
                ok = held && v.ok;
                console.log(`[psn] fix55 open goal "${task}": ${r.name} learned post ${entry.contract.post} -> held=${held}, verifies run=${v.ok} -> ${ok}`);
            }
        }
        if (!ok) this._tryDecomposePrerequisiteFailure(task);
        else delete this.agent.bot.__prereqFail;
        // fix44: pass goal items to filter learned effects and produces (denoise)
        const goalItems = goal?.items || (goal?.item ? [goal.item] : null);
        if (entry && ok && !trial) this._learnEffects(entry, before, after, goalItems);
        // fix56: an unverified open goal is neither a pass nor a failure of the skill: no run stats, no blame of the root for the goal
        if (entry && !unverified) this._recordRun(entry, task, ok, trial);
        // ADAM-style: record inventory delta for needs/produces learning
        if (ok) this.npGraph.recordDelta(r.name, before.inventory, after.inventory, goalItems);
        this._attribute(r.name, task, unverified ? true : ok, over);   // fix10: per-call trace -> contract results -> blame -> targeted repair

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
        return { ok, name: r.name, output: String(res.message || ''), cut, invFullFact, unverified };
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
    async _stageLintExec(bundleSrc, skillNameSet, label = 'voyager') {
        const opts = this._coderStageOpts(bundleSrc, skillNameSet);
        console.log(`[staging] ${label}: bundle ${bundleSrc.length} chars, ${bundleSrc.split('\n').length} lines, ${skillNameSet instanceof Set ? skillNameSet.size : '?'} skill names in closure`);
        const lintSt = await withStallPhase('voyager:stage-lint', () => this.agent.coder._stageCode(bundleSrc, { ...opts, lintOnly: true }));
        if (typeof lintSt.preludeLines !== 'number') throw new Error('[voyager] _stageLintExec: lint stage must return numeric preludeLines');
        const lint = await withStallPhase('voyager:lint', () => this.agent.coder._lintCode(lintSt.src_lint_copy, lintSt.preludeLines));
        if (lint) return { lint, staged: null };
        const staged = await withStallPhase('voyager:stage-exec', () => this.agent.coder._stageCode(bundleSrc, { ...opts, lintOnly: false }));
        return { lint: null, staged };
    }
    _graph(exclude) { const g = {}; for (const s of this.skills) if (s.name !== exclude) g[s.name] = s.deps || []; return g; }
    
    // fix49: check if code would create a dependency cycle - returns error message or null
    // This is for lint feedback so the model knows which deps to avoid BEFORE the gate rejects
    _cycleLint(skillName, code) {
        const allNames = new Set(this.skills.map(s => s.name));
        const deps = depsOf(code, skillName, allNames);
        const cyc = findCycle(skillName, deps, this._graph(skillName));
        if (!cyc) return null;
        return `DEPENDENCY CYCLE would be created: ${cyc.join(' -> ')}\nThe skill "${skillName}" cannot call ${deps.filter(d => cyc.includes(d)).join(', ')} because they transitively depend on "${skillName}".`;
    }

    // fix32: learned effects / consumption of a skill from its successful runs (union, capped) - feeds backward chaining
    // fix44: goalItems hint FILTERS which observed ups count as effects - does NOT fabricate
    // When goalItems present: keep only observed ∩ goal (no fabrication from goal alone)
    // When goalItems absent: keep ALL observed ups (no hard-coded incidental/junk tables)
    _learnEffects(e, before, after, goalItems = null) {
        const inv0 = before.inventory, inv1 = after.inventory;
        let up = Object.keys(inv1).filter(k => (inv1[k] || 0) > (inv0[k] || 0));
        const down = Object.keys(inv0).filter(k => (inv1[k] || 0) < (inv0[k] || 0));
        
        // fix44: filter up items when goal hint present (observed ∩ goal)
        // NO hard-coded incidental/junk item tables - when no goal, keep ALL observed ups
        if (goalItems && goalItems.length) {
            const excluded = up.filter(k => !goalItems.includes(k));
            if (excluded.length) console.log(`[psn] _learnEffects filtered non-goal items: [${excluded.join(',')}]`);
            up = up.filter(k => goalItems.includes(k));
        }
        // else: no goal hint -> keep ALL observed ups (no filtering)
        
        const eff = [...new Set([...(e.effects || []), ...up])].slice(0, 12), con = { ...(e.consumes || {}) };
        for (const k of down) con[k] = Math.max(con[k] || 0, (inv0[k] || 0) - (inv1[k] || 0));
        if (JSON.stringify(eff) !== JSON.stringify(e.effects || []) || JSON.stringify(con) !== JSON.stringify(e.consumes || {})) { e.effects = eff; e.consumes = con; this._saveSkills(); }
    }
    // fix55: ONE goal resolver. Each kind comes from one rule over disjoint grammars (no fallback chain):
    //   item   - "Smelt N a into N b" / "<verb> N <item>" (smeltGoal / countGoal): verified by inventory gain
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
        const count = countGoal(t);
        if (count) return { kind: 'item', ...count };
        if (!isBareIdentifier(t)) return { kind: 'open' };
        const e = this.skills.find(s => s.name === t);
        if (!e) return { kind: 'invalid', why: `"${t}" is neither an item goal ("<verb> N <item>", "Smelt N <raw> into N <out>", "ensure <block>") nor the name of a known skill` };
        if (e.demoted) return { kind: 'invalid', why: `skill ${t} is demoted` };
        if (e.mergedInto) return { kind: 'invalid', why: `skill ${t} was merged into ${e.mergedInto}; propose ${e.mergedInto}` };
        const need = requiredArgs(e);
        if (need.length) return { kind: 'invalid', why: `skill ${t} needs arguments (${need.join(', ')}); propose an item goal instead` };
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
    // fix51: decompose a structured prerequisite failure (bot.__prereqFail = { item, need, have }) via learned graph
    _tryDecomposePrerequisiteFailure(parentTask) {
        const bot = this.agent.bot;
        if (!Object.hasOwn(bot, '__prereqFail')) return false;
        const { item, need, have } = bot.__prereqFail;
        delete bot.__prereqFail;
        const shortfall = need - have;
        if (!(shortfall > 0)) throw new Error(`__prereqFail for ${item} has non-positive shortfall (need ${need}, have ${have})`);
        const inv = this.observe().inventory;
        const sub = this._subgoalToObtainItem(item, shortfall, inv, new Set());
        if (!sub) {
            console.log(`[psn] PREREQUISITE FAILED for ${item} but no learned producer subgoal (needs/produces + skill library)`);
            return false;
        }
        const d = (this.progress.decomposed ||= {}), q = (this.progress.subgoals ||= []);
        const depth = (this._curSub?.task === parentTask ? this._curSub.depth : 0);
        d[parentTask] = { subs: [sub], skills: [], at: Date.now(), reason: `prerequisite: need ${shortfall} more ${item}` };
        q.unshift({ task: sub, parent: parentTask, depth: depth + 1 }, { task: parentTask, retry: true, depth });
        this._saveProgress();
        console.log(`[psn] DECOMPOSE (prerequisite) "${parentTask}" -> ${sub} (missing ${shortfall} ${item})`);
        return true;
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
        if (skill.task) return skill.task;
        return null;
    }
    // fix51: idle practice success requires real inventory/effect change (not empty delta / instant return)
    _practiceRunChanged(skill, before, after) {
        const effects = Object.hasOwn(skill, 'effects') ? skill.effects : [];
        if (effects.length) {
            const gained = effects.filter(it => (after.inventory[it] || 0) > (before.inventory[it] || 0));
            if (gained.length) return { ok: true, detail: `+${gained.join(',')}` };
            return { ok: false, detail: `no gain for effects [${effects.join(',')}]` };
        }
        const inv0 = before.inventory, inv1 = after.inventory;
        const keys = new Set([...Object.keys(inv0), ...Object.keys(inv1)]);
        for (const k of keys) {
            if ((inv1[k] || 0) !== (inv0[k] || 0)) return { ok: true, detail: `inv delta includes ${k}` };
        }
        return { ok: false, detail: 'empty inventory delta' };
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
        try { return this._compileContract(e.contract.post)({ args: r.argv, ret: r.rv, pre: r.s0, post: r.s1, delta: r.delta, dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) }) === true; }
        catch (err) { console.log(`!!! [contract] ${e.name}.post THREW: ${err.message}; does not hold, queued contract repair`); this._queueContractFix(e, `post threw: ${err.message}`); return false; }
    }

    // fix56: can this post-contract verify a goal at all, judged on the run that just happened?
    //  1) AST: the post must read something the run produces: c.ret, c.delta or c.post.* (c.dist(c.pre.pos, c.post.pos) counts via c.post.pos)
    //  2) null-run counterfactual: the same post on a run that did nothing (ret undefined, post state = pre state, empty delta) must be false;
    //     a post that also holds when nothing happened (e.g. "!c.ret || (c.post.alive && c.pre.dim === c.post.dim)") verifies nothing
    //  3) falsy ret: when the real ret is falsy, the pass must come from the state change, not from a "!c.ret ||" guard:
    //     the post with the real ret but no state change must be false
    _postVerifiesRun(e) {
        const src = e.contract.post;
        const { root, param } = this._parseContract(src);
        if (param === null) return { ok: false, why: 'post takes no parameter, so it reads nothing from the run' };
        const reads = new Set();
        this._walkAst(root.body, node => { if (node.type !== 'MemberExpression') return; const p = this._contractPath(node, param); if (p && p.length) reads.add(p[0] === 'post' ? 'post' : p[0]); });
        if (!['ret', 'delta', 'post'].some(k => reads.has(k))) return { ok: false, why: `post reads only [${[...reads].join(', ')}], nothing the run produced (ret, delta, post state)` };
        const r = this.agent.bot.__psnTrace.find(t => t.name === e.name && (t.parent ?? -1) < 0);
        const f = this._compileContract(src), dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (f({ args: r.argv, ret: undefined, pre: r.s0, post: r.s0, delta: {}, dist }) === true) return { ok: false, why: 'post also holds for a run that did nothing (ret undefined, no state change)' };
        if (!r.rv && f({ args: r.argv, ret: r.rv, pre: r.s0, post: r.s0, delta: {}, dist }) === true) return { ok: false, why: `ret was ${JSON.stringify(r.rv)} and the post holds from ret alone (vacuous guard), not from what the run changed` };
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

        const inv = state.inventory;
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
        const fromSkills = this.skills.filter(s => !s.demoted && !s.mergedInto && !s.candidate && !/^(repair|refactor)\b/.test(s.task || '') && (s.effects || []).includes(item)
            && !(signatureOf(s.code, s.name).match(/\(([^)]*)\)/)?.[1] || '').split(',').slice(1).some(x => x.trim() && !x.includes('=')))
            .map(s => ({ s, V: this._maturity(s).V }));
        
        // fix44: check merged skills - if a merged skill produces the item, include its merge target
        // ONLY if the merge target is a validated active skill (not candidate, not demoted)
        for (const merged of this.skills.filter(s => s.mergedInto && (s.effects || []).includes(item))) {
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
    async _backchain(task, before) {
        const goal = countGoal(task); if (!goal) return null;
        const plan = [];
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
        const L = this.skills.filter(s => !s.primitive && !s.handwritten && !s.demoted && !s.mergedInto && !s.candidate && s.embedding && (s.effects || []).length);
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
            && (s.effects || []).length && !/\(bot\s*,/.test(signatureOf(s.code, s.name)));
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
    _detectSplit() {
        if (this._splitDue) return;
        const large = this.skills.filter(s => !s.primitive && !s.handwritten && !s.demoted && !s.mergedInto && !s.candidate
            && (s.code || '').split('\n').length > 40 && this._maturity(s).V < 0.5);
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
            return `${s.name}: ${desc.slice(0, 120)}${learned}`;
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
    // fix40: legacy builtInAPIList for backward compatibility - returns bare names now
    builtInAPIList() {
        const bare = getBareAPI();
        return bare.sigs.join('\n');
    }
    
    // fix47: per-prompt breakdown logging (uses shared helper, no magic threshold)
    _logPromptBreakdown(kind, sections) {
        return logPromptBreakdown(kind, sections);
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
            else if (c.stats.success >= 2 && rate(c.stats) >= rate(entry.stats || newStats())) { gateLog(`PROMOTE candidate ${entry.name}${jointCtx}: ${c.stats.success} passes, trial ${c.stats.success}/${n} >= current rate ${rate(entry.stats || newStats()).toFixed(2)}`); this._promote(entry, c); }
            else gateLog(`candidate ${entry.name}${jointCtx} trial ${ok ? 'passed' : 'failed'} (${c.stats.success}/${n})${invCtx}; waiting for more runs`);
        } else {
            entry.stats = recordRun(entry.stats || newStats(), task, ok);
            if (!ok && entry.stats.streakFail >= 3 && entry.handwritten_original && entry.code !== entry.handwritten_original.code) { gateLog(`ROLLBACK ${entry.name}: promoted replacement failed 3 times in a row`); this.restoreHandwritten(entry.name); }
            else if (!ok && entry.stats.streakFail >= 3 && !entry.primitive && !entry.demoted) { entry.demoted = true; gateLog(`DEMOTE ${entry.name}: failed 3 times in a row (kept on disk, not replayed)`); }
        }
        this._saveSkills();
    }
    _promote(entry, c) {
        this._proposalOutcome(entry, 'promoted');
        entry.prev = { code: entry.code, description: entry.description, deps: entry.deps, stats: entry.stats, saved: entry.saved };
        Object.assign(entry, { code: c.code, description: c.description, deps: c.deps, effects: c.effects, embedding: c.embedding, saved: new Date().toISOString(), stats: c.stats, demoted: false });
        if (c.refactor) entry.refactorOf = c.refactor; else delete entry.refactorOf;
        delete entry.candidate;
        { const o = this.progress.outcomes || []; if (o.length >= 3) { (this.progress.watch ||= []).push({ name: entry.name, base: o.slice(-3).reduce((a, b) => a + b, 0) / 3, after: [] }); this._saveProgress(); } }   // fix32 windowed rollback
        writeAtomic(`${this.dir}/${entry.name}.js`, `// ${entry.description}\n${entry.code}\n`);
        // fix11 (B4): parents are re-validated only once the new version is actually live
        const parents = parentsOf(entry.name, this._graph());
        for (const p of parents) { const pe = this.skills.find(s => s.name === p); if (pe) pe.revalidate = entry.name; }
        if (parents.length) console.log(`[psn] promoted ${entry.name}; marked ${parents.length} parent(s) for re-validation: ${parents.join(', ')}`);
        this._saveSkills();
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
        const res = await this._run(`voyager:gate:${entry.name}`, async () => {
            const bot = this._timedBotForSkillRun();
            bot.__psnALS = globalThis.__psnALS;
            await staged.func.main(bot);
        }, 4);   // fix28: stall watchdog on gate runs
        if (this._stalledInRun()) { gateLog(`regression rerun of ${entry.name} stalled; counted as a failed rerun`); return false; }
        if (res.interrupted || this.abort) return null;
        return gainedFor(goal, before, this.observe()) >= goal.count;
    }
    // fix35: serialized code-model calls with loud logging (one in flight at a time; no dual same-model Ollama generate)
    // fix37: idle practice runs during code-model waits (no separate 30s idle required)
    async _ask(system, user) {
        CALLS.code++;
        const callNum = CALLS.code;
        // serialize code-model calls; queue if another is in flight
        const prev = this._askQ || Promise.resolve();
        let release; this._askQ = new Promise(r => release = r);
        const wasQueued = prev !== (this._askQPrev || Promise.resolve());
        this._askQPrev = prev;
        if (wasQueued) console.log(`[overlap] code-model call #${callNum} waiting for previous call to finish (serialized)`);
        try { await prev; } catch (e) { /* previous call's error doesn't block us */ }
        if (wasQueued) console.log(`[overlap] code-model call #${callNum} now running (previous finished)`);
        // fix33: CodeModel.sendRequest handles paid→free fallback internally; no pre/post quota check here
        const cm = this.agent.prompter.code_model;
        const t0 = Date.now(); console.log(`[timing] ${new Date().toISOString().slice(11,19)}Z composer call #${callNum} start (prompt ${system.length + user.length} chars)`);
        // fix35: overlap CPU-only maintenance with code-model wait (flush debounced saves, extract shared fragments)
        this._overlapCpuMaintenance();
        // fix37: start idle practice in background during code-model wait (learned skills, no 30s idle required)
        const practicePromise = this._startIdlePractice(callNum);
        let r; try { r = await cm.sendRequest([{ role: 'user', content: user }], system); } finally {
            this._stopIdlePractice();
            release();
            console.log(`[timing] ${new Date().toISOString().slice(11,19)}Z composer call #${callNum} took ${Date.now() - t0}ms (reply ${String(r ?? '').length} chars)`);
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
        this._idlePracticeAbort = false;
        const t0 = Date.now();
        let practiceMs = 0;  // fix49: track actual practice time
        console.log(`[idle-practice] starting during code-model call #${callNum}`);
        const practice = async () => {
            let consecutiveSkips = 0;
            let practiceCount = 0;
            const MAX_CONSECUTIVE_SKIPS = 3;
            while (this._idlePracticeActive && !this._idlePracticeAbort) {
                // select a learned skill to practice (ranked by learning value)
                const skill = this._selectPracticeSkill();
                if (!skill) {
                    console.log(`[idle-practice] no eligible skill to practice; pausing 5s`);
                    await new Promise(r => setTimeout(r, 5000));
                    consecutiveSkips++;
                    if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
                        console.log(`[idle-practice] no eligible skills after ${MAX_CONSECUTIVE_SKIPS} attempts; stopping`);
                        break;
                    }
                    continue;
                }
                consecutiveSkips = 0;
                // run the skill and track time
                const runStart = Date.now();
                const ok = await this._runPracticeSkill(skill);
                const runMs = Date.now() - runStart;
                if (ok && ok.message && ok.deltaChanged) {
                    // fix49: only count as practice if state delta is non-empty
                    console.log(`[idle-practice] SUCCESS ${skill.name}: ${ok.message} (practice: ${runMs}ms)`);
                    practiceMs += runMs;
                    practiceCount++;
                } else if (ok && ok.message) {
                    // ran but no state change - doesn't count as practice
                    console.log(`[idle-practice] ${skill.name}: no state delta (not counted as practice)`);
                } else if (ok === null) {
                    break;
                } else {
                    consecutiveSkips++;
                    if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
                        console.log(`[idle-practice] ${MAX_CONSECUTIVE_SKIPS} consecutive skips/failures; pausing`);
                        await new Promise(r => setTimeout(r, 5000));
                        consecutiveSkips = 0;
                    }
                }
                if (this._idlePracticeActive && !this._idlePracticeAbort) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            return { practiceCount, practiceMs };
        };
        this._idlePracticePromise = practice().then(({ practiceCount, practiceMs: pm }) => {
            const modelCallMs = Date.now() - t0;
            const idleMs = modelCallMs - pm;
            // fix49: log format for before/after measurement
            console.log(`[idle] model_call_ms=${modelCallMs} practice_ms=${pm} idle_ms=${idleMs} runs=${practiceCount}`);
        }).catch(e => {
            console.error(`[idle-practice] ERROR: ${e.message}; stopping practice`);
        }).finally(() => {
            this._idlePracticeActive = false;
        });
        return this._idlePracticePromise;
    }
    _stopIdlePractice() {
        if (!this._idlePracticeActive) return;
        this._idlePracticeAbort = true;
        console.log(`[idle-practice] stopping (code-model call completed)`);
    }
    // fix37/fix49: select a learned skill to practice - ranked by learning value
    // Learning value: low success rate, high streakFail, few trials
    // Plan relevance: shares needs/produces with pending goal
    _selectPracticeSkill() {
        const inv = this.observe().inventory;
        const pending = this._getPendingGoalItems();  // items needed by pending/failed tasks
        const candidates = this.skills.filter(s =>
            !s.primitive && !s.handwritten && !s.demoted && !s.mergedInto && !s.candidate &&
            s.code && s.name && s.stats &&
            /async\s+function\s+\w+\s*\(\s*bot\s*(?:,\s*\w+\s*=\s*[^,)]+)*\)/.test(s.code)
        );
        if (!candidates.length) return null;
        const filtered = candidates.filter(s => {
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
        const pendingSize = pending.size;
        const scored = filtered.map(s => {
            const successes = s.stats.success;
            const failures = s.stats.fail;
            const n = successes + failures;
            
            // Beta-posterior variance: (s+1)(f+1) / ((n+2)^2 * (n+3))
            const uncertainty = ((successes + 1) * (failures + 1)) / (Math.pow(n + 2, 2) * (n + 3));
            
            // plan relevance = |effects ∩ pending needs| / |pending needs|
            // effects may be empty array but never undefined (initialized at save time)
            const effects = s.effects;
            const intersection = effects.filter(eff => pending.has(eff)).length;
            const planRelevance = pendingSize > 0 ? intersection / pendingSize : 0;
            
            // final score: uncertainty * (1 + plan_relevance)
            const score = uncertainty * (1 + planRelevance);
            return { s, score, reason: `n=${n} unc=${uncertainty.toFixed(4)} rel=${planRelevance.toFixed(2)}` };
        }).sort((a, b) => b.score - a.score);
        
        if (scored.length > 0) {
            console.log(`[idle-practice] top candidate: ${scored[0].s.name} (${scored[0].reason})`);
        }
        // pick the highest-scoring skill (no randomization - uncertainty is the tiebreaker)
        return scored[0]?.s || null;
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
        const effects = skill.effects;
        if (effects.length > 0) {
            const produced = effects.filter(eff => inv[eff] > 0);
            // if all effects are already in inventory, postcondition is likely met
            if (produced.length === effects.length) {
                return `postcondition already met (has all of: ${effects.join(', ')})`;
            }
        }
        // 2) Check if skill would consume scarce inputs needed by pending goals
        const consumes = Object.keys(skill.consumes);
        if (consumes.length > 0) {
            for (const item of consumes) {
                const have = inv[item] || 0;  // inventory lookup: missing item = 0
                const need = skill.consumes[item];
                // if pending items include this consumable and we don't have much
                if (pendingItems.has(item) && have < need * 3) {
                    return `would consume scarce ${item} (have ${have}, need ${need}, pending goal needs it)`;
                }
            }
        }
        return null;
    }
    // fix43: compute safe-to-toss and deposit-candidate items based on POSITIVE learned signals only
    // INVERTED POLARITY: absence from needs/produces does NOT imply disposable
    // Items are safe to toss ONLY if:
    // 1. We have a POSITIVE learned producer signal for them (skill.effects or NeedsProducesGraph confirms we can get more)
    // 2. NOT consumed by pending goal items
    // 3. In surplus (count > max(64, learned consume amount × 3))
    // Unknown/unlinked items → NOT auto-tossed, returned to model/planning as 'uncertain'
    // Returns { toss: [item names], deposit: [item names], uncertain: [items with no learned signal] }
    _computeTossAndDepositLists() {
        const inv = this.observe().inventory || {};
        const pendingItems = this._getPendingGoalItems();
        
        // Collect all items that are consumed by any skill
        const consumedBySkills = new Set();
        const maxConsumed = {};  // track max consumption per item for surplus threshold
        for (const s of this.skills) {
            if (s.demoted || s.mergedInto) continue;
            for (const [item, amt] of Object.entries(s.consumes || {})) {
                consumedBySkills.add(item);
                maxConsumed[item] = Math.max(maxConsumed[item] || 0, amt);
            }
        }
        
        // Collect items that we have POSITIVE learned producer signals for (we can get more)
        const hasLearnedProducer = new Set();
        for (const s of this.skills) {
            if (s.demoted || s.mergedInto || s.candidate) continue;
            for (const eff of (s.effects || [])) {
                hasLearnedProducer.add(eff);
            }
        }
        // Also check the NeedsProducesGraph for confirmed producers
        if (this.npGraph) {
            const confirmed = this.npGraph.getConfirmedLinks();
            for (const [key, links] of Object.entries(confirmed)) {
                for (const prod of (links.produces || [])) {
                    hasLearnedProducer.add(prod);
                }
            }
        }
        
        // Essential tools/armor - always keep (minimal: equipped gear only, no food/torch lists)
        const essential = /pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots|shield|bow|crossbow|trident|elytra|crafting_table|furnace/;
        
        const tossItems = [];
        const depositItems = [];
        const uncertainItems = [];
        
        for (const [item, count] of Object.entries(inv)) {
            if (count <= 0) continue;
            if (essential.test(item)) continue;  // never toss/deposit essential gear
            
            // Skip if this is needed for pending goals
            if (pendingItems.has(item)) continue;
            
            // Skip if consumed by any known skill (valuable for future crafting)
            if (consumedBySkills.has(item)) {
                // Large stacks (>64) of consumed items are deposit candidates only
                if (count > 64) {
                    depositItems.push({ item, count, score: count });
                }
                continue;
            }
            
            // fix43: ONLY toss if we have a POSITIVE learned producer signal (we can get more)
            // Unknown items (no learned producer) → NOT auto-tossed, marked uncertain
            if (!hasLearnedProducer.has(item)) {
                uncertainItems.push({ item, count });
                // Large stacks of uncertain items can still be deposit candidates (safer than toss)
                if (count > 64) {
                    depositItems.push({ item, count, score: count });
                }
                continue;
            }
            
            // Has learned producer AND not consumed AND not pending → safe to toss surplus
            // Surplus threshold: max(64, learned consume × 3) - learned, not hard-coded per-item
            const surplusThreshold = Math.max(64, (maxConsumed[item] || 0) * 3);
            if (count > surplusThreshold) {
                const surplus = count - surplusThreshold;
                tossItems.push({ item, count, surplus, score: surplus });
            }
            
            // Large stacks are also deposit candidates (backup if toss fails)
            if (count > 64) {
                depositItems.push({ item, count, score: count });
            }
        }
        
        // Sort by surplus/score (highest surplus first)
        tossItems.sort((a, b) => b.score - a.score);
        depositItems.sort((a, b) => b.score - a.score);
        
        console.log(`[toss] computed ${tossItems.length} safe-to-toss item(s) (POSITIVE learned producer + surplus): ${tossItems.slice(0, 5).map(x => `${x.item}(${x.surplus}/${x.count})`).join(', ')}${tossItems.length > 5 ? '...' : ''}`);
        console.log(`[toss] computed ${depositItems.length} deposit candidate(s): ${depositItems.slice(0, 5).map(x => `${x.item}(${x.count})`).join(', ')}${depositItems.length > 5 ? '...' : ''}`);
        if (uncertainItems.length) {
            console.log(`[toss] ${uncertainItems.length} item(s) have NO learned producer (not auto-tossed, returned to model/planning): ${uncertainItems.slice(0, 5).map(x => `${x.item}(${x.count})`).join(', ')}${uncertainItems.length > 5 ? '...' : ''}`);
        }
        
        return {
            toss: tossItems.map(x => x.item),
            deposit: depositItems.map(x => x.item),
            uncertain: uncertainItems.map(x => x.item)
        };
    }
    // fix43: populate bot.__safeToToss, __depositCandidates, and __uncertainItems before running tossClutter/freeInventory
    // fix51: also populate __knownChests from chestMemory (deposit uses ONLY learned chests)
    _prepareTossSignals() {
        const lists = this._computeTossAndDepositLists();
        this.agent.bot.__safeToToss = lists.toss;
        this.agent.bot.__depositCandidates = lists.deposit;
        this.agent.bot.__uncertainItems = lists.uncertain || [];
        this.agent.bot.__knownChests = this.chestMemory;
    }
    // fix37/fix49: run a practice skill safely - returns { message, deltaChanged } on success, false on context-fail, null on abort
    // fix49: tracks state delta - empty delta means the run doesn't count as practice
    // Fail-loud: all skips and failures are logged clearly
    async _runPracticeSkill(skill) {
        if (this._idlePracticeAbort) return null;
        const bot = this.agent.bot;
        const before = this.observe();
        // safety gates: log clearly when skipped (not silent)
        if (!this.agent.isIdle()) {
            console.log(`[idle-practice] SKIPPED ${skill.name}: bot is not idle`);
            return false;
        }
        // threats are a real-time danger (learned from environment), keep this gate
        const threats = this._threats();
        if (threats !== 'none') {
            console.log(`[idle-practice] SKIPPED ${skill.name}: threats nearby (${threats})`);
            return false;
        }
        // fix49: capture state before to compute delta
        const stateBefore = this.observe();
        
        // stage and run the skill (fail-loud: log errors, rethrow critical ones)
        const call = `await ${skill.name}(bot);`;
        const prClosure = new Set([skill.name, ...this._closure(skill.name)]);
        const full = this._libSrcSubset(prClosure) + `\n\nasync function __practice(bot) {\n    try { ${call} } catch (e) { log(bot, 'PRACTICE FAILED: ' + e.message); throw e; }\n}\nawait __practice(bot);`;
        let staged;
        try {
            const { lint, staged: st } = await this._stageLintExec(full, prClosure, `voyager:idle-practice:${skill.name}`);
            if (lint) { console.error(`[idle-practice] LINT FAILED ${skill.name}`); return false; }
            staged = st;
        }
        catch (e) { console.error(`[idle-practice] STAGING FAILED ${skill.name}: ${e.message}`); return false; }
        if (!staged) { console.error(`[idle-practice] STAGING FAILED ${skill.name}: no staged code returned`); return false; }
        // mark as running, cap at 10 seconds for practice runs
        const practiceStart = Date.now();
        const maxPracticeMs = 10000;
        let completed = false;
        let practiceError = null;
        const runPromise = (async () => {
            try {
                await Promise.race([
                    staged.func.main(this._timedBotForSkillRun()),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('practice timeout')), maxPracticeMs))
                ]);
                completed = true;
            } catch (e) {
                practiceError = e;
                if (e.message !== 'practice timeout') {
                    console.error(`[idle-practice] EXECUTION FAILED ${skill.name}: ${e.message}`);
                } else {
                    console.log(`[idle-practice] TIMEOUT ${skill.name}: exceeded ${maxPracticeMs}ms`);
                }
            }
        })();
        // wait for completion or abort
        while (!completed && !practiceError && Date.now() - practiceStart < maxPracticeMs) {
            if (this._idlePracticeAbort) {
                bot.interrupt_code = true;
                console.log(`[idle-practice] ABORTED ${skill.name}: code-model call completed`);
                return null;
            }
            await new Promise(r => setTimeout(r, 200));
        }
        try { await runPromise; } catch (e) { /* already logged above */ }
        const after = this.observe();
        const changed = this._practiceRunChanged(skill, stateBefore, after);
        if (skill.stats) {
            skill.stats.lastRun = Date.now();
            skill.stats.practiceRuns = (skill.stats.practiceRuns || 0) + 1;
            this._saveSkills();
        }
        if (practiceError) {
            return false;
        }
        if (!changed.ok) {
            console.log(`[idle-practice] NOT SUCCESS ${skill.name}: ${changed.detail} (no ranking bump)`);
            return false;
        }
        return { message: `${changed.detail} in ${Date.now() - practiceStart}ms`, deltaChanged: changed.ok };
    }

    // fix47: compute cheapest tool to break a block by recursing through recipes
    // Returns { tool, chain: [{item, count}] } where chain is the recipe steps from gatherable materials
    _cheapestHarvestTool(blockName, inv) {
        if (!VERSION) return null;
        try {
            const md = minecraftData(VERSION);
            const block = md.blocksByName[blockName];
            if (!block?.harvestTools) return null;
            
            // Get all valid tools from harvestTools (keys are item IDs)
            const validToolIds = Object.keys(block.harvestTools).map(Number);
            if (!validToolIds.length) return null;
            
            // Find the cheapest tool by recipe depth
            let cheapest = null;
            let cheapestDepth = Infinity;
            
            for (const toolId of validToolIds) {
                const toolItem = md.items[toolId];
                if (!toolItem) continue;
                
                // Check if we already have it
                if ((inv[toolItem.name] || 0) > 0) {
                    return { tool: toolItem.name, chain: [], reason: 'already have' };
                }
                
                // Compute recipe chain depth
                const chain = this._recipeChain(toolItem.name, inv, md, 0, new Set());
                if (chain && chain.length < cheapestDepth) {
                    cheapestDepth = chain.length;
                    cheapest = { tool: toolItem.name, chain };
                }
            }
            return cheapest;
        } catch (e) {
            console.log(`[fix47] _cheapestHarvestTool failed for ${blockName}: ${e.message}`);
            return null;
        }
    }
    
    // fix47: compute recipe chain from gatherable materials (harvestTools undefined = can break by hand)
    _recipeChain(itemName, inv, md, depth, visited) {
        if (depth > 10 || visited.has(itemName)) return null;
        visited.add(itemName);
        
        // Already have it
        if ((inv[itemName] || 0) > 0) return [];
        
        const item = md.itemsByName[itemName];
        if (!item) return null;
        
        // Check recipes
        const recipes = md.recipes?.[item.id];
        if (!recipes?.length) {
            // No recipe - check if it's a gatherable block (can break by hand)
            const block = md.blocksByName[itemName];
            if (block && !block.harvestTools) {
                // Can gather by hand
                return [{ item: itemName, count: 1, action: 'gather' }];
            }
            return null;
        }
        
        // Find simplest recipe
        let bestChain = null;
        for (const recipe of recipes) {
            const ingredients = [];
            if (recipe.inShape) {
                for (const row of recipe.inShape) {
                    for (const slot of row) {
                        if (slot?.id >= 0) {
                            const ingName = md.items[slot.id]?.name;
                            if (ingName) ingredients.push({ name: ingName, count: slot.count || 1 });
                        }
                    }
                }
            } else if (recipe.ingredients) {
                for (const ing of recipe.ingredients) {
                    if (ing?.id >= 0) {
                        const ingName = md.items[ing.id]?.name;
                        if (ingName) ingredients.push({ name: ingName, count: ing.count || 1 });
                    }
                }
            }
            
            // Recurse for each ingredient
            let totalChain = [];
            let valid = true;
            for (const ing of ingredients) {
                const subChain = this._recipeChain(ing.name, inv, md, depth + 1, new Set(visited));
                if (!subChain) { valid = false; break; }
                totalChain = [...totalChain, ...subChain];
            }
            
            if (valid) {
                totalChain.push({ item: itemName, count: recipe.result?.count || 1, action: 'craft' });
                if (!bestChain || totalChain.length < bestChain.length) {
                    bestChain = totalChain;
                }
            }
        }
        return bestChain;
    }
    
    // ---------- automatic curriculum ----------
    // fix29: restored fix19 PSN decomposition (removed with the milestone planner in fix27c while its callers stayed):
    // a goal that keeps failing is split by the local model into 2-4 subgoals (depth <= 2, 30-min cooldown per goal);
    // each subgoal is learned as a skill, then the parent is retried composing those skills
    // fix47: inventory-first planning + harvestTools-based tool decompose
    async _decompose(task, reason) {
        const d = (this.progress.decomposed ||= {}), q = (this.progress.subgoals ||= []);
        const depth = (this._curSub?.task === task ? this._curSub.depth : 0);
        if (depth >= 2) { console.log(`[psn] decompose skipped for "${task}": already a depth-${depth} subgoal`); return false; }
        if (d[task] && Date.now() - d[task].at < 30 * 60e3) { console.log(`[psn] decompose skipped for "${task}": decomposed ${Math.round((Date.now() - d[task].at) / 60e3)} min ago`); return false; }
        
        const reasonStr = String(reason);
        const inv = this.observe().inventory || {};
        
        // fix47: detect "Cannot break X with current tools" and compute cheapest tool via harvestTools
        const cannotBreak = reasonStr.match(/Cannot break (\w+) with current tools/i);
        if (cannotBreak) {
            const blockName = cannotBreak[1].toLowerCase();
            const toolInfo = this._cheapestHarvestTool(blockName, inv);
            if (toolInfo?.chain?.length > 0) {
                // Queue the recipe chain as subgoals
                const subs = toolInfo.chain.map(step => {
                    if (step.action === 'gather') return `Collect 1 ${step.item}`;
                    return `Craft 1 ${step.item}`;
                });
                d[task] = { subs, skills: [], at: Date.now(), reason: `need ${toolInfo.tool} to break ${blockName}` };
                q.unshift(...subs.map(t => ({ task: t, parent: task, depth: depth + 1 })), { task, retry: true, depth });
                // fix47: track this as a blocker so curriculum prioritizes tool acquisition
                // Blockers are cleared when: (1) tool appears in inventory, (2) blocked task passes
                this.progress.blockers = this.progress.blockers || [];
                const blockerEntry = { tool: toolInfo.tool, block: blockName, task, at: Date.now() };
                // Remove duplicate blockers for same block/tool, keep only most recent 5
                this.progress.blockers = this.progress.blockers.filter(b => b.block !== blockName).slice(-4);
                this.progress.blockers.push(blockerEntry);
                this._saveProgress();
                console.log(`[psn] DECOMPOSE (harvestTools) "${task}" -> need ${toolInfo.tool}: ${subs.join(', ')}`);
                return true;
            }
        }
        
        // fix47: inventory-first planning - before queuing gather/mine subgoals, check if we can produce
        const goal = smeltGoal(task) || countGoal(task) || parseVerboseGoal(task);
        if (goal) {
            const state = this.observe();
            const inv = state.inventory || {};
            const shortfallInfo = this._computeShortfall(goal, inv);
            
            // If shortfall is 0 and we can produce via learned producers, queue the learned skill's task as subgoal
            if (shortfallInfo.shortfall === 0 && shortfallInfo.produceItems?.length > 0) {
                const produceSubs = shortfallInfo.produceItems.map(s => {
                    // Use the learned skill's own task string, scaled to needed count
                    const needed = Math.min(s.count, goal.count - (inv[goal.item] || 0));
                    if (s.task) {
                        // Scale the count in the task string if it contains a number
                        return s.task.replace(/\d+/, String(needed));
                    }
                    // Fallback: use producer name with needed count
                    return `${s.producer} ${needed}`;
                });
                d[task] = { subs: produceSubs, skills: [], at: Date.now(), reason: `inventory-first: can produce ${goal.item} via learned producers` };
                q.unshift(...produceSubs.map(t => ({ task: t, parent: task, depth: depth + 1 })), { task, retry: true, depth });
                this._saveProgress();
                console.log(`[psn] DECOMPOSE (inventory-first) "${task}" -> learned: ${produceSubs.join(', ')}; no mine/gather needed`);
                return true;
            }
        }
        
        const system = `You break a Minecraft bot's failing goal into smaller steps (Voyager/PSN-style task decomposition).
Return 2-4 concrete, verifiable subgoals, in order, that together achieve the goal; each must be doable in a few minutes by ONE small reusable skill. Use the failure reason and the state. Do not repeat the goal itself.
Reply ONLY with JSON: {"subgoals": ["...", "..."]}`;
        // fix39: enriched known_skills with descriptions for primitives and space-freeing skills
        const user = `goal: ${task}\nwhy it failed: ${String(reason).slice(0, 600)}\ndeath_hotspots: ${this._deathHotspots()}\n${this._stateText(this.observe())}\nknown_skills: ${JSON.stringify(this._knownSkillsFacts())}`;
        let subs = [];
        try { subs = (parseLocalJSON(await this._askLocal(system, user), ['subgoals']).subgoals || []).map(t => String(t).trim()).filter(t => t && t !== task && !validateTask(t)).slice(0, 4); }
        catch (e) { console.log(`[psn] decompose FAILED for "${task}": ${e.message}`); return false; }
        if (subs.length < 2) { console.log(`[psn] decompose FAILED for "${task}": model gave ${subs.length} valid subgoal(s)`); d[task] = { subs, skills: [], at: Date.now(), reason: String(reason).slice(0, 200) }; this._saveProgress(); return false; }
        d[task] = { subs, skills: [], at: Date.now(), reason: String(reason).slice(0, 200) };
        q.unshift(...subs.map(t => ({ task: t, parent: task, depth: depth + 1 })), { task, retry: true, depth });
        this._saveProgress();
        console.log(`[psn] DECOMPOSE "${task}" (${String(reason).slice(0, 120)}) -> ${subs.map((t, i) => `${i + 1}) ${t}`).join(' ')}; then retry the parent with the learned skills`);
        return true;
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
    _goalBackoffMultiplier(task) {
        const { s, f } = this._goalOutcomes(task);
        if (f === 0) return 1;
        const n = s + f;
        // posterior mean: (s+1)/(n+2) - Bayesian with uniform prior
        return (s + 1) / (n + 2);
    }
    // fix55: a proposed goal runs with probability = its posterior success; otherwise it is backed off to the planner.
    // No constants: the odds come only from learned outcomes, and a backed-off goal still gets retried at that rate.
    _goalBackedOff(task) {
        const m = this._goalBackoffMultiplier(task);
        if (m === 1 || Math.random() < m) return null;
        const { s, f } = this._goalOutcomes(task);
        return `backed off: it succeeded ${s} of ${s + f} tries (posterior success ${m.toFixed(2)}); propose something else`;
    }
    // fix55: gate for a proposed task: syntax check, one goal resolver, learned backoff (planner proposals only)
    _rejectTask(task, fromPlanner) {
        if (!task) return 'empty task';
        const bad = validateTask(task);
        if (bad) return bad;
        const g = this._resolveGoal(task);
        if (g.kind === 'invalid') return g.why;
        return fromPlanner ? this._goalBackedOff(task) : null;
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
        const knownSkillsFacts = this._knownSkillsFacts();
        const replayableTasks = this.skills.filter(s => s.task && !s.primitive).map(s => s.task.split(/\s+(?:within|at|using|from)\b/i)[0]).slice(-25);
        // fix47: include active blockers so curriculum prioritizes unblocking goals
        // Clear resolved blockers: tool now in inventory
        const inv = state.inventory || {};
        this.progress.blockers = (this.progress.blockers || []).filter(b => !(inv[b.tool] > 0));
        if (this.progress.blockers.length > 0) this._saveProgress();
        const blockers = this.progress.blockers;
        const blockerHint = blockers.length > 0 
            ? `\nBLOCKERS (prioritize these - failures need tools): ${blockers.map(b => `need ${b.tool} to break ${b.block}`).join('; ')}`
            : '';
        // fix49: pass edible inventory (from minecraft-data foods) to curriculum - let the model rank
        const edible = VERSION ? this._getEdibleInventory(inv) : [];
        const edibleHint = edible.length > 0 
            ? `\nedible_inventory: ${edible.map(e => `${e.item}(${e.count}, food=${e.foodPoints})`).join(', ')}`
            : '';
        // fix58: learned recovery facts (food level -> hp regen, skills' observed food change) so the ranking can weigh recovery
        const rec = this._recovery(), recText = this.vitals.recoveryText(rec);
        const vmax = skills.getVitalsMax(bot);   // fix59: one source for hp/food max (was literal /20)
        if (rec.blocked) console.log(`[vitals] ${recText}`);
        const recoveryHint = recText ? `\n${recText}` : '';
        const user = `known_skills: ${JSON.stringify(knownSkillsFacts)}
replayable_tasks (cheap, no new code needed): ${JSON.stringify(replayableTasks)} plus any "Mine N <block or ore>", "Collect N <log>", "Get N <item>", "Smelt N <raw> into N <out>", "Kill N <mob>", "Harvest N <crop>"
completed_tasks: ${JSON.stringify(this.progress.completed.slice(-30))}
failed_tasks: ${JSON.stringify(this.progress.failed.slice(-15))}${blockerHint}${edibleHint}${recoveryHint}
--- state (compact) ---
${compactStateText}
current_health: ${Math.round(bot.health)}/${vmax.health}\ncurrent_food: ${bot.food}/${vmax.food} (${vmax.food}/${vmax.food} = full)${this._cursorLimited() ? '\nIMPORTANT: the code-writing model is unavailable right now, so ONLY propose a task from replayable_tasks or "Mine N <block>".' : ''}${workflowHints ? '\n' + workflowHints : ''}`;   // fix31: slow-changing lists first so Ollama reuses the cached prompt prefix
        const facts = recipeFacts(this.progress.failed.slice(-5).join(' '));
        const finalUser = facts ? user + '\n' + facts : user;
        // fix47: per-prompt breakdown logging for curriculum
        this._logPromptBreakdown('curriculum', {
            system: system.length,
            skills: JSON.stringify(knownSkillsFacts).length,
            state: compactStateText.length,
            history: JSON.stringify(this.progress.completed.slice(-30)).length + JSON.stringify(this.progress.failed.slice(-15)).length,
            recipes: facts.length
        });
        return parseLocalJSON(await this._askLocal(system, finalUser), ['reasoning', 'task', 'context']);
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
        const v0 = await em.embed(text);   // fix14: fail loudly, no word-overlap fallback
        const v = Array.isArray(v0?.[0]?.values) ? v0[0].values : v0;
        C.set(text, v); if (C.size > 256) C.delete(C.keys().next().value);
        return v;
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
        // fix26: names must include BOTH learned skills AND built-in bare API (skills.*/world.* exports)
        // so missingCalls doesn't reject repairs that call getNearestBlock, getInventoryCounts, etc.
        const bareAPI = getBareAPI();
        const names = new Set([...this.skills.map(s => s.name), ...bareAPI.names]);
        let deps = depsOf(code, name, names);
        const missing = missingCalls(code, name, names);
        if (missing.length) { gateLog(`REJECT ${name}: calls unknown skills ${missing.join(', ')}`); return false; }
        // fix39: seeded primitives must not depend on learned skills (prevents cycles like
        // ensureCraftingTable -> depositToChest -> ensureChest -> ensureCraftingTable)
        // If a repair tries to add learned deps to a seeded skill, strip them and warn
        const existingSkill = this.skills.find(s => s.name === name);
        if (existingSkill?.seeded) {
            const learnedDeps = deps.filter(d => {
                const dep = this.skills.find(s => s.name === d);
                return dep && !dep.seeded && !dep.primitive && !dep.handwritten;
            });
            if (learnedDeps.length) {
                gateLog(`WARN ${name} (seeded): stripping learned deps [${learnedDeps.join(', ')}] to prevent cycles`);
                deps = deps.filter(d => !learnedDeps.includes(d));
            }
        }
        const cyc = findCycle(name, deps, this._graph(name));
        if (cyc) { gateLog(`REJECT ${name}: dependency cycle ${cyc.join(' -> ')}`); return false; }
        const embedding = await this._embed(description);
        const idx = this.skills.findIndex(s => s.name === name);
        if (idx < 0) {
            const entry = { name, description, task, code, deps, embedding, effects: this._lastEffects || [], saved: new Date().toISOString(), stats: recordRun(newStats(), task, true) };
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
        const cand = { code, description, deps, embedding, task, effects: this._lastEffects || entry.effects || [], stats: newStats() };   // fix11 (B2): no seeded success; trial runs only
        if (!opts.repair && !opts.refactor && !this._updateAllowed(entry, 'new version from a task')) return false;
        if (opts.refactor) cand.refactor = opts.refactor;
        const reg = await this._regressionRun(entry, code);
        if (reg === true) { gateLog(`PROMOTE ${name}: passed regression rerun on a past task`); this._promote(entry, cand); }
        else if (reg === false) { gateLog(`REJECT update to ${name}: failed regression rerun on a past task; keeping current version`); this._proposalOutcome(entry, 'failed regression rerun'); if (opts.refactor) this._rollbackRefactor(opts.refactor, name); }
        else if (opts.repair) { entry.candidate = cand; gateLog(`HOLD repair of ${name}: kept as candidate; needs 2+ trial runs with success rate >= current ${rate(entry.stats || newStats()).toFixed(2)}`); }   // fix11 (B3)
        else if (!entry.handwritten && !(entry.stats?.success)) { gateLog(`PROMOTE ${name}: current version has no recorded successes`); this._promote(entry, cand); }
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
        const v = parseLocalJSON(await this._askLocal(system, user), ['reasoning', 'success', 'critique']);

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
    _attribute(root, task, ok, over) {
        const bot = this.agent.bot, trace = bot.__psnTrace;
        bot.__psnTrace = null;
        if (!Array.isArray(trace) || !trace.length) { console.log('[psn] no execution trace recorded'); return; }
        annotateTrace(trace, bot.__psnOut || '');
        this._checkContracts(trace, ok);   // fix22: learned pre/postconditions against real state
        this._learnVitalsEffects(trace);   // fix58
        this._learnSlotEffects(trace);   // fix59
        // candidate children: their contract result in this run is a trial run (regression gate)
        for (const name of Object.keys(over)) {
            if (name === root) continue;
            const rec = trace.find(t => t.name === name);
            const e = this.skills.find(s => s.name === name);
            if (rec && e?.candidate && !rec.intr) { gateLog(`trial run of candidate ${name} inside ${root}: contract ${rec.ok ? 'ok' : 'FAILED'}`); this._recordRun(e, task, rec.ok, true); }
        }
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
        if (stalled) { let i = -1; for (let k = 0; k < trace.length; k++) if ((trace[k].t0 || 0) <= stalled.t && (trace[k].t1 ?? Infinity) >= stalled.t - 1500 && (i < 0 || trace[k].depth >= trace[i].depth)) i = k; if (i < 0) i = trace.length - 1; console.log(`[psn] stall attributed to the call running at stall time: ${trace[i].name} (depth ${trace[i].depth})`); trace[i].ownFail = [`FAILED: STALLED: no progress (no new ground reached, inventory, window, lit furnace) for 60s at ${stalled.pos}`]; for (; i >= 0; i = trace[i].parent) { trace[i].intr = false; trace[i].ok = false; trace[i].fail = true; } ok = false; }
        const timedOut = !died && !stalled && /timed out/i.test(this._lastRunMsg);   // fix33: a timeout is a failure of the deepest call running at the cut
        if (timedOut) {
            this._lastCutKind = 'timeout';  // fix51: set structured kind field
            const ix = trace.map((r, k) => k).filter(k => trace[k].intr && trace[k].t1); const cutT = Math.min(...ix.map(k => trace[k].t1)); let i = -1;
            for (const k of ix) if (trace[k].t1 <= cutT + 1500 && (i < 0 || trace[k].depth >= trace[i].depth)) i = k;
            if (i < 0) i = trace.length - 1; while (i >= 0 && trace[i].name.startsWith('skills.') && trace[i].parent >= 0) i = trace[i].parent;
            console.log(`[psn] timeout attributed to the call running at the cut: ${trace[i].name} (depth ${trace[i].depth})`);
            trace[i].ownFail = [`FAILED: TIMED OUT while running (${String(trace[i].ownFail?.join(' | '))})`]; for (; i >= 0; i = trace[i].parent) { trace[i].intr = false; trace[i].ok = false; trace[i].fail = true; } ok = false;
        }
        // fix27: no hotspot filter; deaths stay traced failures (above) and blame/repair learns avoidance
        // fix19 (5): an explicit FAILED line from a skill is a contract failure even if the task check passed (e.g. ensureChest inside a storage task)
        const explicit = trace.some(r => !r.intr && (r.ownFail || []).some(l => /FAILED|CONDITION violated/.test(l)));   // fix22: contract violations count
        if (ok && !revalFail && !explicit) return;
        if (ok && explicit) console.log(`[psn] task check passed but a skill reported FAILED; attributing that contract failure`);
        console.log(`[psn] execution trace of ${root} (${trace.length} calls):\n${traceText(trace)}`);
        const learned = n => !!this.skills.find(s => s.name === n);   // fix33: seeded primitives included   // fix24: includes hand-written (repairs become learned candidates)
        let bs = blameAll(trace, n => this._isLeaf(n), learned).slice(0, 3);   // at most 3 patches per failure (deepest first)
        // fix19 (2): no learned skill on a failure path: the root's own composition is at fault
        if (!bs.length) {
            const b0 = blame(trace, n => this._isLeaf(n));
            const why = b0 ? (b0.target ? `failure only in non-library code ${b0.target} (${b0.evidence})` : `only the fixed leaf ${b0.leaf} failed (${b0.evidence})`) : 'every call met its contract but the task outcome failed';
            if (learned(root)) { bs = [{ target: root, leaf: root, path: [root], kind: 'callee_fix', swallowed: false, evidence: why }]; console.log(`[psn] blame: root learned skill ${root} [callee_fix]: ${why}`); }
            else { console.log(`[psn] blame: ${why}; root ${root} is ${this.skills.some(s => s.name === root) ? 'primitive/hand-written' : 'freshly generated'} -> goal goes to decomposition`); this._decomposeQueue ||= { task, reason: why }; return; }
        } else console.log(`[psn] blame (top-down over ${bs.length} responsible skill(s), patched bottom-up): ${bs.map(b => `${b.target} [${b.kind}${b.swallowed ? ', swallowed' : ''}]`).join(', ')}; path ${bs[0].path.join(' > ')}; deepest failure ${bs[0].leaf}: ${bs[0].evidence}`);
        { // fix32 (PSN joint repair): a blamed child and a blamed ancestor on the same failure path are repaired together
            const kid = bs.length >= 2 && bs.find(c => bs.some(q => q !== c && (c.path || []).includes(q.target)));
            if (kid) { const par = bs.find(q => q !== kid && kid.path.includes(q.target)); bs = [{ ...kid, kind: 'joint', parent: par.target, parentKind: par.kind }, ...bs.filter(x => x !== kid && x !== par)]; console.log(`[psn] JOINT repair queued: child ${kid.target} [${kid.kind}] with its caller ${par.target} [${par.kind}] (same failure path)`); }
        }
        const rq = [...(this._repairQueue || [])];
        // fix47: hash-based deduplication - signature includes skill hash so it resets when skill changes
        const failSig = (b) => {
            const skill = this.skills.find(s => s.name === b.target);
            const hash = this._skillHash(skill);
            return `${b.target}:${hash}:${(b.evidence || '').slice(0, 100).replace(/\s+/g, ' ')}`;
        };
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
            rq.push({ ...b, task, trace: traceText(trace, 60), peers: bs.map(x => x.target), sig }); console.log(`[psn] queued REPAIR of ${b.target} (${rq.length} in queue)`);
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
                this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence.slice(0, 200), desc: `seeded contract restored: ${e.contract.text}`, outcome: 'seeded contract restored' });
                return true;
            }
            if (this._cursorLimited()) { console.log(`[psn] contract repair of ${e.name} deferred: code model at its limit`); this._deferRepair(q, 10 * 60e3, 'code model at its limit'); return false; }
            delete (this.progress.deferCounts || {})[`${e.name}:contract_fix`];
            console.log(`[psn] REPAIR contract of ${e.name} (${q.evidence})`);
            const n = await this._learnContracts([e], 'contract repair', q.evidence);
            this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence.slice(0, 200), desc: n ? `contract -> ${e.contract.text}` : 'contract repair failed', outcome: n ? 'contract replaced' : 'failed' });
            return n > 0;
        }
        if (Date.now() - (this._repairs[e.name] || 0) < 30 * 60e3) { console.log(`[psn] repair of ${e.name} skipped: already repaired in the last 30 min (cap)`); this._deferRepair(q, Math.max(60e3, 30 * 60e3 - (Date.now() - (this._repairs[e.name] || 0))), 'already repaired in the last 30 min (cap)'); return false; }
        if (e.candidate) { console.log(`[psn] repair of ${e.name} skipped: a candidate is already under trial`); this._deferRepair(q, 10 * 60e3, 'a candidate is already under trial'); return false; }
        if (this._cursorLimited()) { console.log(`[psn] repair of ${e.name} skipped: code model at its limit`); this._deferRepair(q, 10 * 60e3, 'code model at its limit'); return false; }
        if (!this._updateAllowed(e, `repair after ${q.kind}`)) { console.log(`[psn] repair of ${e.name} skipped: maturity gate froze it`); return false; }
        this._repairs[e.name] = Date.now(); delete (this.progress.deferCounts || {})[`${e.name}:${q.kind}`]; this._saveProgress();   // fix27: counter resets when the repair actually runs
        const kids = [...this._closure(e.name)].map(n => this.skills.find(s => s.name === n)).filter(Boolean);
        // AWM-style: retrieve similar past repair lessons
        const pastLessons = await this.repairMemory.retrieveSimilar(q.evidence, 3);
        const awmHints = this.repairMemory.formatHintsForCoder(pastLessons);
        // fix40: unified bare-name API - all functions called by bare name (no skills.*/world.* prefix)
        const relevantSkills = new Set([e.name, ...this._closure(e.name), ...parentsOf(e.name, this._graph())]);
        const system = `You repair ONE skill in a Minecraft mineflayer skill library (PSN-style targeted fix). Return a single \`\`\`javascript code block containing ONLY the fixed function, with the SAME name and a compatible signature. First line inside the block: // DESCRIPTION: <one sentence>. Every loop must check bot.interrupt_code. If something still cannot be done, log(bot, 'FAILED: <reason>') and return a falsy value; no silent fallbacks. findBlock/findBlocks/nearestEntity/bot.entities/blockAt results can be null or empty: always null-check them before reading .position/.x or calling methods on them.

AVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z) - do NOT use skills.* or world.* prefix):
${this.unifiedAPIList(relevantSkills)}

IMPORTANT: All functions use bare names. Do NOT write skills.goToPosition - write goToPosition. Do NOT write world.getNearestBlock - write getNearestBlock.`;
        const user = `Blamed skill: ${e.name} (${q.kind === 'caller_fix' ? 'it calls the leaf ' + q.leaf + ' in a situation where the leaf cannot succeed: fix how/when it calls it, e.g. obtain the missing prerequisite first' : 'its own logic failed'})\nTask that failed: ${q.task}\nFailure path: ${q.path.join(' > ')}\nEvidence: ${q.evidence}\n--- execution trace (indent = call depth) ---\n${q.trace}\n${e.contract ? `--- learned contract of ${e.name} (must hold after your fix) ---\npre: ${e.contract.pre}\npost: ${e.contract.post}\n` : ''}--- current code of ${e.name} ---\n${e.code}\n--- skills it uses ---\n${kids.map(k => '// ' + k.description + '\n' + signatureOf(k.code, k.name)).join('\n')}\n${(e.repairHistory || []).length ? `\n--- your last ${e.repairHistory.length} repair proposal(s) for ${e.name} (do not repeat what failed) ---\n` + e.repairHistory.map((h, i) => `${i + 1}. [${h.outcome || 'pending'}] ${h.kind}: ${h.evidence}\n   change: ${h.desc}`).join('\n') : ''}${q.peers?.length > 1 ? `\nOther skills blamed on the same failure (repaired children-first): ${q.peers.join(', ')}` : ''}${awmHints ? `\n${awmHints}` : ''}\nWrite the fixed ${e.name}:`;
        console.log(`[psn] repair memory for ${e.name}: ${(e.repairHistory || []).length} past proposal(s) in the prompt${pastLessons.length ? `, ${pastLessons.length} AWM lesson(s)` : ''}`);
        console.log(`[psn] REPAIR ${e.name} [${q.kind}] with the code model (evidence: ${q.evidence.slice(0, 160)})`);
        let code, body, desc, extra = '';
        let _repairStaged = null;
        // fix37: duplicate-reply detection state for repair loop
        let prevRepairHash = null, repairDupes = 0;
        for (let att = 1; att <= 2; att++) {   // fix19 (3): one retry with the lint/format error fed back
            // fix37: escalating duplicate feedback for repair loop
            const dupeWarn = repairDupes > 0 ? `\n\n!!! CRITICAL: Your previous reply was IDENTICAL. You MUST write DIFFERENT code. !!!` : '';
            let reply;
            try { reply = await this._ask(system, user + extra + dupeWarn); } catch (err) { console.log(`[psn] repair FAILED for ${e.name}: ${err.message}`); return false; }
            // fix37: duplicate-reply detection for repair loop
            const repairHash = this._hashReply(reply);
            if (prevRepairHash !== null && repairHash === prevRepairHash) {
                repairDupes++;
                console.log(`[duplicate] DETECTED in repair: reply #${att} identical to #${att - 1} (hash ${repairHash})`);
                if (repairDupes >= 2) {
                    console.error(`[duplicate] ABORT repair of ${e.name}: 2 consecutive duplicate replies; repair FAILED LOUDLY`);
                    this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence.slice(0, 200), desc: 'ABORTED: duplicate replies', outcome: 'duplicate replies' });
                    return false;
                }
                extra = `\n--- your previous reply was IDENTICAL to the one before ---\nYou MUST write DIFFERENT code. Change your approach.\n--- previous code ---\n${code || '(none)'}`;
                continue;
            }
            prevRepairHash = repairHash;
            repairDupes = 0;
            code = extractCode(reply);
            const fn = code && code.match(/async\s+function\s+([A-Za-z_]\w*)\s*\(/);
            let err = null;
            if (!fn || fn[1] !== e.name) err = `reply did not define async function ${e.name}`;
            else {
                desc = ((code.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || e.description).trim();
                body = code.replace(/\n\s*await\s+\w+\(bot[^)]*\);\s*$/, '').trim();
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
            if (!err) break;
            console.log(`[psn] repair attempt ${att} FAILED for ${e.name}: ${String(err).slice(0, 300)}${att < 2 ? '; retrying with the error fed back' : ''}`);
            if (att === 2) {
                this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence.slice(0, 200), desc: `invalid code: ${String(err).slice(0, 150)}`, outcome: 'lint failed' });
                // AWM-style: record lint failure
                await this.repairMemory.recordRepair({ errorSignature: q.evidence, fixSnippet: code?.slice(0, 300), outcome: false, taskHint: q.task, skillName: e.name });
                return false;
            }
            extra = `\n--- your previous reply was rejected ---\n${err}\n--- previous code ---\n${code || '(none)'}\nFix the error and write the fixed ${e.name} again:`;
        }
        this._lastEffects = e.effects || [];
        this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence.slice(0, 200), desc: desc.slice(0, 200) });
        const saved = await this.saveSkill(e.name, desc, body, `repair: ${q.task}`, { repair: true });
        if (!saved) {
            this._proposalOutcome(e, 'rejected at submit', q.sig); this._saveSkills();
            // AWM-style: record gate rejection
            await this.repairMemory.recordRepair({ errorSignature: q.evidence, fixSnippet: desc?.slice(0, 200), outcome: false, taskHint: q.task, skillName: e.name });
            console.log(`[psn] repair of ${e.name} rejected by the gate`);
            return false;
        }
        // AWM-style: record successful repair submission
        await this.repairMemory.recordRepair({ errorSignature: q.evidence, fixSnippet: desc?.slice(0, 200), outcome: true, taskHint: q.task, skillName: e.name });
        if (e.candidate) { e.candidate.trialTask = q.task; e.candidate.trialAfter = Date.now(); this._saveSkills(); }   // fix28: dedicated trial run next step
        console.log(`[psn] repaired ${e.name}: submitted to the gate (parents are re-validated once it is promoted)`);
        return true;
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
        const pastLessons = await this.repairMemory.retrieveSimilar(q.evidence, 2);
        const awmHints = this.repairMemory.formatHintsForCoder(pastLessons);
        const relevantSkills = new Set([e.name, pe.name, ...this._closure(e.name), ...this._closure(pe.name), ...parentsOf(e.name, this._graph()), ...parentsOf(pe.name, this._graph())]);
        // fix40: unified bare-name API - all functions called by bare name
        const system = `You repair TWO skills of a Minecraft mineflayer skill library together (PSN joint repair): a child skill and the caller that uses it failed on the same path.

REQUIRED FORMAT: Return ONE \`\`\`javascript code block containing EXACTLY two async function definitions:
1. First: async function ${e.name}(bot) { ... }
2. Second: async function ${pe.name}(bot) { ... }

Each function must:
- Keep the SAME name (${e.name} and ${pe.name} respectively)
- Have a compatible signature
- Be preceded by // DESCRIPTION: <one sentence>

Every loop must check bot.interrupt_code. If something cannot be done, log(bot, 'FAILED: <reason>') and return a falsy value; no silent fallbacks. findBlock/findBlocks/nearestEntity/bot.entities/blockAt results can be null or empty: always null-check them.
Fix the child's own logic and how/when the caller uses it. No top-level call, no extra functions.

AVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z) - do NOT use skills.* or world.* prefix):
${this.unifiedAPIList(relevantSkills)}

IMPORTANT: All functions use bare names. Do NOT write skills.goToPosition - write goToPosition. Do NOT write world.getNearestBlock - write getNearestBlock.`;
        const user = `Task that failed: ${q.task}\nEvidence: ${q.evidence}\n--- current bot state ---\n${this._stateText(this.observe())}\n--- execution trace ---\n${extractFeedback(q.trace || '', 2500)}\n--- child ${e.name} ---\n${e.code}\n--- caller ${pe.name} ---\n${pe.code}${e.contract ? `\n--- contract of ${e.name} ---\npre: ${e.contract.pre}\npost: ${e.contract.post}` : ''}${pe.contract ? `\n--- contract of ${pe.name} ---\npre: ${pe.contract.pre}\npost: ${pe.contract.post}` : ''}${awmHints ? `\n${awmHints}` : ''}\nWrite both fixed functions (${e.name} first, then ${pe.name}):`;
        console.log(`[psn] REPAIR JOINT ${e.name} + ${pe.name} with the code model (evidence: ${String(q.evidence).slice(0, 160)})`);
        let reply; try { reply = await this._ask(system, user); } catch (err) { console.log(`[psn] joint repair FAILED: ${err.message}`); return false; }

        // fix37 (C): improved extraction with better logging on failure
        const code = extractCode(reply) || '';
        const fns = this._extractJointFunctions(code, e.name, pe.name);

        if (!fns[e.name] || !fns[pe.name]) {
            // Log the raw reply (truncated) so we can see what came back
            const rawSnippet = String(reply).length > 1500 ? String(reply).slice(0, 1500) + '\n...[truncated]' : String(reply);
            console.log(`[psn] joint repair FAILED: reply did not define both ${e.name} and ${pe.name}`);
            console.log(`[psn] extracted functions: [${Object.keys(fns).join(', ')}], expected: [${e.name}, ${pe.name}]`);
            console.log(`[psn] raw model reply (for debugging):\n${rawSnippet}`);
            this._noteProposal(e, { task: q.task, kind: 'joint', evidence: String(q.evidence).slice(0, 200), desc: `joint reply incomplete (got [${Object.keys(fns).join(', ')}], needed [${e.name}, ${pe.name}])`, outcome: 'failed' });
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
            this._lastEffects = x.effects || [];
            this._noteProposal(x, { task: q.task, kind: 'joint', evidence: String(q.evidence).slice(0, 200), desc: `joint with ${x === e ? pe.name : e.name}` });
            console.log(`[psn] joint repair ${id}: submitting ${x.name} to gate (deps check, cycle check, regression rerun if past tasks exist)`);
            const saved = await this.saveSkill(x.name, desc(fns[x.name], x.description), strip(fns[x.name]), `repair: ${q.task}`, { repair: true, refactor: id });
            if (!saved) {
                // saveSkill logs the gate reason via gateLog; summarize the failure context here
                console.log(`[psn] joint repair ${id}: GATE REJECTED ${x.name}. Check gateLog above for specific reason (unknown skill calls, dependency cycle, or failed regression rerun). Rolling back the pair.`);
                this._rollbackRefactor(id, `${x.name} rejected at gate`);
                return false;
            }
        }
        if (pe.candidate) { pe.candidate.trialTask = q.task; pe.candidate.trialAfter = Date.now(); this._saveSkills(); }
        console.log(`[psn] joint repair ${id}: ${e.name} + ${pe.name} both passed gate checks and submitted as candidates (both rolled back if either fails trial runs)`);
        return true;
    }

    // fix28: a repaired candidate gets its trial runs in a short dedicated run on the task that failed, instead of waiting for a caller
    async _gateTrial() {
        const e = this.skills.find(s => s.candidate?.trialTask && Date.now() >= (s.candidate.trialAfter || 0)); if (!e) return false;
        const c = e.candidate, task = c.trialTask.replace(/^repair:\s*/, '');
        const sig = (c.code.match(new RegExp(`async\\s+function\\s+${e.name}\\s*\\(([^)]*)\\)`)) || [])[1] || 'bot';
        const extra = sig.split(',').slice(1).map(x => x.trim()).filter(Boolean);
        if (extra.some(x => !x.includes('='))) { gateLog(`dedicated trial of ${e.name} not possible: required parameters (${extra.join(', ')}); its trials come from callers`); delete c.trialTask; this._saveSkills(); return false; }
        c.trialAfter = Date.now() + 5 * 60e3; this._saveSkills();
        gateLog(`dedicated trial run of candidate ${e.name} on "${task}" (candidate ${c.stats.success}/${c.stats.success + c.stats.fail})`);
        const before = this.observe();
        const rp = await this._replay(task, before, { name: e.name, call: `await ${e.name}(bot);` });
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
${this.unifiedAPIList()}

IMPORTANT: All functions use bare names. Do NOT write skills.X or world.X - call functions directly by name.`;
        const user = `Repeated fragment:\n${h.fragment}\n${ents.map(e => `--- ${e.name} ---\n${e.code}`).join('\n')}\nWrite the helper then the rewritten skills:`;
        console.log(`[psn] REFACTOR ${id}: extracting the fragment shared by ${ents.map(e => e.name).join(', ')}`);
        let reply; try { reply = await this._ask(system, user); } catch (err) { console.log(`[psn] refactor FAILED: ${err.message}`); return false; }
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
        for (const [n, c] of rewrites) { const e = this.skills.find(s => s.name === n); this._lastEffects = e.effects || []; await this.saveSkill(n, e.description, c, `refactor ${id}`, { refactor: id }); }
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
${this.unifiedAPIList()}

IMPORTANT: All functions use bare names. Do NOT write skills.X or world.X - call functions directly by name.`;
        const user = `Similar skills to generalise:\n${ents.map(e => `--- ${e.name} ---\n${e.description}\n${e.code}`).join('\n')}\nWrite the parameterized helper then the wrapper skills:`;
        console.log(`[psn] GENERALISE ${id}: parameterising ${ents.map(e => e.name).join(', ')}`);
        let reply; try { reply = await this._ask(system, user); } catch (err) { console.log(`[psn] generalise FAILED: ${err.message}`); return false; }
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
        for (const [n, c] of wrappers) { const e = this.skills.find(s => s.name === n); this._lastEffects = e.effects || []; await this.saveSkill(n, e.description, c, `generalise ${id}`, { refactor: id }); }
        console.log(`[psn] generalise ${id}: helper ${helper[0]} added; ${wrappers.length} wrapper(s) under verification`);
        return true;
    }
    // fix34 (PSN split): split large monolithic skills into sub-skills
    async _split() {
        if (!this._splitDue || this._cursorLimited()) return false;
        this._splitDue = false;
        const name = this._splitHint;
        const e = this.skills.find(s => s.name === name && !s.demoted && !s.mergedInto && !s.candidate);
        if (!e || (e.code || '').split('\n').length <= 40) { console.log(`[psn] split skipped: ${name} no longer qualifies`); return false; }
        const id = `sp${Date.now()}`;
        // fix40: unified bare-name API
        const system = `You refactor a Minecraft mineflayer skill library (PSN split: break a large skill into smaller reusable sub-skills). Return ONE \`\`\`javascript block with: first 2-3 NEW sub-skill async functions (bot) that each do one logical piece of the work, each preceded by // DESCRIPTION: <one sentence>; then the original skill rewritten to call those sub-skills. Keep the SAME name and signature for the original. Every loop checks bot.interrupt_code.

AVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z) - do NOT use skills.* or world.* prefix):
${this.unifiedAPIList()}

IMPORTANT: All functions use bare names. Do NOT write skills.X or world.X - call functions directly by name.`;
        const user = `Large skill to split:\n--- ${e.name} ---\n${e.description}\n${e.code}\nWrite the sub-skills then the rewritten main skill:`;
        console.log(`[psn] SPLIT ${id}: breaking ${e.name} (${e.code.split('\n').length} lines) into sub-skills`);
        let reply; try { reply = await this._ask(system, user); } catch (err) { console.log(`[psn] split FAILED: ${err.message}`); return false; }
        const code = extractCode(reply) || '';
        const fns = []; const re = /(?:^|\n)async\s+function\s+([A-Za-z_]\w*)\s*\(/g; let mm, idx = [];
        while ((mm = re.exec(code))) idx.push([mm[1], mm.index]);
        for (let i = 0; i < idx.length; i++) fns.push([idx[i][0], code.slice(idx[i][1], i + 1 < idx.length ? idx[i + 1][1] : code.length).trim()]);
        const subs = fns.filter(([n]) => !this.skills.some(s => s.name === n));
        const main = fns.find(([n]) => n === e.name);
        if (subs.length < 2 || !main) { console.log(`[psn] split ${id} FAILED: reply had ${subs.length} sub-skill(s) and ${main ? 'the' : 'no'} rewritten main`); return false; }
        const over = { [main[0]]: main[1] }; for (const [n, c] of subs) over[n] = c;
        const spNames = new Set(Object.keys(over));
        for (const n of Object.keys(over)) for (const d of this._closure(n)) spNames.add(d);
        const spBundle = this._libSrcSubset(spNames, over) + `\n\n${subs.map(s => s[1]).join('\n\n')}\n\nawait Promise.resolve();`;
        const { lint } = await this._stageLintExec(spBundle, spNames, `voyager:split:${id}`);
        if (lint) { console.log(`[psn] split ${id} FAILED lint: ${String(lint).slice(0, 300)}`); return false; }
        this._lastEffects = [];
        for (const [n, c] of subs) {
            const desc = ((c.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || `sub-skill of ${e.name}`).trim();
            if (!(await this.saveSkill(n, desc, c, `split ${id}`))) { console.log(`[psn] split ${id} FAILED: sub-skill ${n} rejected`); return false; }
        }
        this.progress.refactors = { ...(this.progress.refactors || {}), [id]: { main: e.name, subs: subs.map(s => s[0]), kind: 'split', at: Date.now() } }; this._saveProgress();
        this._lastEffects = e.effects || [];
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
        const now = Date.now(); console.log(`[timing] ${new Date().toISOString().slice(11,19)}Z step start (gap since last step end ${this._stepEnd ? now - this._stepEnd : 0}ms)`);   // fix27
        try { return await this._step(); } finally { this._flushSkills(); this._stepEnd = Date.now(); console.log(`[timing] ${new Date().toISOString().slice(11,19)}Z step end (took ${this._stepEnd - now}ms)`); }
    }
    async _step() {
        this._checkHomeGround();   // fix27: perception upkeep (was called from the removed milestone planner)
        this._watchWindows();
        this._watchDimension();
        if (this.agent.bot.currentWindow) { const w = this.agent.bot.currentWindow; if (/CHOICE/.test(JSON.stringify(w.title))) { if (!this._choiceNoted) { this._choiceNoted = 1; console.log("[window] datapack dialog CHOICE (A Breach Happened multi_action dialog via ViaProxy) left open; not answering"); } } else console.log(`[window] STRAY ${w.type} id=${w.id} still open at step start (opened ${Math.round((Date.now() - (this._winOpenedAt || 0)) / 1000)}s ago); closing`); if (!/CHOICE/.test(JSON.stringify(w.title))) try { this.agent.bot.closeWindow(w); } catch (e) { console.log('[window] close failed: ' + e.message); } }
        this._oneshot();
        // fix18: no hard-coded survival/housekeeping policy; the curriculum proposes it and the PSN learns it
        this._requeueDeferred();   // fix26
        if (this._repairQueue?.length) { await this._repair(); return; }
        if (this._decomposeQueue) { const dq = this._decomposeQueue; this._decomposeQueue = null; await this._decompose(dq.task, dq.reason); return; }
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
        const sub = this._subgoalTask(), ms = null, fromCurr = !sub && !ms;
        let proposal = sub || ms || await this._takePlan(before);
        let task = String(proposal.task || '').trim();
        let invalid = this._rejectTask(task, fromCurr);   // fix55: invalid goals and learned backoff go back to the planner
        if (invalid) {
            console.log(`[voyager] rejected task "${task}": ${invalid}`);
            this.progress.failed.push(`${task} (invalid: ${invalid})`);
            proposal = await this.proposeTask({ ...before, note: `Your last proposal "${task}" was rejected: ${invalid}` });
            task = String(proposal.task || '').trim();
            invalid = this._rejectTask(task, true);
            if (invalid) { console.log(`[voyager] rejected again "${task}": ${invalid}; skipping`); this._saveProgress(); return; }
        }
        console.log(`[voyager] new task: ${task} (${proposal.reasoning})`);
        this.currentTask = task;
        this._prefetchPlan(task, before);   // fix28 (C): the next proposal is planned while this task runs
        VERSION = this.agent.bot.version;

        // fix37 (B): check if the goal is ALREADY SATISFIED before running anything (learned postcondition check)
        const alreadySatisfied = this._goalAlreadySatisfied(task, before);
        if (alreadySatisfied.satisfied) {
            console.log(`[voyager] goal already satisfied: ${task} (${alreadySatisfied.reason})`);
            this.progress.completed.push(task);
            this.progress.failed = this.progress.failed.filter(t => t !== task);
            // fix47: clear blockers for this task when it passes
            this.progress.blockers = (this.progress.blockers || []).filter(b => b.task !== task);
            this._recordGoalOutcome(task, true, null);  // fix49: backoff tracking
            this._saveProgress();
            this.agent.openChat?.(`Done: ${task} (already satisfied: ${alreadySatisfied.reason}).`);
            this._afterSuccess();
            return;
        }
        console.log(`[voyager] goal "${task}" not yet satisfied: ${alreadySatisfied.reason}`);

        // fix55: a skill goal runs exactly that skill (never a different skill whose task text matches)
        const goalKind = this._resolveGoal(task);
        // fix56: an open goal is routed only by identity/parsed routes or by the embedding match (nearest skill among all candidates AND above
        // the learned replay threshold); never by lexical word overlap, which picks unrelated well-rated skills
        const route = goalKind.kind === 'skill' ? { name: goalKind.skill.name, call: `await ${goalKind.skill.name}(bot);` }
            : goalKind.kind === 'open' ? this._structuredReplay(task) || await this._embedReplay(task)
            : this._findReplay(task) || await this._embedReplay(task);   // fix28 (D): replay a matching learned skill before any code-model call
        let rp = route ? await this._replay(task, before, route) : null;
        if (route?.embed) this._learnReplayThreshold(rp);
        if (!rp?.ok && !rp?.interrupted) { const bc = await this._backchain(task, rp ? this.observe() : before); if (bc) rp = bc; }   // fix32 PSN backward chaining
        if (rp?.interrupted) { console.log('[voyager] task interrupted'); return; }
        if (rp?.ok) {
            this.progress.completed.push(task); this.progress.failed = this.progress.failed.filter(t => t !== task);
            // fix47: clear blockers for this task when it passes
            this.progress.blockers = (this.progress.blockers || []).filter(b => b.task !== task);
            this._recordGoalOutcome(task, true, null);  // fix49: backoff tracking
            this._saveProgress();
            this._subgoalDone(rp.name);
            this.agent.openChat?.(`Done: ${task} (replayed ${rp.name}).`);
            this._afterSuccess();
            return;
        }
        if (rp && !rp.ok && !rp.interrupted) { 
            this._recordGoalOutcome(task, false, rp.reason || 'replay failed');  // fix49: backoff tracking
            this.progress.failed.push(task); this._saveProgress(); this._windowCheck(false); 
        }
        // fix55: a skill goal is that skill; its failure is already blamed/queued for repair by _attribute, so no new code is written for it
        if (goalKind.kind === 'skill') { console.log(`[voyager] skill goal ${task} failed its learned post-contract; repair of the skill handles it (no code generation)`); return; }
        if (this._cursorLimited()) { console.log(`[voyager] skipped "${task}": needs new code but Cursor is at its limit (replay-only mode)`); return; }
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
        
        let system = await prompter.replaceStrings(prompter.profile.coding, [{ role: "user", content: `!newAction(${task})` }], prompter.coding_examples);
        // fix40: unified bare-name API - all functions called by bare name
        // fix47: use relevantBuiltIn instead of full API list
        const apiList = this.unifiedAPIList(shown, relevantBuiltIn);
        system += `\n\nVOYAGER MODE: write ONE reusable async function \`async function camelCaseName(bot) {...}\` that completes the task, then call it at the end with \`await camelCaseName(bot);\`.
The first line of the code block must be a comment: // DESCRIPTION: <one sentence of what the function does>.

AVAILABLE FUNCTIONS (call by bare name, e.g. goToPosition(bot, x, y, z) - do NOT use skills.* or world.* prefix):
${apiList}

IMPORTANT: All functions use bare names. Do NOT write skills.goToBlock or skills.goToPosition - write goToPosition(bot, x, y, z) directly. Do NOT write world.getNearestBlock - write getNearestBlock(bot, ...) directly.

COMPOSE: build your function out of these skills (they can take arguments). Your new skill may take extra parameters with defaults, e.g. \`async function makeIronTools(bot, count = 1)\`. Do not create call cycles between skills.${this.sharedHints?.length ? `
SHARED CODE: these fragments are repeated in several skills; if you need this logic, put it in its own small reusable async function skill (named, with parameters) and call it, instead of inlining it again:
${this.sharedHints.map(h => '// used in ' + h.skills.join(', ') + '\n' + h.fragment).join('\n')}` : ''}
Interrupts: the bot may be interrupted at any time (danger, getting stuck, a player talking). Every loop must start with \`if (bot.interrupt_code) return;\` and you must return immediately after any await when bot.interrupt_code is true. Every async function must contain an await. Never catch an error and keep looping; no unbounded loops (always cap attempts). There is no setTimeout/setInterval in scope; to wait use \`await sleep(ms)\`. findBlock/findBlocks/nearestEntity/bot.entities/blockAt results can be null or empty: always null-check them before reading .position/.x or calling methods on them.`;
        // define every library skill so calls to any known skill lint/run; only `related` are shown as context
        const learnedSrc = this.skills.map(s => s.code).join('\n\n');
        const ctx = related.slice(0, 3).map(s => `// ${s.description}\n${s.code}`).join('\n\n');   // fix32: full code for the top 3; the rest are signatures in the catalogue

        // fix37 (D): include inventory-full fact from replay failure in feedback for code gen
        // fix38: use extractFeedback to preserve FAILED lines
        let feedback = rp?.cut ? `Replay of ${rp.name} failed: ${rp.cut}\nExecution output:\n${extractFeedback(rp.output, 800)}${rp.invFullFact ? `\nInventory fact: ${rp.invFullFact}` : ''}` : '';
        let lastCode = '', anyCut = rp?.cut || '', prevCrit = null;
        // fix37: duplicate-reply detection state
        let prevReplyHash = null, consecutiveDupes = 0;
        for (let i = 1; i <= MAX_ATTEMPTS; i++) {
            if (this.abort) { console.log('[voyager] aborted for player'); return; }
            // fix37: escalating duplicate feedback (changes each time to nudge the model)
            const dupeEscalation = consecutiveDupes > 0 ? `\n\n!!! CRITICAL: Your previous ${consecutiveDupes} reply(ies) were IDENTICAL to the one before. You MUST write DIFFERENT code this time. The previous code did not work. Change your approach, use different skills, or try a simpler strategy. Repeating the same code will cause this task to fail. !!!` : '';
            // fix47: use compact state for efficient prompts (verbose state is available via _stateText if needed)
            const currentState = this.observe();
            const compactStateText = this._compactState(currentState);
            const user = `Task: ${task}\nHint: ${proposal.context || ''}\n${recipeFacts(task)}\n--- state (compact) ---\n${compactStateText}
--- learned skills you can call ---\n${ctx || '(none)'}
${lastCode ? `--- your previous code ---\n${lastCode}\n` : ''}${feedback ? `--- feedback from last attempt ---\n${feedback}\n` : ''}${dupeEscalation}Attempt ${i}/${MAX_ATTEMPTS}. Write the code block:`;
            // fix47: per-prompt breakdown logging
            if (i === 1) {
                this._logPromptBreakdown('code', {
                    system: system.length,
                    skills: ctx.length,
                    prelude: apiList.length,
                    state: compactStateText.length,
                    task: task.length + (proposal.context || '').length,
                    retry: 0
                });
                console.log(`[voyager] code prompt: ${shown.size} of ${this.skills.filter(s => !s.demoted).length} skills in the catalogue (relevant + deps), ${Math.min(3, related.length)} with source; prompt ${system.length + user.length} chars`);
            } else {
                // Log retry prompt size breakdown
                this._logPromptBreakdown('code-retry', {
                    system: system.length,
                    skills: ctx.length,
                    state: compactStateText.length,
                    history: lastCode.length,
                    retry: feedback.length
                });
            }
            const reply = await this._ask(system, user);
            // fix37: duplicate-reply detection - hash and compare to previous
            const replyHash = this._hashReply(reply);
            if (prevReplyHash !== null && replyHash === prevReplyHash) {
                consecutiveDupes++;
                console.log(`[duplicate] DETECTED: code model reply #${i} is identical to reply #${i - 1} (hash ${replyHash}, consecutive dupes: ${consecutiveDupes})`);
                if (consecutiveDupes >= 2) {
                    console.error(`[duplicate] ABORT: 2 consecutive duplicate replies; task "${task}" FAILED LOUDLY (code model is stuck)`);
                    this.progress.failed.push(`${task} (ABORTED: code model returned identical replies ${consecutiveDupes + 1} times)`);
                    this._saveProgress();
                    return;
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
            const libSkills = this.skills.filter(s => stageNameSet.has(s.name) && s.name !== own);
            const libSrc = libSkills.map(s => over[s.name] ?? s.code).join('\n\n');
            const traced = Voyager._tracedSkillNamesForInstrument(this, stageNameSet, over);
            const execBundle = libSrc + (libSrc ? '\n\n' : '') + instrumentSrc(traced) + '\n\n' + code;
            console.log(`[staging] voyager:writeCode task="${task}" attempt=${i} bundle=${execBundle.length} chars closure_skills=${stageNameSet.size}`);
            let lint = this.agent.coder.userGeneratedCodeLintBlockers(code, this.skills.map(s => s.name));
            let staged = null;
            if (!lint) {
                const { lint: lint2, staged: st } = await this._stageLintExec(execBundle, stageNameSet, `voyager:writeCode:${task}:att${i}`);
                lint = lint2;
                staged = st;
            }
            if (!lint && !staged) throw new Error('[psn] staging of traced generated code failed');
            if (lint) { console.log('[voyager] lint failed: ' + String(lint)); feedback = 'Lint error:\n' + lint; lastCode = code; continue; }

            this._runStart = Date.now();
            const res = await this._run(`voyager:${task}`, async () => {
                const bot = this._timedBotForSkillRun();
                bot.__psnALS = globalThis.__psnALS;
                await staged.func.main(bot);
            }, 5);
            console.log(`[timing] game action attempt ${i} took ${Date.now() - this._runStart}ms`);   // fix23: measurement
            if (this.abort) { console.log('[voyager] task interrupted'); return; }
            const cut = res.interrupted || this._diedInRun() || this._stalledInRun() ? this._interruptReason(res.message) : '';   // fix14: cut-off code counts as a failed attempt
            if (this._diedInRun()) this._noteDeath(this._diedInRun(), task);
            if (cut) anyCut = cut;
            if (cut) console.log(`[voyager] attempt ${i} ${cut}; counting as a failure`);
            const output = String(res.message || '').slice(-1500) + (cut ? `\n${cut}` : '');
            const after = this.observe();
            const goal = countGoal(task);
            const gained = goal ? gainedFor(goal, before, after) : 0;
            const verdict = cut ? { success: false, critique: `the attempt was ${cut}; it did not finish`, reasoning: 'cut off (critic skipped)' }   // fix23: a cut-off run is already a failure
                : (goal && gained >= goal.count)
                ? { success: true, critique: '', reasoning: `inventory +${gained} ${goal.item}` }
                : await this.critique(task, before, after, output, goal ? false : undefined);   // count goal not met by inventory -> ground truth false
            if (goal && gained >= goal.count) console.log(`[voyager] verified from inventory (+${gained} ${goal.item}), critic skipped`);
            console.log(`[voyager] attempt ${i} critic: success=${verdict.success} ${verdict.critique || ''}`);
            this._attribute(own, task, !!verdict.success, over);   // fix11 (B7)
            if (this._repairQueue?.some(x => x.target === own)) { console.log(`[psn] blame lands on the generated ${own} itself; the critic feedback loop fixes it (no library repair)`); this._repairQueue = this._repairQueue.filter(x => x.target !== own); }
            const same = !verdict.success && i >= 2 && prevCrit !== null && String(verdict.critique || '').trim() === prevCrit; prevCrit = String(verdict.critique || '').trim();   // fix32
            const lastTry = i >= MAX_ATTEMPTS || same || (!verdict.success && /travel|underground|died/.test(cut) && i >= 2);   // fix23: repeated travel cut-offs -> stop at 2 and decompose; fix32: unchanged critique -> stop
            if (this._decomposeQueue?.task === task && !lastTry) this._decomposeQueue = null;   // still iterating; decomposition decided after the last attempt
            if (verdict.success) {
                this._lastEffects = Object.keys(after.inventory).filter(k => (after.inventory[k] || 0) > (before.inventory[k] || 0)).slice(0, 8);
                await this.saveSkill(fn[1], desc.trim(), code.replace(/\n\s*await\s+\w+\(bot\);\s*$/, '').trim(), task);
                this.progress.completed.push(task);
                this.progress.failed = this.progress.failed.filter(t => t !== task);
                // fix47: clear blockers for this task when it passes
                this.progress.blockers = (this.progress.blockers || []).filter(b => b.task !== task);
                this._recordGoalOutcome(task, true, null);  // fix49: backoff tracking
                this._saveProgress();
                this._subgoalDone(fn[1]);
                // fix44: pass goal items to filter learned effects and produces (denoise)
                const goalItems = goal?.items || (goal?.item ? [goal.item] : null);
                { const e = this.skills.find(s => s.name === fn[1]); if (e && !e.candidate) this._learnEffects(e, before, after, goalItems); }
                // ADAM-style: record inventory delta for needs/produces learning
                this.npGraph.recordDelta(fn[1], before.inventory, after.inventory, goalItems);
                // AWM-style: extract workflow from multi-step trace
                const trace = this.agent.bot.__psnTrace;
                if (Array.isArray(trace) && trace.length >= 2) {
                    const steps = trace.filter(t => !t.name.startsWith('skills.')).map(t => t.name).slice(0, 8);
                    if (steps.length >= 2) {
                        this.repairMemory.recordWorkflow({ steps, task, outcome: true });
                    }
                }
                this.agent.openChat?.(`Done: ${task}. Learned skill ${fn[1]}.`);
                this._afterSuccess();
                return;
            }
            // fix37 (D): detect inventory-full when code gen fails
            const invFullFact = !verdict.success ? this._detectInventoryFullFailure(task, before, after, output) : null;
            if (invFullFact) console.log(`[voyager] attempt ${i} INVENTORY FULL DETECTED: ${invFullFact}`);

            feedback = `${cut ? `Attempt ${cut}\n` : ''}Execution output:\n${extractFeedback(output, 1500)}\nCritic: ${verdict.critique}${invFullFact ? `\nInventory fact: ${invFullFact}` : ''}\nChat/behaviour log: ${this.agent.bot.modes.flushBehaviorLog().slice(-400)}`;   // fix38: preserve FAILED lines
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
            const trace = this.agent.bot.__psnTrace;
            if (!trace) throw new Error('__psnTrace missing when recording failure');
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
        this._saveProgress();

        // fix19 (1): failed twice (recently) or cut off -> decompose
        const fails = this.progress.failed.slice(-20).filter(t => t === task).length;
        if (fails >= 2 || anyCut || this._decomposeQueue?.task === task) { if (this._decomposeQueue?.task === task) this._decomposeQueue = null; await this._decompose(task, anyCut || `failed ${fails}x; last critic: ${String(feedback).slice(-300)}${invFullReason}`); }
        else if (this._curSub?.parent) console.log(`[psn] subgoal "${task}" failed; moving on`);
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
        const block = getNearestBlock(bot, b => types.includes(b.name) && !excluded.has(posKey(b.position)), 64);
        if (!block) {
            if (excluded.size) log(bot, \`FAILED: no reachable \${blockType} nearby (\${excluded.size} unreachable block(s) excluded)\`);
            else log(bot, collected ? \`No more \${blockType} nearby.\` : \`No \${blockType} nearby.\`);
            break;
        }
        await bot.tool.equipForBlock(block);
        const itemId = bot.heldItem ? bot.heldItem.type : null;
        if (!block.canHarvest(itemId)) { log(bot, \`Don't have right tools to harvest \${blockType}.\`); return false; }
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
        deps: ['pickupNearbyItems'],
    },
    {
        name: 'craftRecipe',
        description: 'Craft an item using the crafting recipe. Places and retrieves crafting table if needed.',
        task: 'craft an item',
        // fix42: retry placing crafting_table at multiple cells (no same-cell reuse on failure)
        code: `async function craftRecipe(bot, itemName, num = 1) {
    if (!itemName) { log(bot, 'craftRecipe: no item specified'); return false; }
    let recipes = bot.recipesFor(bot.registry.itemsByName[itemName]?.id, null, 1, null);
    let craftingTable = null, placedTable = false;
    if (!recipes || !recipes.length) {
        recipes = bot.recipesFor(bot.registry.itemsByName[itemName]?.id, null, 1, true);
        if (!recipes || !recipes.length) { log(bot, \`No recipe for \${itemName} or missing ingredients.\`); return false; }
        craftingTable = getNearestBlock(bot, 'crafting_table', 16);
        if (!craftingTable) {
            // fix51: call ensureCraftingTable to get/craft/place a table (fail loud if can't)
            const ensured = await ensureCraftingTable(bot);
            if (!ensured) { log(bot, \`FAILED: craftRecipe(\${itemName}) needs a crafting table but ensureCraftingTable failed\`); return false; }
            craftingTable = getNearestBlock(bot, 'crafting_table', 16);
            if (!craftingTable) { log(bot, \`FAILED: ensureCraftingTable returned true but no table found\`); return false; }
            placedTable = true;
        }
        if (craftingTable) recipes = bot.recipesFor(bot.registry.itemsByName[itemName]?.id, null, 1, craftingTable);
    }
    if (!recipes || !recipes.length) { log(bot, \`Cannot craft \${itemName}: missing ingredients.\`); if (placedTable) await collectBlock(bot, 'crafting_table', 1); return false; }
    // fix51: navigate to within reach of the crafting table, verify reachability before crafting
    if (craftingTable) {
        const reached = await goToPosition(bot, craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 3);
        if (!reached) { log(bot, \`FAILED: craftRecipe(\${itemName}) could not reach crafting table\`); if (placedTable) await collectBlock(bot, 'crafting_table', 1); return false; }
        const dist = bot.entity.position.distanceTo(craftingTable.position);
        if (dist > 4) { log(bot, \`FAILED: craftRecipe(\${itemName}) crafting table out of reach at distance \${dist.toFixed(1)}\`); if (placedTable) await collectBlock(bot, 'crafting_table', 1); return false; }
        if (!bot.canSeeBlock(craftingTable)) { log(bot, \`FAILED: craftRecipe(\${itemName}) no line of sight to crafting table at \${craftingTable.position}\`); if (placedTable) await collectBlock(bot, 'crafting_table', 1); return false; }
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
        // fix49: uses equipBestTool (inventory only, no crafting) to avoid dep cycle
        // Obtaining a missing tool is the planner's job via harvestTools decompose
        code: `async function breakBlockAt(bot, x, y, z) {
    if (x == null || y == null || z == null) { log(bot, 'breakBlockAt: invalid coordinates'); return false; }
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) { log(bot, \`breakBlockAt: blockAt(\${x}, \${y}, \${z}) returned null (unloaded chunk?)\`); return false; }
    if (block.name === 'air' || block.name === 'water' || block.name === 'lava') {
        log(bot, \`No solid block at \${x}, \${y}, \${z}.\`); return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        await goToPosition(bot, block.position.x, block.position.y, block.position.z, 4);
    }
    if (bot.game.gameMode !== 'creative') {
        // fix49: equip from inventory only (no crafting) - use equipBestTool for type needed
        // mineflayer-tool's equipForBlock can craft, creating dep cycles
        const harvestTools = block.harvestTools;
        if (harvestTools) {
            const toolTypes = ['pickaxe', 'axe', 'shovel', 'hoe'];
            for (const tt of toolTypes) {
                const equipped = await equipBestTool(bot, tt);
                if (equipped && block.canHarvest(bot.heldItem?.type)) break;
            }
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null;
        if (!block.canHarvest(itemId)) { log(bot, \`FAILED: Don't have right tools to break \${block.name}. Need one of: \${Object.keys(harvestTools || {}).join(', ') || 'any tool'}\`); return false; }
    }
    await bot.dig(block, true);
    log(bot, \`Broke \${block.name} at \${x.toFixed(1)}, \${y.toFixed(1)}, \${z.toFixed(1)}.\`);
    return true;
}`,
        deps: ['equipBestTool'],
    },
    {
        name: 'pickupNearbyItems',
        description: 'Pick up all nearby dropped items within 8 blocks. Waits for drops to settle first.',
        task: 'pick up items',
        code: `async function pickupNearbyItems(bot) {
    const distance = 8;
    await sleep(400);
    const getNearestItem = () => bot.nearestEntity(e => e.name === 'item' && bot.entity.position.distanceTo(e.position) < distance);
    let nearestItem = getNearestItem();
    let pickedUp = 0;
    for (let tries = 0; nearestItem && tries < 12; tries++) {
        try { await goToPosition(bot, nearestItem.position.x, nearestItem.position.y, nearestItem.position.z, 0.5); }
        catch (e) { log(bot, \`Failed to reach item: \${e.message}\`); throw e; }
        await sleep(500);
        const prev = nearestItem;
        nearestItem = getNearestItem();
        if (prev === nearestItem && prev.isValid) break;
        pickedUp++;
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
        // fix42: tossClutter uses LEARNED signals only - no hard-coded junk list
        // Consults bot.__safeToToss (set by voyager before skill runs) for items safe to toss
        // fix43: tossClutter uses POSITIVE learned signals only - unknown items NOT auto-tossed
        // Fail loud if no learned signal, or if deposit prerequisite (chest) missing
        name: 'tossClutter',
        description: 'Toss surplus/low-value items to free inventory space using LEARNED signals (needs/produces, not hard-coded lists). If toss is insufficient, calls depositToChest. Fails loud if nothing is safe to toss/deposit or if chest prerequisite missing.',
        task: 'toss clutter to free inventory space',
        code: `async function tossClutter(bot, minFree = 4) {
    const start = bot.entity.position.clone();
    let tossed = 0;
    let depositedTotal = 0;
    // fix51: fail loud if signals not initialized (no fallback)
    if (!Array.isArray(bot.__safeToToss)) {
        log(bot, 'FAIL LOUD: bot.__safeToToss not initialized (voyager._prepareTossSignals not called before tossClutter)');
        return false;
    }
    if (!Array.isArray(bot.__depositCandidates)) {
        log(bot, 'FAIL LOUD: bot.__depositCandidates not initialized');
        return false;
    }
    if (!Array.isArray(bot.__uncertainItems)) {
        log(bot, 'FAIL LOUD: bot.__uncertainItems not initialized');
        return false;
    }
    const safeList = bot.__safeToToss;
    const depositList = bot.__depositCandidates;
    const uncertainList = bot.__uncertainItems;
    
    // Phase 1: toss safe items (items with POSITIVE learned producer signal + surplus)
    if (safeList.length) {
        const inv = getInventoryCounts(bot);
        for (let i = 0; i < 40 && bot.inventory.emptySlotCount() < minFree; i++) {
            if (bot.interrupt_code) break;
            const pick = safeList.find(n => (inv[n] || 0) > 0);
            if (!pick) break;
            const it = bot.inventory.items().find(x => x.name === pick);
            if (!it) { inv[pick] = 0; continue; }
            if (bot.currentWindow) {
                const win = bot.currentWindow;
                bot.closeWindow(win);
                await new Promise(resolve => {
                    const onClose = (w) => { if (!w || w === win) { bot.off('windowClose', onClose); resolve(); } };
                    bot.on('windowClose', onClose);
                });
            }
            await bot.tossStack(it);
            inv[pick] = Math.max(0, (inv[pick] || 0) - it.count);
            tossed++;
            console.log(\`[toss] tossed \${it.count} \${pick} (empty slots now \${bot.inventory.emptySlotCount()})\`);
        }
        if (tossed && !bot.interrupt_code) {
            await moveAway(bot, 6);
            console.log(\`[toss] moved away from \${tossed} dropped stack(s) to avoid re-pickup\`);
        }
    }
    
    // Phase 2: if still low on space, try depositToChest
    if (bot.inventory.emptySlotCount() < minFree && !bot.interrupt_code) {
        // fix43: check for chest FIRST and fail loud with PREREQUISITE if missing
        const chest = getNearestBlock(bot, b => /chest|barrel|shulker/.test(b.name), 32);
        if (!chest) {
            if (depositList.length || (bot.inventory.emptySlotCount() < 2 && uncertainList.length)) {
                log(bot, \`PREREQUISITE FAILED: tossClutter needs chest within 32 blocks to deposit items (have \${depositList.length} deposit candidates, \${uncertainList.length} uncertain items). Place or find a chest first.\`);
                return false;
            }
        } else if (depositList.length) {
            console.log(\`[toss] still only \${bot.inventory.emptySlotCount()} empty after tossing \${tossed} stacks; depositing \${depositList.length} candidate(s) to chest at \${chest.position}\`);
            let deposited = 0;
            let depositFailed = false;
            for (const itemName of depositList) {
                if (bot.interrupt_code) break;
                if (bot.inventory.emptySlotCount() >= minFree) break;
                const ok = await depositToChest(bot, itemName);
                if (ok) deposited++;
                else depositFailed = true;
            }
            depositedTotal = deposited;
            if (deposited) console.log(\`[toss] deposited \${deposited} item type(s) to chest (empty slots now \${bot.inventory.emptySlotCount()})\`);
            if (bot.inventory.emptySlotCount() < minFree && !bot.interrupt_code) {
                if (depositFailed) {
                    log(bot, \`FAILED tossClutter: deposit to chest failed - chest may be full or inaccessible.\`);
                } else {
                    log(bot, \`FAILED tossClutter: still only \${bot.inventory.emptySlotCount()} empty after tossing \${tossed} + depositing \${deposited} items\`);
                }
            }
        }
    }
    
    // fix43: if we couldn't free space and have uncertain items, surface this for model/planning
    // fix51: return false when failing to meet minFree, so postcondition skip (r.rv === false) works
    if (bot.inventory.emptySlotCount() < minFree && !bot.interrupt_code) {
        if (uncertainList.length && !safeList.length) {
            log(bot, \`FAILED tossClutter: \${uncertainList.length} item(s) have NO learned producer signal (\${uncertainList.slice(0,3).join(', ')}\${uncertainList.length > 3 ? '...' : ''}) - cannot auto-toss unknown items. Return decision to model/planning.\`);
        } else if (!safeList.length && !depositList.length) {
            log(bot, 'FAILED tossClutter: no learned signal indicates what is safe to toss/deposit');
        }
        return false;  // fix51: explicit failure so postcondition isn't evaluated
    }
    // fix51: return stacks removed (0 when space was already free) so a truthy ret always means inventory shrank (seeded post)
    return tossed + depositedTotal;
}`,
        deps: ['moveAway', 'depositToChest'],
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
        
        // fix47: if can't craft, try to craft missing ingredients (generic: no hard-coded names/ratios)
        if (!canCraft && !hasTable && allRecipes.length) {
            const tableRecipe = allRecipes[0];
            const ingredients = tableRecipe.delta?.filter(d => d.count < 0) || [];
            
            for (const ing of ingredients) {
                const ingItem = bot.registry.items[ing.id];
                if (!ingItem) continue;
                const have = inv[ingItem.name] || 0;
                const need = Math.abs(ing.count);
                if (have >= need) continue;
                
                const shortfall = need - have;
                // Find a 2x2 recipe (no table) that produces this ingredient
                const ingRecipes = bot.recipesAll(ingItem.id, null, null);
                let crafted = false;
                
                for (const ingRecipe of ingRecipes) {
                    // Check if we have the ingredients for this recipe
                    const subIngs = ingRecipe.delta?.filter(d => d.count < 0) || [];
                    const canCraftIng = subIngs.every(sub => {
                        const subItem = bot.registry.items[sub.id];
                        return subItem && (inv[subItem.name] || 0) >= Math.abs(sub.count);
                    });
                    
                    if (canCraftIng) {
                        // Compute how many times to craft based on recipe output
                        if (!ingRecipe.result?.count) { log(bot, \`FAILED: ensureCraftingTable - recipe for \${ingItem.name} has no result.count\`); return false; }
                        const resultCount = ingRecipe.result.count;
                        const craftTimes = Math.ceil(shortfall / resultCount);
                        
                        console.log(\`[ensureCraftingTable] crafting \${craftTimes}x \${ingItem.name} (produces \${resultCount} each)...\`);
                        await bot.craft(ingRecipe, craftTimes, null);
                        inv = getInventoryCounts(bot);
                        crafted = true;
                        break;
                    }
                }
                
                if (!crafted && shortfall > 0) {
                    // fix51: fail loud with structured prerequisite info for decomposition/needs-produces
                    bot.__prereqFail = { item: ingItem.name, need: shortfall + (inv[ingItem.name] || 0), have: inv[ingItem.name] || 0 };
                    log(bot, \`PREREQUISITE FAILED: ensureCraftingTable needs \${shortfall} more \${ingItem.name} but cannot craft it (no 2x2 recipe or missing sub-ingredients). Decompose to obtain \${ingItem.name} first.\`);
                    return false;
                }
            }
            
            // Retry table craft after ingredients
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
        }
        
        // FAIL loud if still can't craft - provide prerequisite info for decomposition
        if (!canCraft && !hasTable) {
            inv = getInventoryCounts(bot);
            const missingIngredients = [];
            const recipe = allRecipes[0];
            const ingredients = recipe.delta?.filter(d => d.count < 0) || [];
            for (const ing of ingredients) {
                const ingItem = bot.registry.items[ing.id];
                if (ingItem) {
                    const have = inv[ingItem.name] || 0;
                    const need = Math.abs(ing.count);
                    if (have < need) {
                        if (!bot.__prereqFail) bot.__prereqFail = { item: ingItem.name, need, have };
                        missingIngredients.push(\`\${ingItem.name} (need \${need}, have \${have})\`);
                    }
                }
            }
            log(bot, \`PREREQUISITE FAILED: ensureCraftingTable cannot craft - missing: \${missingIngredients.join(', ')}. Decompose to obtain prerequisites.\`);
            return false;
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
    {
        name: 'equipBestTool',
        description: 'Equip the best tool of toolType (pickaxe, axe, sword, shovel, hoe) in the inventory; returns the item name or null.',
        task: 'equip a tool',
        code: `async function equipBestTool(bot, toolType = 'pickaxe') {
    const tiers = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
    const inv = getInventoryCounts(bot);
    for (const t of tiers) {
        const name = \`\${t}_\${toolType}\`;
        if (inv[name]) {
            await bot.equip(bot.inventory.items().find(it => it.name === name), 'hand');
            return name;
        }
    }
    return null;
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
];
