import { wordOverlapScore } from '../utils/text.js';
// Voyager-style lifelong learning loop (after MineDojo/Voyager):
// automatic curriculum -> iterative code generation with env feedback -> self-verification critic -> skill library.
import { AsyncLocalStorage } from 'async_hooks';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from 'fs';
// fix14: crash-safe writes (tmp file + rename)
export function writeAtomic(fp, text) { const tmp = `${fp}.tmp-${process.pid}`; writeFileSync(tmp, text); renameSync(tmp, fp); }
import * as world from './library/world.js';
import * as skills from './library/skills.js';
import { makeCompartment } from './library/lockdown.js';
import { getAllItems, getAllBlocks, getItemCraftingRecipes, isHostile, isDatapackHostile } from '../utils/mcdata.js';
import { cosineSimilarity } from '../utils/math.js';
import minecraftData from 'minecraft-data';
import { Ollama } from '../models/ollama.js';
import { signatureOf, depsOf, missingCalls, findCycle, newStats, recordRun, rate, gateLog, instrumentSrc, annotateTrace, traceText, blame, blameAll, parentsOf } from './skill_graph.js';
const LOCAL = { model: 'qwen3:4b-instruct-2507-q4_K_M', url: 'http://192.168.1.215:11434', params: { format: 'json', options: { num_ctx: 8192 } } };
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
const TASK_COOLDOWN_MS = 90 * 1000;  // gap between curriculum tasks (saves Gemini quota)
const HUT = { get x() { return HOME.x; }, get y() { return HOME.y + 1; }, get z() { return HOME.z; } };   // HUT.y - 1 = floor/feet level (interior HOME±2, walls at ±3)
// PSN-style progression milestones (after skillnet/domains/minecraft/knowledge get_progression_milestones), extended for survival/town
const MILESTONES = [
    { name: 'get_wood', items: { birch_log: 4 } },
    { name: 'wooden_tools', items: { wooden_pickaxe: 1, wooden_axe: 1 } },
    { name: 'stone_tools', items: { stone_pickaxe: 1, stone_axe: 1, stone_sword: 1, cobblestone: 16 } },
    { name: 'furnace', items: { furnace: 1 }, block: 'furnace' },
    { name: 'coal_torches', items: { coal: 8, torch: 8 } },
    { name: 'iron_ready', items: { raw_iron: 8 } },
    { name: 'iron_tools', items: { iron_pickaxe: 1, iron_sword: 1 } },
    { name: 'iron_armor', items: { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 } },
    { name: 'bucket', items: { bucket: 1 } },
    { name: 'diamond_found', items: { diamond: 3 } },
    { name: 'diamond_tools', items: { diamond_pickaxe: 1 } },
];

// tolerant JSON: strip fences, fix stray backslashes / trailing commas, then fall back to field regexes
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
function countGoal(task) {
    const m = task.match(/^(mine|collect|gather|craft|smelt|obtain|get|chop|cook)\s+(\d+)\s+([a-z_]+)\b/i);
    if (!m) return null;
    const verb = m[1].toLowerCase();
    let item = m[3].toLowerCase();
    // plural item names from the curriculum ("torches", "sticks") -> registry id
    { const irr = { torches: 'torch' }; if (irr[item]) item = irr[item];
      else { try { const md = minecraftData(VERSION || '1.20.4'); if (!md.itemsByName[item] && item.endsWith('s') && md.itemsByName[item.slice(0, -1)]) item = item.slice(0, -1); } catch (e) {} } }
    // mining a block counts its loot drops too (iron_ore -> raw_iron, coal_ore -> coal, stone -> cobblestone)
    let items = [item];
    if (['mine', 'collect', 'gather', 'chop', 'get', 'obtain'].includes(verb)) {
        try { const md = minecraftData(VERSION || '1.20.4'); for (const d of (md.blockLoot?.[item]?.drops || [])) if (!items.includes(d.item)) items.push(d.item); } catch (e) {}
    }
    return { count: parseInt(m[2]), item, items, verb };
}
let VERSION = null;
// "Smelt 6 raw_iron into 6 iron_ingot" -> verify by output gained
function smeltGoal(task) {
    const m = task.match(/^(?:smelt|cook)\s+(\d+)\s+([a-z_]+)\s+into\s+(\d+)\s+([a-z_]+)/i);
    return m ? { count: parseInt(m[1]), input: m[2].toLowerCase(), verb: 'smelt', item: m[4].toLowerCase(), items: [m[4].toLowerCase()] } : null;
}
function gainedFor(goal, before, after) {
    return goal.items.reduce((a, it) => a + (after.inventory[it] || 0) - (before.inventory[it] || 0), 0);
}
function extractCode(text) {
    const m = String(text).match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
    return m ? m[1].trim() : null;
}

export class Voyager {
    constructor(agent) {
        this.agent = agent;
        this.dir = `./bots/${agent.name}/skills`;
        mkdirSync(this.dir, { recursive: true });
        this.indexFile = `${this.dir}/index.json`;
        this.progressFile = `${this.dir}/progress.json`;
        this.skills = existsSync(this.indexFile) ? JSON.parse(readFileSync(this.indexFile, 'utf8')) : [];
        this.progress = existsSync(this.progressFile) ? JSON.parse(readFileSync(this.progressFile, 'utf8'))
            : { completed: [], failed: [], enabled: true };
        this.running = false;
        this.abort = false;
        this.lastPlayerMsg = 0;
        this.lastTaskEnd = 0;
        if (!globalThis.__voyagerGuard) {
            globalThis.__voyagerGuard = true;
            const onErr = (kind) => (err) => {
                const t = this.currentTask || '(no task)';
                console.error(`[voyager] !!! ${kind} during task "${t}" - counted as FAILED, process kept alive: ${err?.stack || err}`);
                if (this.currentTask) { this.progress.failed.push(this.currentTask); this._saveProgress(); }
                try { this.agent.bot.interrupt_code = true; this.agent.actions.stop?.(); } catch (e) {}
            };
            process.on('uncaughtException', onErr('UNCAUGHT EXCEPTION'));
            process.on('unhandledRejection', onErr('UNHANDLED REJECTION'));
        }
        this._relink();
        this._polyMerge();
        this._extractShared();
    }
    // fix11: recompute every skill's dependency edges from its code at startup (catches hand edits of skill files)
    _relink() {
        const names = new Set(this.skills.map(s => s.name)); let n = 0;
        for (const s of this.skills) {
            const d = depsOf(s.code, s.name, names);
            if (JSON.stringify([...d].sort()) !== JSON.stringify([...(s.deps || [])].sort())) { console.log(`[psn] relink ${s.name}: deps [${(s.deps || []).join(', ')}] -> [${d.join(', ')}]`); s.deps = d; n++; }
        }
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
            const g = countGoal(s.task);
            let valid = true; try { valid = !g || !!minecraftData(VERSION || '1.20.4').itemsByName[g.item] || !!minecraftData(VERSION || '1.20.4').blocksByName[g.item]; } catch (e) {}
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
    _maturity(e) { const s = e.stats || newStats(), n = s.success + s.fail; const V = (s.success + 1) / (n + 2); const p = (1 - 0.1) / (1 + Math.exp(-10 * (0.6 - V))) + 0.1; return { V, p, n }; }
    _updateAllowed(e, why) { const { V, p, n } = this._maturity(e), r = Math.random(), ok = r < p; gateLog(`maturity ${e.name}: V=${V.toFixed(2)} (${n} runs) P(update)=${p.toFixed(2)} draw=${r.toFixed(2)} -> ${ok ? 'UPDATE ALLOWED' : 'FROZEN (mature skill kept)'} [${why}]`); return ok; }
    // fix20 (PSN repair memory): rolling buffer of the last 5 repair proposals per skill
    _noteProposal(e, p) { e.repairHistory = [...(e.repairHistory || []), { at: new Date().toISOString(), ...p }].slice(-5); this._saveSkills(); }
    _proposalOutcome(e, outcome) { const h = e.repairHistory; if (h?.length && !h[h.length - 1].outcome) { h[h.length - 1].outcome = outcome; } }
    // ---------- fix22: learned skill contracts (PSN pre/postconditions) ----------
    // Each library skill carries { pre, post, text }: JS predicates over c = { args, ret, pre, post, delta } learned by the code model
    // from the skill's description, code and observed effects; evaluated after every traced call against real bot state.
    static CONTRACT_SPEC = `A contract is two JavaScript arrow functions over one argument c, each returning true when satisfied:
  c.args  = the call's arguments after bot (numbers/strings; objects are null)
  c.ret   = the call's return value (primitive, or null for objects)
  c.pre / c.post = bot state before / after the call: { pos:{x,y,z}, hp (0-20), food (0-20), sky (sky light 0-15 at head height; 0 = underground or enclosed), alive (bool), dim (dimension string), inv:{item:count} }
  c.delta = inventory change {item: +n/-n}
  c.dist(a, b) = euclidean distance between two {x,y,z}
pre: what must hold before the call for it to be able to succeed (use "c => true" if nothing).
post: what the call promises afterwards when it reports success (state the observable effect: arrived near target, item gained, still alive, not stranded underground, etc.). If the call returns false/null it already reported failure, so post may return true in that case.
Use only c; no other globals.`;
    _compileContract(src) { const f = makeCompartment({}).evaluate(`(${src})`); if (typeof f !== 'function') throw new Error('not a function'); return f; }
    _validContract(ct) {
        if (!ct || typeof ct.post !== 'string' || typeof ct.pre !== 'string') return 'missing pre/post string';
        const s = { pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, sky: 15, alive: true, dim: 'overworld', inv: {} };
        const c = { args: [0, 64, 0, 'x', 1], ret: true, pre: s, post: s, delta: {}, dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) };
        try { for (const k of ['pre', 'post']) { const r = this._compileContract(ct[k])(c); if (typeof r !== 'boolean') return `${k} returned ${typeof r}, not boolean`; } } catch (e) { return `throws: ${e.message}`; }
        return null;
    }
    // evaluate contracts on every traced library call; violations become contract failures in the trace
    _checkContracts(trace, taskOk) {
        const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        for (const r of trace) {
            if (r.intr || !r.s0 || !r.s1) continue;
            const e = this.skills.find(s => s.name === r.name);
            if (!e?.contract) continue;
            const c = { args: r.argv || [], ret: r.rv, pre: r.s0, post: r.s1, delta: r.delta || {}, dist };
            for (const k of ['pre', 'post']) {
                let ok;
                try { ok = this._compileContract(e.contract[k])(c); }
                catch (err) { console.log(`!!! [contract] ${e.name}.${k} THREW: ${err.message}; queued contract repair`); this._queueContractFix(e, `${k} threw: ${err.message}`); continue; }
                if (ok !== false) continue;
                if (k === 'pre' && !r.fail && r.rv !== false && r.rv !== null) { console.log(`[contract] ${e.name} precondition violated but the call succeeded -> precondition is wrong; queued contract repair`); this._queueContractFix(e, `precondition ${e.contract.pre} was false but the call succeeded (ret ${r.ret})`); continue; }
                r.ok = false; r.fail = true; if (k === 'pre') r.preFail = true;
                r.ownFail = [...(r.ownFail || []), `${k === 'pre' ? 'PRECONDITION' : 'POSTCONDITION'} violated: ${e.contract.text || e.contract[k]} (post pos ${r.s1.pos ? [r.s1.pos.x, r.s1.pos.y, r.s1.pos.z].map(Math.round).join(',') : '?'}, sky ${r.s1.sky}, alive ${r.s1.alive})`];
                console.log(`[contract] ${e.name}(${(r.argv || []).join(',')}) ${k}condition VIOLATED: ${e.contract[k].slice(0, 160)}`);
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
    async _learnContracts(ents, why, fixNote = '') {
        const system = `You write PSN skill contracts for a Minecraft mineflayer skill library.\n${Voyager.CONTRACT_SPEC}\nReply ONLY with JSON: {"<skillName>": {"pre": "c => ...", "post": "c => ...", "text": "<one-line contract summary>"}, ...} for exactly the skills given.`;
        const user = ents.map(e => `--- ${e.name} ---\ndescription: ${e.description}\nobserved effects: ${JSON.stringify(e.effects || [])}\n${e.contract ? `current contract (${fixNote || 'to fix'}): ${JSON.stringify(e.contract)}\n` : ''}code:\n${String(e.code).slice(0, 1800)}`).join('\n');
        console.log(`[contract] learning contracts for ${ents.length} skill(s) (${why}): ${ents.map(e => e.name).join(', ')}`);
        let out; try { out = parseJSON(await this._ask(system, user)); } catch (err) { console.log(`[contract] learning FAILED: ${err.message}`); return 0; }
        let n = 0;
        for (const e of ents) {
            const ct = out?.[e.name], bad = this._validContract(ct);
            e.contractTried = Date.now();
            if (bad) { console.log(`[contract] FAILED for ${e.name}: ${bad}`); continue; }
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
    _saveSkills() { writeAtomic(this.indexFile, JSON.stringify(this.skills, null, 2)); }
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
    _diedInRun() { const d = this.agent.lastDeath; return d && d.t >= (this._runStart || Infinity) ? d : null; }
    _interruptReason(output = '') {
        const died = this._diedInRun();
        if (died) return `died: ${died.message} at ${died.pos}`;
        const bot = this.agent.bot, p = bot.entity.position, by = this.agent.actions.lastInterruptBy || 'unknown';
        const s = this._surfaceY(p.x, p.z), under = s !== null && p.y < s - 4;
        const travelling = /travelTo|goToPosition|goToSurface|path|Moving|travell/i.test(String(output).slice(-800));
        const what = by === 'mode:unstuck' ? 'stuck' : `cut off by ${by}`;
        return `interrupted: ${what}${travelling ? ' while travelling' : ''}${under ? ` (underground: y=${Math.floor(p.y)}, surface y=${s})` : ''}`;
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

    update() {
        if (!this.enabled || this.running) return;
        const now = Date.now();
        if (now - this.lastPlayerMsg < PLAYER_QUIET_MS || now - this.lastTaskEnd < TASK_COOLDOWN_MS) return;
        if (!this.agent.isIdle() || this.agent.self_prompter.isActive() || this.agent.prompter.awaiting_coding) return;
        if (false && now < (this.agent.prompter.code_model.quotaUntil || 0)) {
            if (!this._quotaNoted) { console.log(`[voyager] paused: code model (${this.agent.prompter.code_model.pName}) quota/usage limit; retrying at ${new Date(this.agent.prompter.code_model.quotaUntil).toISOString()}`); this._quotaNoted = true; }
            return;
        }
        this._quotaNoted = false;
        this.running = true; this.abort = false;
        this.step().catch(e => {
            console.error('[voyager] step failed: ' + (e?.message ?? e));
        }).finally(() => { this.running = false; this.lastTaskEnd = Date.now(); });
    }

    observe() {
        const bot = this.agent.bot;
        const p = bot.entity.position;
        const dTown = Math.round(Math.hypot(p.x - TOWN.x, p.z - TOWN.z));
        const t = bot.time.timeOfDay;
        return {
            position: `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`,
            distance_to_town: dTown,
            biome: world.getBiomeName(bot),
            time: t < 12000 ? `day (${t})` : t < 13000 ? `dusk (${t}, hostiles about to spawn)` : t < 23000 ? `night (${t}, hostiles spawn outdoors)` : `dawn (${t})`,
            health: `${Math.round(bot.health)}/20`, food: `${bot.food}/20`,
            inventory: world.getInventoryCounts(bot),
            equipped: bot.heldItem ? bot.heldItem.name : 'nothing',
            nearby_blocks: world.getNearbyBlockTypes(bot, 16),
            nearby_entities: world.getNearbyEntityTypes(bot),
            empty_inventory_slots: bot.inventory.emptySlotCount(),
            threats: this._threats(),
            recent_deaths: (this.agent.recentDeaths || []).join('; ') || 'none',
            death_hotspots: this._deathHotspots(),
        };
    }
    // fix19 (6): places where the bot died 2+ times (16-block cells): a problem for the curriculum to learn to handle, no reflex
    _deathHotspots() {
        const hs = Object.values(this.progress.deathSpots || {}).filter(c => c.n >= 2).map(c => ({ ...c, hot: !!this._hotCell({ x: +c.pos.split(',')[0], z: +c.pos.split(',')[2] }) })).sort((a, b) => b.n - a.n).slice(0, 3);
        return hs.length ? hs.map(c => `${c.n} deaths near ${c.pos} (${c.causes.slice(-2).join('; ')}) during "${c.tasks.slice(-1)[0] || 'idle'}"${c.hot ? ' [ACTIVE: tasks targeting/crossing it are rejected, entering it fails the running skill]' : ''}`).join(' | ') + ' -> propose a task that learns to survive/avoid this' : 'none';
    }
    // fix26: death hotspots decay by count and time (no fixed cooldown): weight = sum over deaths of 0.5^(age/6h); hot when n>=3 and weight>=1.5
    _cellKey(p) { return `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`; }
    _hotCell(p) {
        if (!p || !Number.isFinite(p.x)) return null;
        const c = (this.progress.deathSpots || {})[this._cellKey(p)]; if (!c || c.n < 3) return null;
        const ts = c.times?.length ? c.times : Array(c.n).fill(c.last ?? Date.now());
        const w = ts.reduce((a, t) => a + Math.pow(0.5, (Date.now() - t) / (6 * 3600e3)), 0) + Math.max(0, c.n - ts.length) * Math.pow(0.5, (Date.now() - (c.last ?? Date.now())) / (6 * 3600e3));
        return w >= 1.5 ? { ...c, w } : null;
    }
    _hsText(c) { return `${c.n} deaths near ${c.pos}: ${c.causes.slice(-2).join('; ')}; weight ${c.w.toFixed(1)}`; }
    // first hot cell on the straight route a->b (8-block samples), excluding the start cell
    _hotOnRoute(a, b) {
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 8)), k0 = this._cellKey(a);
        for (let i = 1; i <= n; i++) { const p = { x: a.x + (b.x - a.x) * i / n, z: a.z + (b.z - a.z) * i / n }; if (this._cellKey(p) === k0) continue; const c = this._hotCell(p); if (c) return c; }
        return null;
    }
    // fix26: a task is checked against the resolved target (explicit coords, else home if it says home), the route there, and the bot's own position
    _hotspotOf(task) {
        const m = String(task).match(/(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/), m2 = !m && String(task).match(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/);
        const tgt = m ? { x: +m[1], z: +m[3] } : m2 ? { x: +m2[1], z: +m2[2] } : /\bhome\b|\bhut\b|\bbase\b/i.test(task) ? { x: HOME.x, z: HOME.z } : null;
        const me = this.agent.bot?.entity?.position, here = me ? { x: me.x, z: me.z } : null;
        let c = tgt && this._hotCell(tgt);
        if (c) return `its target (${tgt.x}, ${tgt.z}) is in a death hotspot (${this._hsText(c)}); choose a goal away from there or one that first learns to survive it from a safe distance`;
        if (tgt && here && (c = this._hotOnRoute(here, tgt))) return `the route from the bot (${Math.round(here.x)}, ${Math.round(here.z)}) to its target (${tgt.x}, ${tgt.z}) crosses a death hotspot (${this._hsText(c)}); choose a goal reachable without crossing it`;
        if (here && (c = this._hotCell(here)) && !tgt) return `the bot is standing in a death hotspot (${this._hsText(c)}) and the task has no explicit target; give a task with explicit x, y, z coordinates outside that area`;
        return null;
    }
    _noteDeath(d, task) {
        const [x, y, z] = d.pos.split(',').map(Number), k = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
        const c = ((this.progress.deathSpots ||= {})[k] ||= { n: 0, pos: d.pos, causes: [], tasks: [] });
        c.n++; c.last = Date.now(); c.times = [...(c.times || []), c.last].slice(-20); c.pos = d.pos; c.causes = [...c.causes, d.message].slice(-5); c.tasks = [...c.tasks, task].slice(-5); this._saveProgress();
        console.log(`[psn] death during "${task}": ${d.message} at ${d.pos} (death #${c.n} in this area)${c.n >= 2 ? '; surfaced to the curriculum as a death hotspot' : ''}`);
    }
    // fix18: perception only (no policy): hostiles within 32 blocks, nearest first
    _threats() {
        const bot = this.agent.bot, p = bot.entity.position;
        const hs = Object.values(bot.entities).filter(e => e !== bot.entity && (isHostile(e) || isDatapackHostile(e)) && e.position.distanceTo(p) < 32)
            .map(e => `${isDatapackHostile(e) ? 'DATAPACK ' : ''}${e.name || e.username} ${e.position.distanceTo(p).toFixed(0)}m`);
        return hs.length ? hs.slice(0, 6).join(', ') : 'none';
    }
    _stateText(s) {
        return Object.entries(s).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
    }
    _local() {
        if (!this.__local) this.__local = new Ollama(LOCAL.model, LOCAL.url, { ...LOCAL.params, keep_alive: this.agent.prompter.profile.model?.params?.keep_alive });
        return this.__local;
    }
    // small local model (Mac Studio Ollama) for curriculum + critic judgment; unloads after 5 min idle
    async _askLocal(system, user) {
        CALLS.local++;
        const r = await this._local().sendRequest([{ role: 'user', content: user }], system);
        console.log(`[voyager] local model call #${CALLS.local}`);
        return r;
    }
    _cursorLimited() { return Date.now() < (this.agent.prompter.code_model.quotaUntil || 0); }
    // find a saved skill that can be replayed without any model call
    _findReplay(task) {
        const goal = countGoal(task);
        const has = n => this.skills.some(s => s.name === n && !s.demoted);
        const kill = task.match(/^(?:kill|hunt|slay|fight)\s+(\d+)\s+([a-z_]+?)s?\b/i);
        if (kill && has('killMob')) return { name: 'killMob', call: `await killMob(bot, ${JSON.stringify(kill[2].toLowerCase())}, ${kill[1]});`, check: 'output' };
        if (/^(store|deposit)\b.*\bchest\b/i.test(task) && has('depositToChest')) {
            // keep what the milestones need (wood, stone, coal, ores/ingots, tools, armor, food we eat); store the rest
            const keep = /(_log|_planks|^stick|^cobblestone|^coal|^raw_|_ingot|^diamond|pickaxe|_axe|sword|shovel|helmet|chestplate|leggings|boots|^torch|^crafting_table|^furnace|^bread|^shield)$|^cooked_/;
            const junk = [...new Set(this.agent.bot.inventory.items().map(i => i.name).filter(n => !keep.test(n)))];
            return { name: 'depositToChest', call: `await depositToChest(bot, ${JSON.stringify(junk)});`, free: 6 };
        }
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
    _precheck(r) {
        const c = this._contract(r); if (!c) return { ok: true };
        const bot = this.agent.bot, inv = this.observe().inventory;
        try {
            if (c.pre === 'recipe') {
                const md = minecraftData(VERSION || '1.20.4'); const it = md.itemsByName[c.item];
                if (!it) return { ok: false, why: `unknown item ${c.item}` };
                const table = bot.findBlock({ matching: md.blocksByName.crafting_table.id, maxDistance: 32 });
                const can = bot.recipesFor(it.id, null, 1, table).length > 0;
                return can ? { ok: true } : { ok: false, why: `missing ingredients for ${c.item}${table ? '' : ' (no crafting table within 32)'}` , reroute: 'obtainItem', item: c.item, count: c.count };
            }
            if (c.pre === 'block') {
                if (c.item.startsWith('any')) return { ok: true };
                const md = minecraftData(VERSION || '1.20.4'); const b = md.blocksByName[c.item];
                if (!b) return { ok: false, why: `unknown block ${c.item}` };
                const ids = [b.id, md.blocksByName['deepslate_' + c.item]?.id].filter(x => x !== undefined);
                return bot.findBlock({ matching: ids, maxDistance: 64 }) ? { ok: true } : { ok: false, why: `no ${c.item} within 64 blocks` };
            }
            if (c.pre === 'mob') return Object.values(bot.entities).some(e => e.name === c.mob && e.position.distanceTo(bot.entity.position) <= 48) ? { ok: true } : { ok: false, why: `no ${c.mob} within 48 blocks` };
            if (c.pre === 'input') return (inv[c.input] || 0) > 0 ? { ok: true } : { ok: false, why: `no ${c.input} in inventory` };
        } catch (e) { return { ok: false, why: `precheck error ${e.message}` }; }
        return { ok: true };
    }
    async _replay(task, before) {
        let r = this._findReplay(task);
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
        const goal = smeltGoal(task) || countGoal(task);
        CALLS.replay++;
        console.log(`[voyager] REPLAY skill ${r.name} for "${task}" (no code model)`);
        const entry = this.skills.find(s => s.name === r.name);
        const trial = entry?.candidate ? true : false;   // gate: a pending candidate gets trial runs before promotion
        if (trial) gateLog(`trial run of candidate ${r.name} (candidate ${entry.candidate.stats.success}/${entry.candidate.stats.success + entry.candidate.stats.fail}, current ${entry.stats?.success || 0}/${(entry.stats?.success || 0) + (entry.stats?.fail || 0)})`);
        const over = {}; for (const s of this.skills) if (s.candidate && (s.name === r.name || this._closure(r.name).has(s.name))) over[s.name] = s.candidate.code;   // fix10: candidates of children are trialled in place too
        const full = this._libSrc(over) + '\n\n' + instrumentSrc(this.skills.filter(s => new RegExp(`async\\s+function\\s+${s.name}\\s*\\(`).test(over[s.name] ?? s.code)).map(s => s.name)) + '\n\nasync function __replay(bot) {\n    try { ' + r.call + ' } finally { bot.__psnOut = bot.output; }\n}\nawait __replay(bot);';
        const staged = await this.agent.coder._stageCode(full);
        if (!staged) return { ok: false };
        this._runStart = Date.now();
        const res = await this.agent.actions.runAction(`voyager:replay:${task}`, async () => { this.agent.bot.__psnALS = globalThis.__psnALS; await staged.func.main(this.agent.bot); }, { timeout: 5 });
        if (this.abort) return { ok: false, interrupted: true };
        const after = this.observe();
        let ok;
        const cut = res.interrupted || this._diedInRun() ? this._interruptReason(res.message) : '';   // fix14: a cut-off replay is a failure
        if (this._diedInRun()) this._noteDeath(this._diedInRun(), task);
        if (cut) { ok = false; console.log(`[voyager] replay ${r.name} ${cut}; counting as a failure`); } else
        if (r.free) { const e = this.agent.bot.inventory.emptySlotCount(); ok = e >= r.free; console.log(`[voyager] inventory check: ${e} empty slots (need ${r.free})`); }
        else if (r.at) { const p = this.agent.bot.entity.position; ok = Math.hypot(p.x - r.at.x, p.z - r.at.z) <= 8; }
        else if (goal && ['mine','collect','gather','chop','craft','smelt','cook','get','obtain'].includes(goal.verb)) ok = gainedFor(goal, before, after) >= goal.count;
        else if (entry?.effects?.length) {   // PSN rule-based effect check: the skill's recorded expected effects must show up again
            const gotten = entry.effects.filter(it => (after.inventory[it] || 0) > (before.inventory[it] || 0));
            ok = gotten.length > 0;
            console.log(`[psn] effect check ${r.name}: expected +[${entry.effects.join(', ')}], got +[${gotten.join(', ')}] -> ${ok}`);
        }
        else { const v = await this.critique(task, before, after, String(res.message || '').slice(-1500)); ok = !!v.success; }
        if (entry) this._recordRun(entry, task, ok, trial);
        this._attribute(r.name, task, ok, over);   // fix10: per-call trace -> contract results -> blame -> targeted repair
        console.log(`[voyager] replay ${r.name}: ${ok ? 'PASSED' : 'failed'}${goal ? ` (+${gainedFor(goal, before, after)} ${goal.items.join('/')})` : ''}`);
        if (r.free) console.log(`[voyager] storage replay ${r.name} output: ${String(res.message || '(none)').split(/\n|\|/).filter(l => /\[(toss|chest)\]/.test(l)).join(' | ').slice(-800)}; inv now ${JSON.stringify(after.inventory)}`);
        if (!ok) console.log(`[voyager] replay ${r.name} inv: ${this.agent.bot.inventory.emptySlotCount()} empty slots; ${JSON.stringify(after.inventory)}`);
        if (!ok) console.log(`[voyager] replay ${r.name} output: ${String(res.message || '(none)').slice(-600).replace(/\n+/g, ' | ')}`);
        return { ok, name: r.name, output: String(res.message || ''), cut };
    }
    // library source with optional per-name code overrides (candidates under test)
    _libSrc(over = {}) { return this.skills.map(s => over[s.name] ?? s.code).join('\n\n'); }
    _graph(exclude) { const g = {}; for (const s of this.skills) if (s.name !== exclude) g[s.name] = s.deps || []; return g; }
    // PSN-style catalogue: every skill with its signature, one line each
    catalogue() {
        return this.skills.filter(s => !s.demoted && !s.mergedInto).map(s => `- ${signatureOf(s.code, s.name)}${s.handwritten ? ' [handwritten]' : ''}: ${s.description}`).join('\n');
    }
    _recordRun(entry, task, ok, trial) {
        if (trial) {
            const c = entry.candidate; recordRun(c.stats, task, ok);
            const n = c.stats.success + c.stats.fail;
            if (!ok && c.stats.fail >= 2) { gateLog(`REJECT candidate ${entry.name}: failed ${c.stats.fail}/${n} trial runs; keeping current version`); this._proposalOutcome(entry, `rejected ${c.stats.success}/${n}`); const rf = c.refactor; delete entry.candidate; if (rf) this._rollbackRefactor(rf, entry.name); }
            else if (c.stats.success >= 2 && rate(c.stats) >= rate(entry.stats || newStats())) { gateLog(`PROMOTE candidate ${entry.name}: ${c.stats.success} passes, trial ${c.stats.success}/${n} >= current rate ${rate(entry.stats || newStats()).toFixed(2)}`); this._promote(entry, c); }
            else gateLog(`candidate ${entry.name} trial ${ok ? 'passed' : 'failed'} (${c.stats.success}/${n}); waiting for more runs`);
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
        const past = (entry.stats?.tasks || []).slice().reverse().find(t => countGoal(t) || smeltGoal(t));
        if (!past) return null;
        const goal = smeltGoal(past) || countGoal(past);
        const before = this.observe();
        gateLog(`regression rerun of candidate ${entry.name} on past task "${past}"`);
        const staged = await this.agent.coder._stageCode(this._libSrc({ [entry.name]: code }) + `\n\nawait ${entry.name}(bot);`);
        if (!staged) return false;
        const res = await this.agent.actions.runAction(`voyager:gate:${entry.name}`, async () => { this.agent.bot.__psnALS = globalThis.__psnALS; await staged.func.main(this.agent.bot); }, { timeout: 4 });
        if (res.interrupted || this.abort) return null;
        return gainedFor(goal, before, this.observe()) >= goal.count;
    }
    async _ask(system, user) {
        CALLS.code++;
        // code model = Cursor CLI composer-2.5 (quota/usage-limit pause lives in CodeModelWithFallback; no fallback).
        // If the limit is (or becomes) active, abandon this step.
        const cm = this.agent.prompter.code_model;
        if (Date.now() < (cm.quotaUntil || 0)) throw new Error('code model quota/usage-limit pause active; voyager step abandoned');
        const r = await cm.sendRequest([{ role: 'user', content: user }], system);
        if (Date.now() < (cm.quotaUntil || 0)) throw new Error('code model quota/usage limit hit; voyager step abandoned');
        return r;
    }

    // ---------- automatic curriculum ----------
    // PSN goal planner: first unmet milestone -> deterministic "Get N item" task (obtainItem expands the prerequisite chain); LLM curriculum otherwise
    _milestoneTask(state) {
        this._checkHomeGround();
        const done = this.progress.milestones ||= [];
        const inv = state.inventory || {};
        const empty = this.agent.bot.inventory.emptySlotCount();
        void empty;   // fix18: full-inventory handling is learned, not forced
        // fix12: a hut at HOME comes first (checked in-world, not by inventory)
        if (!done.includes('home_hut')) {
            if (this._hutBuilt()) { done.push('home_hut'); this._saveProgress(); console.log('[psn] milestone reached: home_hut'); }
            else {
                const task = `Build a 7x7 cobblestone hut at home (${HOME.x}, ${HOME.z})`;
                const fails = this.progress.failed.slice(-20).filter(t => t === task).length;
                const bo = (this.progress.milestoneBackoff ||= {});
                if (Date.now() < (bo.home_hut || 0)) { console.log(`[psn] milestone home_hut backed off for ${Math.round((bo.home_hut - Date.now()) / 60e3)} more min; asking LLM curriculum`); }
                else if (fails >= 2) { bo.home_hut = Date.now() + 30 * 60e3; this._saveProgress(); this._decomposeQueue ||= { task, reason: `milestone failed ${fails}x` }; console.log(`[psn] milestone home_hut blocked (${task} failed ${fails}x); backing off 30 min and decomposing it`); }
                else {
                console.log(`[psn] milestone home_hut: next ${task} (no curriculum model call)`);
                return { task, reasoning: 'PSN milestone home_hut: the base moved and has no shelter yet',
                    context: `await skills.travelTo(bot, ${HOME.x}, ${HOME.y}, ${HOME.z}); then find the ground level y (first solid block below +1) near there and call skills.buildStructure(bot, 'hut', ${HOME.x - 3}, y, ${HOME.z - 3}, 'cobblestone', 7, 7, 3)` };
                }
            }
        }
        for (const m of MILESTONES) {
            if (done.includes(m.name)) continue;
            const missing = Object.entries(m.items).filter(([k, n]) => (inv[k] || 0) < n && !(m.block && world.getNearestBlock(this.agent.bot, m.block, 24)));
            if (!missing.length) { done.push(m.name); this._saveProgress(); console.log(`[psn] milestone reached: ${m.name}`); continue; }
            const [item, n] = missing[0];
            const task = `Get ${n} ${item}`;
            const fails = this.progress.failed.slice(-20).filter(t => t === task).length;
            if (fails >= 2) { console.log(`[psn] milestone ${m.name} blocked (${task} failed ${fails}x); asking LLM curriculum`); return null; }
            console.log(`[psn] milestone ${m.name}: next ${task} (no curriculum model call)`);
            return { task, reasoning: `PSN milestone ${m.name}`, context: `use obtainItem(bot, '${item}', ${n})` };
        }
        return null;
    }
    // fix19 (1): split a goal that keeps failing into 2-4 subgoals with the local model; each subgoal is learned as a skill,
    // then the parent is retried with those skills in the hint (its code calls them -> deps recorded by saveSkill)
    async _decompose(task, reason) {
        const d = (this.progress.decomposed ||= {}), q = (this.progress.subgoals ||= []);
        const depth = (this._curSub?.task === task ? this._curSub.depth : 0);
        if (depth >= 2) { console.log(`[psn] decompose skipped for "${task}": already a depth-${depth} subgoal`); return false; }
        if (d[task] && Date.now() - d[task].at < 30 * 60e3) { console.log(`[psn] decompose skipped for "${task}": decomposed ${Math.round((Date.now() - d[task].at) / 60e3)} min ago`); return false; }
        const system = `You break a Minecraft bot's failing goal into smaller steps (Voyager/PSN-style task decomposition).
Return 2-4 concrete, verifiable subgoals, in order, that together achieve the goal; each must be doable in a few minutes by ONE small reusable skill (e.g. "Mine 20 cobblestone", "Clear and flatten a 7x7 area at x=.., z=..", "Place a 7x7 cobblestone floor at ..."). Use the failure reason. Do not repeat the goal itself.
Reply ONLY with JSON: {"subgoals": ["...", "..."]}`;
        const user = `goal: ${task}\nwhy it failed: ${String(reason).slice(0, 600)}\ndeath_hotspots (subgoals targeting these are rejected; plan around them): ${this._deathHotspots()}\n${this._stateText(this.observe())}\nknown_skills: ${JSON.stringify(this.skills.filter(s => !s.demoted).map(s => s.name))}`;
        let subs = [];
        try { subs = (parseJSON(await this._askLocal(system, user)).subgoals || []).map(t => String(t).trim()).filter(t => { if (!t || t === task || validateTask(t)) return false; const h = this._hotspotOf(t); if (h) console.log(`[psn] subgoal rejected: "${t}": ${h}`); return !h; }).slice(0, 4); }
        catch (e) { console.log(`[psn] decompose FAILED for "${task}": ${e.message}`); return false; }
        if (subs.length < 2) { console.log(`[psn] decompose FAILED for "${task}": model gave ${subs.length} valid subgoal(s)`); d[task] = { subs, skills: [], at: Date.now(), reason }; this._saveProgress(); return false; }
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
    async proposeTask(state) {
        const system = `You are the automatic curriculum for a Minecraft bot named ${this.agent.name} (Voyager-style).
Goal: discover as many diverse things as possible and grow a small town of its own, progressing wood -> stone -> iron -> diamond tech.
Rules:
- The bot's town is at x=${TOWN.x}, y=${TOWN.y}, z=${TOWN.z} (the bot's home base; ${this._hutBuilt() ? `its 7x7 cobblestone hut stands at x ${HOME.x-3}..${HOME.x+3}, z ${HOME.z-3}..${HOME.z+3}` : 'NO hut exists here yet; building one is a priority'}). Stay within ~150 blocks of town.
- NEVER go near the players' village around x=${VILLAGE.x}, z=${VILLAGE.z}; never take or break player builds.
- Propose ONE concrete, verifiable task achievable in a few minutes with the current inventory and surroundings (e.g. "Mine 5 birch_log", "Craft 1 stone_pickaxe", "Smelt 3 iron_ingot", "Build a 5x5 cobblestone floor next to the hut").
- Do not repeat completed tasks unless needed for progress; avoid tasks that failed recently unless prerequisites are now met.
- death_hotspots lists places it keeps dying: when not 'none', propose a task that teaches it to survive or avoid that (it learns this as a skill).
- The bot must survive: dying loses its inventory. Nothing keeps it alive automatically (no eating, fleeing, fighting or sheltering reflexes), so survival is your job too: read time, health, food, threats and inventory space in the state and decide.
Reply ONLY with JSON: {"reasoning": "...", "task": "...", "context": "short hint how to do it"}`;
        const user = `${this._stateText(state)}
completed_tasks: ${JSON.stringify(this.progress.completed.slice(-30))}
failed_tasks: ${JSON.stringify(this.progress.failed.slice(-15))}
known_skills: ${JSON.stringify(this.skills.map(s => s.name))}
replayable_tasks (cheap, no new code needed): ${JSON.stringify(this.skills.filter(s => s.task && !s.primitive).map(s => s.task.split(/\s+(?:within|at|using|from)\b/i)[0]).slice(-25))} plus any "Mine N <block or ore>", "Collect N <log>", "Get N <item>", "Smelt N <raw> into N <out>", "Kill N <mob>", "Harvest N <crop>"${this._cursorLimited() ? '\nIMPORTANT: the code-writing model is unavailable right now, so ONLY propose a task from replayable_tasks or "Mine N <block>".' : ''}`;
        const facts = recipeFacts(this.progress.failed.slice(-5).join(' '));
        return parseJSON(await this._askLocal(system, facts ? user + '\n' + facts : user));
    }

    // ---------- skill library ----------
    async _embed(text) {
        const em = this.agent.prompter.embedding_model;
        if (!em) throw new Error('[voyager] embedding model required (no fallback)');
        const v = await em.embed(text);   // fix14: fail loudly, no word-overlap fallback
        return Array.isArray(v?.[0]?.values) ? v[0].values : v;
    }
    async retrieveSkills(query, k = 5) {
        if (!this.skills.length) return [];
        const q = await this._embed(query);
        {  // re-embed skills saved with a different embedding model (e.g. nomic -> gemini-embedding-001)
            let changed = false;
            for (const s of this.skills) {
                if (!s.embedding || s.embedding.length !== q.length) { s.embedding = await this._embed(s.description); changed = true; }
            }
            if (changed) { this._saveSkills(); console.log('[voyager] re-embedded skill library with current embedding model'); }
        }
        const scored = this.skills.map(s => ({ s, score: cosineSimilarity(q, s.embedding) }));
        console.log(`[voyager] skill search (embeddings) top: ${scored.slice().sort((a, b) => b.score - a.score).slice(0, 3).map(x => x.s.name + '=' + x.score.toFixed(2)).join(' ')}`);
        return scored.sort((a, b) => b.score - a.score).slice(0, k).map(x => x.s);
    }
    async saveSkill(name, description, code, task, opts = {}) {
        const names = new Set(this.skills.map(s => s.name));
        const deps = depsOf(code, name, names);
        const missing = missingCalls(code, name, names);
        if (missing.length) { gateLog(`REJECT ${name}: calls unknown skills ${missing.join(', ')}`); return false; }
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
    async critique(task, before, after, output) {
        const system = `You are an assistant that checks whether a Minecraft bot completed its task, using its state before and after and the code output.
Be strict: success only if the evidence (inventory/position/output) shows the task is done.
If the code hand-rolled a mining/collecting loop that timed out, got 0 items or failed pathfinding, say in the critique to switch to mineBlocks / gatherItem / collectDrops (custom code is otherwise fine).\nReply ONLY with JSON: {"reasoning": "...", "success": true|false, "critique": "how to fix it if failed, else empty"}`;
        const user = `task: ${task}\n${recipeFacts(task)}\n--- before ---\n${this._stateText(before)}\n--- after ---\n${this._stateText(after)}\n--- code output ---\n${output}`;
        return parseJSON(await this._askLocal(system, user));
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

    // fix10: keep the bot within LEASH blocks of town: travel home before picking the next task (max 3 failed tries, then 30 min pause, logged loudly)
    async _leash() {
        const bot = this.agent.bot, p = bot.entity.position, LEASH = 300;
        if (String(bot.game.dimension || "").startsWith("abh")) return false;
        const d = Math.hypot(p.x - TOWN.x, p.z - TOWN.z);
        if (d <= LEASH || Date.now() < (this._leashPause || 0)) return false;
        console.log(`[voyager] leash: ${d.toFixed(0)} blocks from town (> ${LEASH}); travelling home before the next task`);
        const res = await this.agent.actions.runAction("voyager:leash", async () => { await skills.travelTo(bot, TOWN.x, TOWN.y, TOWN.z); }, { timeout: 15 });
        const q = bot.entity.position, d2 = Math.hypot(q.x - TOWN.x, q.z - TOWN.z);
        if (d2 <= LEASH) { this._leashFails = 0; console.log(`[voyager] leash: back within ${d2.toFixed(0)} blocks of town`); }
        else if (!res?.interrupted && (this._leashFails = (this._leashFails || 0) + 1) >= 3) { this._leashFails = 0; this._leashPause = Date.now() + 30 * 60e3; console.log(`[voyager] leash FAILED 3 times (still ${d2.toFixed(0)} blocks away); pausing the leash for 30 min`); }
        else console.log(`[voyager] leash: still ${d2.toFixed(0)} blocks from town`);
        return true;
    }

    // ---------- fix10: PSN failure attribution and targeted repair ----------
    // dependency closure of a skill (all skills it can reach through deps)
    _closure(name) { const g = this._graph(), seen = new Set(), st = [...(g[name] || [])]; while (st.length) { const n = st.pop(); if (seen.has(n)) continue; seen.add(n); st.push(...(g[n] || [])); } return seen; }
    // fix11 (B1): only hand-written/primitive skills with no skill deps are fixed leaves; learned skills stay repairable.
    // Names outside the library (freshly generated code) are not leaves.
    _isLeaf(name) { if (name.startsWith('skills.')) return true;   // fix21: traced primitives are fixed leaves
        const e = this.skills.find(s => s.name === name); return !!e && !!e.primitive && !(e.deps || []).length; }   // fix24: hand-written skills are repairable
    _attribute(root, task, ok, over) {
        const bot = this.agent.bot, trace = bot.__psnTrace;
        bot.__psnTrace = null;
        if (!Array.isArray(trace) || !trace.length) { console.log('[psn] no execution trace recorded'); return; }
        annotateTrace(trace, bot.__psnOut || '');
        this._checkContracts(trace, ok);   // fix22: learned pre/postconditions against real state
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
        if (died) { let i = -1; for (let k = 0; k < trace.length; k++) if ((trace[k].t0 || 0) <= died.t && (trace[k].t1 ?? Infinity) >= died.t - 1500 && (i < 0 || trace[k].depth >= trace[i].depth)) i = k; if (i < 0) i = trace.length - 1; console.log(`[psn] death attributed to the call running at death time: ${trace[i].name} (depth ${trace[i].depth})`); trace[i].ownFail = [`DIED: ${died.message} at ${died.pos}`]; for (; i >= 0; i = trace[i].parent) { trace[i].intr = false; trace[i].ok = false; trace[i].fail = true; } ok = false; }
        // fix26: a call that moved the bot from outside into an active hotspot failed its contract (deepest such call); blame/repair learns avoidance
        for (let k = trace.length - 1; k >= 0; k--) { const r = trace[k]; if (r.intr || !r.s0?.pos || !r.s1?.pos) continue;
            const c = this._hotCell(r.s1.pos); if (!c || this._cellKey(r.s0.pos) === this._cellKey(r.s1.pos)) continue;
            if (trace.some((q, j) => j > k && q.depth > r.depth && q.ownFail?.some(l => /HOTSPOT/.test(l)))) continue;
            console.log(`[psn] hotspot entry: ${r.name} moved the bot into a death hotspot (${this._hsText(c)}) -> contract failure`);
            r.ownFail = [...(r.ownFail || []), `FAILED: HOTSPOT entered: moved from ${Math.round(r.s0.pos.x)},${Math.round(r.s0.pos.z)} into a death hotspot at ${c.pos} (${c.n} deaths: ${c.causes.slice(-1)[0]})`];
            for (let i = k; i >= 0; i = trace[i].parent) { trace[i].intr = false; trace[i].ok = false; trace[i].fail = true; } ok = false; }
        // fix19 (5): an explicit FAILED line from a skill is a contract failure even if the task check passed (e.g. ensureChest inside a storage task)
        const explicit = trace.some(r => !r.intr && (r.ownFail || []).some(l => /FAILED|CONDITION violated/.test(l)));   // fix22: contract violations count
        if (ok && !revalFail && !explicit) return;
        if (ok && explicit) console.log(`[psn] task check passed but a skill reported FAILED; attributing that contract failure`);
        console.log(`[psn] execution trace of ${root} (${trace.length} calls):\n${traceText(trace)}`);
        const learned = n => { const e = this.skills.find(s => s.name === n); return !!e && !e.primitive; };   // fix24: includes hand-written (repairs become learned candidates)
        let bs = blameAll(trace, n => this._isLeaf(n), learned).slice(0, 3);   // at most 3 patches per failure (deepest first)
        // fix19 (2): no learned skill on a failure path: the root's own composition is at fault
        if (!bs.length) {
            const b0 = blame(trace, n => this._isLeaf(n));
            const why = b0 ? (b0.target ? `failure only in non-library code ${b0.target} (${b0.evidence})` : `only the fixed leaf ${b0.leaf} failed (${b0.evidence})`) : 'every call met its contract but the task outcome failed';
            if (learned(root)) { bs = [{ target: root, leaf: root, path: [root], kind: 'callee_fix', swallowed: false, evidence: why }]; console.log(`[psn] blame: root learned skill ${root} [callee_fix]: ${why}`); }
            else { console.log(`[psn] blame: ${why}; root ${root} is ${this.skills.some(s => s.name === root) ? 'primitive/hand-written' : 'freshly generated'} -> goal goes to decomposition`); this._decomposeQueue ||= { task, reason: why }; return; }
        } else console.log(`[psn] blame (top-down over ${bs.length} responsible skill(s), patched bottom-up): ${bs.map(b => `${b.target} [${b.kind}${b.swallowed ? ', swallowed' : ''}]`).join(', ')}; path ${bs[0].path.join(' > ')}; deepest failure ${bs[0].leaf}: ${bs[0].evidence}`);
        const rq = [...(this._repairQueue || [])];
        for (const b of bs) {
            if (rq.some(x => x.target === b.target)) { console.log(`[psn] repair of ${b.target} already queued`); continue; }
            rq.push({ ...b, task, trace: traceText(trace, 60), peers: bs.map(x => x.target) }); console.log(`[psn] queued REPAIR of ${b.target} (${rq.length} in queue)`);
        }
        rq.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0)); this._repairQueue = rq;
    }
    // targeted repair of the blamed skill via the code model, through the normal regression gate (saveSkill)
    // fix26: a skipped repair is deferred (persisted) and re-queued when ripe, not dropped; dropped loudly after 6 deferrals
    _deferRepair(q, ms, why) {
        const d = (this.progress.deferredRepairs ||= []); q.defers = (q.defers || 0) + 1;
        if (q.defers > 6) { console.log(`[psn] repair of ${q.target} DROPPED after ${q.defers - 1} deferrals (${why})`); this._saveProgress(); return; }
        if (!d.some(x => x.target === q.target && x.kind === q.kind)) d.push({ ...q, notBefore: Date.now() + ms }); this._saveProgress();
        console.log(`[psn] repair of ${q.target} deferred ${Math.round(ms / 60e3)} min (${why}; deferral ${q.defers}/6)`);
    }
    _requeueDeferred() {
        const d = this.progress.deferredRepairs || []; if (!d.length) return;
        const ripe = d.filter(x => Date.now() >= x.notBefore && !this.skills.find(s => s.name === x.target)?.candidate || (x.kind === 'contract_fix' && Date.now() >= x.notBefore));
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
        if (q.kind === 'contract_fix') {   // fix25b: contract-only repair is independent of code candidates and the code-repair cap
            if (this._cursorLimited()) { console.log(`[psn] contract repair of ${e.name} deferred: code model at its limit`); this._deferRepair(q, 10 * 60e3, 'code model at its limit'); return false; }
                        console.log(`[psn] REPAIR contract of ${e.name} (${q.evidence})`);
            const n = await this._learnContracts([e], 'contract repair', q.evidence);
            this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence.slice(0, 200), desc: n ? `contract -> ${e.contract.text}` : 'contract repair failed', outcome: n ? 'contract replaced' : 'failed' });
            return n > 0;
        }
        if (Date.now() - (this._repairs[e.name] || 0) < 30 * 60e3) { console.log(`[psn] repair of ${e.name} skipped: already repaired in the last 30 min (cap)`); this._deferRepair(q, Math.max(60e3, 30 * 60e3 - (Date.now() - (this._repairs[e.name] || 0))), 'already repaired in the last 30 min (cap)'); return false; }
        if (e.candidate) { console.log(`[psn] repair of ${e.name} skipped: a candidate is already under trial`); this._deferRepair(q, 10 * 60e3, 'a candidate is already under trial'); return false; }
        if (this._cursorLimited()) { console.log(`[psn] repair of ${e.name} skipped: code model at its limit`); this._deferRepair(q, 10 * 60e3, 'code model at its limit'); return false; }
        if (!this._updateAllowed(e, `repair after ${q.kind}`)) { console.log(`[psn] repair of ${e.name} skipped: maturity gate froze it`); return false; }
        this._repairs[e.name] = Date.now(); this._saveProgress();
        const kids = [...this._closure(e.name)].map(n => this.skills.find(s => s.name === n)).filter(Boolean);
        const system = `You repair ONE skill in a Minecraft mineflayer skill library (PSN-style targeted fix). Return a single \`\`\`javascript code block containing ONLY the fixed function, with the SAME name and a compatible signature. First line inside the block: // DESCRIPTION: <one sentence>. Call other library skills by name (they are in scope); never redefine them. Every loop must check bot.interrupt_code. If something still cannot be done, log(bot, 'FAILED: <reason>') and return a falsy value; no silent fallbacks.\nLIBRARY:\n${this.catalogue()}`;
        const user = `Blamed skill: ${e.name} (${q.kind === 'caller_fix' ? 'it calls the leaf ' + q.leaf + ' in a situation where the leaf cannot succeed: fix how/when it calls it, e.g. obtain the missing prerequisite first' : 'its own logic failed'})\nTask that failed: ${q.task}\nFailure path: ${q.path.join(' > ')}\nEvidence: ${q.evidence}\n--- execution trace (indent = call depth) ---\n${q.trace}\n${e.contract ? `--- learned contract of ${e.name} (must hold after your fix) ---\npre: ${e.contract.pre}\npost: ${e.contract.post}\n` : ''}--- current code of ${e.name} ---\n${e.code}\n--- skills it uses ---\n${kids.map(k => '// ' + k.description + '\n' + signatureOf(k.code, k.name)).join('\n')}\n${(e.repairHistory || []).length ? `\n--- your last ${e.repairHistory.length} repair proposal(s) for ${e.name} (do not repeat what failed) ---\n` + e.repairHistory.map((h, i) => `${i + 1}. [${h.outcome || 'pending'}] ${h.kind}: ${h.evidence}\n   change: ${h.desc}`).join('\n') : ''}${q.peers?.length > 1 ? `\nOther skills blamed on the same failure (repaired children-first): ${q.peers.join(', ')}` : ''}\nWrite the fixed ${e.name}:`;
        console.log(`[psn] repair memory for ${e.name}: ${(e.repairHistory || []).length} past proposal(s) in the prompt`);
        console.log(`[psn] REPAIR ${e.name} [${q.kind}] with the code model (evidence: ${q.evidence.slice(0, 160)})`);
        let code, body, desc, extra = '';
        for (let att = 1; att <= 2; att++) {   // fix19 (3): one retry with the lint/format error fed back
            let reply;
            try { reply = await this._ask(system, user + extra); } catch (err) { console.log(`[psn] repair FAILED for ${e.name}: ${err.message}`); return false; }
            code = extractCode(reply);
            const fn = code && code.match(/async\s+function\s+([A-Za-z_]\w*)\s*\(/);
            let err = null;
            if (!fn || fn[1] !== e.name) err = `reply did not define async function ${e.name}`;
            else {
                desc = ((code.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || e.description).trim();
                body = code.replace(/\n\s*await\s+\w+\(bot[^)]*\);\s*$/, '').trim();
                const staged = await this.agent.coder._stageCode(this._libSrc({ [e.name]: body }) + '\n\nawait Promise.resolve();');   // fix19: lint needs an await in main (library-only source always failed lint)
                const lint = staged ? await this.agent.coder._lintCode(staged.src_lint_copy) : 'staging failed';
                if (lint) err = `lint: ${String(lint).slice(0, 600)}`;
            }
            if (!err) break;
            console.log(`[psn] repair attempt ${att} FAILED for ${e.name}: ${err.slice(0, 300)}${att < 2 ? '; retrying with the error fed back' : ''}`);
            if (att === 2) { this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence.slice(0, 200), desc: `invalid code: ${err.slice(0, 150)}`, outcome: 'lint failed' }); return false; }
            extra = `\n--- your previous reply was rejected ---\n${err}\n--- previous code ---\n${code || '(none)'}\nFix the error and write the fixed ${e.name} again:`;
        }
        this._lastEffects = e.effects || [];
        this._noteProposal(e, { task: q.task, kind: q.kind, evidence: q.evidence.slice(0, 200), desc: desc.slice(0, 200) });
        const saved = await this.saveSkill(e.name, desc, body, `repair: ${q.task}`, { repair: true });
        if (!saved) { this._proposalOutcome(e, 'rejected at submit'); this._saveSkills(); console.log(`[psn] repair of ${e.name} rejected by the gate`); return false; }
        console.log(`[psn] repaired ${e.name}: submitted to the gate (parents are re-validated once it is promoted)`);
        return true;
    }

    // fix20 (PSN refactoring with rollback): merge a code fragment repeated in 3+ skills into one new helper skill;
    // the rewritten skills enter the gate as candidates tagged with the refactor id. If any rewrite is rejected
    // (trial runs or regression rerun), every candidate of that refactor is rolled back.
    async _refactor() {
        const h = (this.sharedHints || [])[0];
        if (!h || this._cursorLimited()) return false;
        const P = this.progress; if (Date.now() - (P.lastRefactor || 0) < 2 * 3600e3) return false;
        P.lastRefactor = Date.now(); this._saveProgress();
        const ents = h.skills.map(n => this.skills.find(s => s.name === n)).filter(e => e && !e.handwritten && !e.primitive && !e.candidate);
        if (ents.length < 2) { console.log(`[psn] refactor skipped: fragment shared by ${h.skills.join(', ')} but <2 learned skills without a pending candidate`); return false; }
        const id = `rf${Date.now()}`;
        const system = `You refactor a Minecraft mineflayer skill library (PSN canonical refactor: extract shared subroutine). Return ONE \`\`\`javascript block with: first a NEW helper async function (bot, ...params) that implements the repeated fragment, preceded by // DESCRIPTION: <one sentence>; then each listed skill rewritten to call the helper, SAME names and signatures, behaviour unchanged. Every loop checks bot.interrupt_code. No other functions.\nLIBRARY:\n${this.catalogue()}`;
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
        const staged = await this.agent.coder._stageCode(this._libSrc(over) + `\n\n${helper[1]}\n\nawait Promise.resolve();`);
        const lint = staged ? await this.agent.coder._lintCode(staged.src_lint_copy) : 'staging failed';
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
        for (const e of this.skills) if (e.refactorOf === id && e.prev) { /* already promoted: restore the pre-refactor version */ Object.assign(e, { code: e.prev.code, description: e.prev.description, deps: e.prev.deps, stats: e.prev.stats }); writeAtomic(`${this.dir}/${e.name}.js`, `// ${e.description}\n${e.code}\n`); delete e.refactorOf; n++; }
        if (rf) { const h = this.skills.find(s => s.name === rf.helper); if (h && !this.skills.some(s => !s.mergedInto && (s.deps || []).includes(rf.helper))) h.demoted = true; rf.rolledBack = by; this._saveProgress(); }
        this._saveSkills(); gateLog(`ROLLBACK refactor ${id} (rejected: ${by}): ${n} rewritten skill(s) restored; helper ${rf?.helper || '?'} retired if unused`);
    }

    async step() {
        this._watchWindows();
        this._watchDimension();
        if (this.agent.bot.currentWindow) { const w = this.agent.bot.currentWindow; if (/CHOICE/.test(JSON.stringify(w.title))) { if (!this._choiceNoted) { this._choiceNoted = 1; console.log("[window] datapack dialog CHOICE (A Breach Happened multi_action dialog via ViaProxy) left open; not answering"); } } else console.log(`[window] STRAY ${w.type} id=${w.id} still open at step start (opened ${Math.round((Date.now() - (this._winOpenedAt || 0)) / 1000)}s ago); closing`); if (!/CHOICE/.test(JSON.stringify(w.title))) try { this.agent.bot.closeWindow(w); } catch (e) { console.log('[window] close failed: ' + e.message); } }
        this._oneshot();
        // fix18: no hard-coded survival/housekeeping policy; the curriculum proposes it and the PSN learns it
        if (await this._leash()) return;
        this._requeueDeferred();   // fix26
        if (this._repairQueue?.length) { await this._repair(); return; }
        if (this._decomposeQueue) { const dq = this._decomposeQueue; this._decomposeQueue = null; await this._decompose(dq.task, dq.reason); return; }
        if (!this.progress.fix25) this._fix25Migrate();
        if (await this._backfillContracts()) return;   // fix22
        if (await this._refactor()) return;
        const before = this.observe();
        this._curSub = null;
        const sub = this._subgoalTask(), ms = sub ? null : this._milestoneTask(before), fromCurr = !sub && !ms;
        let proposal = sub || ms || await this.proposeTask(before);
        let task = String(proposal.task || '').trim();
        let invalid = task ? (validateTask(task) || this._hotspotOf(task)) : 'empty task';
        if (invalid) {
            console.log(`[voyager] rejected task "${task}": ${invalid}`);
            this.progress.failed.push(`${task} (invalid: ${invalid})`);
            proposal = await this.proposeTask({ ...before, note: `Your last proposal "${task}" was rejected: ${invalid}` });
            task = String(proposal.task || '').trim();
            invalid = task ? (validateTask(task) || this._hotspotOf(task)) : 'empty task';
            if (invalid) { console.log(`[voyager] rejected again "${task}": ${invalid}; skipping`); this._saveProgress(); return; }
        }
        console.log(`[voyager] new task: ${task} (${proposal.reasoning})`);
        this.currentTask = task;
        VERSION = this.agent.bot.version;
        const rp = await this._replay(task, before);
        if (rp?.interrupted) { console.log('[voyager] task interrupted'); return; }
        if (rp?.ok) {
            this.progress.completed.push(task); this.progress.failed = this.progress.failed.filter(t => t !== task); this._saveProgress();
            this._subgoalDone(rp.name);
            this.agent.openChat?.(`Done: ${task} (replayed ${rp.name}).`);
            return;
        }
        if (rp && !rp.ok && !rp.interrupted && this._findReplay(task)) { this.progress.failed.push(task); this._saveProgress(); }
        if (this._cursorLimited()) { console.log(`[voyager] skipped "${task}": needs new code but Cursor is at its limit (replay-only mode)`); return; }
        this.agent.openChat?.(`New goal: ${task}`);
        const related = await this.retrieveSkills(task + ' ' + (proposal.context || ''));
        for (const p of this.skills.filter(s => s.primitive)) if (!related.includes(p)) related.push(p);
        const prompter = this.agent.prompter;
        let system = await prompter.replaceStrings(prompter.profile.coding, [{ role: "user", content: `!newAction(${task})` }], prompter.coding_examples);
        system += `\n\nVOYAGER MODE: write ONE reusable async function \`async function camelCaseName(bot) {...}\` that completes the task, then call it at the end with \`await camelCaseName(bot);\`.
The first line of the code block must be a comment: // DESCRIPTION: <one sentence of what the function does>.
SKILL LIBRARY (already defined as plain async functions in scope; call them directly by name, e.g. \`await mineOre(bot, 'iron_ore', 3)\`; do NOT redefine or copy them, and do not invent other bare function names):
${this.catalogue()}
COMPOSE: build your function out of these skills (they can take arguments). Your new skill may take extra parameters with defaults, e.g. \`async function makeIronTools(bot, count = 1)\`. Prefer obtainItem / mineOre / collectLogs / smeltWithFuel / killMob / ensureCraftingTable / ensureFurnace over hand-rolled loops. Do not create call cycles between skills.${this.sharedHints?.length ? `
SHARED CODE: these fragments are repeated in several skills; if you need this logic, put it in its own small reusable async function skill (named, with parameters) and call it, instead of inlining it again:
${this.sharedHints.map(h => '// used in ' + h.skills.join(', ') + '\n' + h.fragment).join('\n')}` : ''}
Recommended building blocks (robust, already handle pathfinding, full inventory and drop pickup; compose them inside your own function rather than hand-rolling dig/findBlocks loops): mineBlocks(bot, blockName, count) mines ores/stone/logs and picks up drops; gatherItem(bot, itemName, target) gathers until the inventory has target; collectDrops(bot) picks up nearby items; goToBlockAndInteract(bot, blockName, range) walks to and uses a chest/furnace/table.
Interrupts: the bot may be interrupted at any time (danger, getting stuck, a player talking). Every loop must start with \`if (bot.interrupt_code) return;\` and you must return immediately after any await when bot.interrupt_code is true. Every async function must contain an await. Never catch an error and keep looping; no unbounded loops (always cap attempts).`;
        // define every library skill so calls to any known skill lint/run; only `related` are shown as context
        const learnedSrc = this.skills.map(s => s.code).join('\n\n');
        const ctx = related.map(s => `// ${s.description}\n${s.code}`).join('\n\n');

        let feedback = rp?.cut ? `Replay of ${rp.name} failed: ${rp.cut}\nExecution output:\n${String(rp.output).slice(-800)}` : '';
        let lastCode = '', anyCut = rp?.cut || '';
        for (let i = 1; i <= MAX_ATTEMPTS; i++) {
            if (this.abort) { console.log('[voyager] aborted for player'); return; }
            const user = `Task: ${task}\nHint: ${proposal.context || ''}\n${recipeFacts(task)}\n--- state ---\n${this._stateText(this.observe())}
--- learned skills you can call ---\n${ctx || '(none)'}
${lastCode ? `--- your previous code ---\n${lastCode}\n` : ''}${feedback ? `--- feedback from last attempt ---\n${feedback}\n` : ''}Attempt ${i}/${MAX_ATTEMPTS}. Write the code block:`;
            if (i === 1) console.log(`[voyager] code prompt includes skill catalogue (${this.skills.filter(s => !s.demoted).length} skills)`);
            const reply = await this._ask(system, user);
            const code = extractCode(reply);
            if (!code) { feedback = 'Error: no code block. Reply with a ```javascript``` code block.'; continue; }
            const fn = code.match(/async\s+function\s+([A-Za-z_]\w*)\s*\(/);
            if (!fn) { feedback = 'Error: code must define `async function name(bot)` and call it.'; lastCode = code; continue; }
            const desc = (code.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || task;
            const own = fn[1];
            const libOthers = this.skills.filter(s => s.name !== own);
            const over = {}; for (const s of libOthers) if (s.candidate) over[s.name] = s.candidate.code;   // fix24: candidates get trial runs in every task
            const full = libOthers.map(s => over[s.name] ?? s.code).join('\n\n') + '\n\n' + code;
            const plain = await this.agent.coder._stageCode(full);
            const lint = plain ? await this.agent.coder._lintCode(plain.src_lint_copy) : 'staging failed';
            // fix11 (B7): run the generated code with the PSN trace wrapper (rebinding happens before the code's own top-level call)
            const traced = [...libOthers.map(s => s.name), own];
            const staged = lint ? null : await this.agent.coder._stageCode(libOthers.map(s => over[s.name] ?? s.code).join('\n\n') + '\n\n' + instrumentSrc(traced) + '\n\n' + code);
            if (!lint && !staged) throw new Error('[psn] staging of traced generated code failed');
            if (lint) { console.log('[voyager] lint failed: ' + String(lint).slice(0, 300)); feedback = 'Lint error:\n' + lint; lastCode = code; continue; }

            this._runStart = Date.now();
            const res = await this.agent.actions.runAction(`voyager:${task}`, async () => {
                this.agent.bot.__psnALS = globalThis.__psnALS; await staged.func.main(this.agent.bot);
            }, { timeout: 5 });
            console.log(`[timing] game action attempt ${i} took ${Date.now() - this._runStart}ms`);   // fix23: measurement
            if (this.abort) { console.log('[voyager] task interrupted'); return; }
            const cut = res.interrupted || this._diedInRun() ? this._interruptReason(res.message) : '';   // fix14: cut-off code counts as a failed attempt
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
                : await this.critique(task, before, after, output);
            if (goal && gained >= goal.count) console.log(`[voyager] verified from inventory (+${gained} ${goal.item}), critic skipped`);
            console.log(`[voyager] attempt ${i} critic: success=${verdict.success} ${verdict.critique || ''}`);
            this._attribute(own, task, !!verdict.success, over);   // fix11 (B7)
            if (this._repairQueue?.some(x => x.target === own)) { console.log(`[psn] blame lands on the generated ${own} itself; the critic feedback loop fixes it (no library repair)`); this._repairQueue = this._repairQueue.filter(x => x.target !== own); }
            const lastTry = i >= MAX_ATTEMPTS || (!verdict.success && /travel|underground|died/.test(cut) && i >= 2);   // fix23: repeated travel cut-offs -> stop at 2 and decompose
            if (this._decomposeQueue?.task === task && !lastTry) this._decomposeQueue = null;   // still iterating; decomposition decided after the last attempt
            if (verdict.success) {
                this._lastEffects = Object.keys(after.inventory).filter(k => (after.inventory[k] || 0) > (before.inventory[k] || 0)).slice(0, 8);
                await this.saveSkill(fn[1], desc.trim(), code.replace(/\n\s*await\s+\w+\(bot\);\s*$/, '').trim(), task);
                this.progress.completed.push(task);
                this.progress.failed = this.progress.failed.filter(t => t !== task);
                this._saveProgress();
                this._subgoalDone(fn[1]);
                this.agent.openChat?.(`Done: ${task}. Learned skill ${fn[1]}.`);
                return;
            }
            feedback = `${cut ? `Attempt ${cut}\n` : ''}Execution output:\n${output}\nCritic: ${verdict.critique}\nChat/behaviour log: ${this.agent.bot.modes.flushBehaviorLog().slice(-400)}`;
            lastCode = code;
            if (lastTry) { if (i < MAX_ATTEMPTS) console.log(`[voyager] stopping after attempt ${i}: ${cut} (travel/death cut-off)`); break; }
        }
        this.progress.failed.push(task);
        this._saveProgress();
        console.log(`[voyager] task failed after ${MAX_ATTEMPTS} attempts: ${task}`);
        // fix19 (1): failed twice (recently) or cut off -> decompose
        const fails = this.progress.failed.slice(-20).filter(t => t === task).length;
        if (fails >= 2 || anyCut || this._decomposeQueue?.task === task) { if (this._decomposeQueue?.task === task) this._decomposeQueue = null; await this._decompose(task, anyCut || `failed ${fails}x; last critic: ${String(feedback).slice(-300)}`); }
        else if (this._curSub?.parent) console.log(`[psn] subgoal "${task}" failed; moving on`);
    }
}
