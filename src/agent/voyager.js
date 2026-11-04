import { wordOverlapScore } from '../utils/text.js';
// Voyager-style lifelong learning loop (after MineDojo/Voyager):
// automatic curriculum -> iterative code generation with env feedback -> self-verification critic -> skill library.
import { AsyncLocalStorage } from 'async_hooks';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import * as world from './library/world.js';
import * as skills from './library/skills.js';
import { getAllItems, getAllBlocks, getItemCraftingRecipes, isHostile, isDatapackHostile } from '../utils/mcdata.js';
import { cosineSimilarity } from '../utils/math.js';
import minecraftData from 'minecraft-data';
import { Ollama } from '../models/ollama.js';
import { signatureOf, depsOf, missingCalls, findCycle, newStats, recordRun, rate, gateLog, instrumentSrc, annotateTrace, traceText, blame, parentsOf } from './skill_graph.js';
const LOCAL = { model: 'qwen3:4b-instruct-2507-q4_K_M', url: 'http://192.168.1.215:11434', params: { keep_alive: '5m', format: 'json', options: { num_ctx: 8192 } } };
export const CALLS = { local: 0, code: 0, replay: 0 };

globalThis.__psnALS ||= new AsyncLocalStorage();   // fix11 (B6): call-parent tracking for PSN traces

const TOWN = { x: -1507, y: 63, z: 542 };
const VILLAGE = { x: -800, z: 500 };
const MAX_ATTEMPTS = 4;
const PLAYER_QUIET_MS = 90 * 1000;   // pause after any player message
const TASK_COOLDOWN_MS = 90 * 1000;  // gap between curriculum tasks (saves Gemini quota)
const HUT = { x: -1503, y: 64, z: 547 };
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

    get enabled() { return this.progress.enabled !== false; }
    setEnabled(v) { this.progress.enabled = v; this._saveProgress(); if (!v) this.interrupt(); }
    _saveProgress() { writeFileSync(this.progressFile, JSON.stringify(this.progress, null, 2)); }
    _saveSkills() { writeFileSync(this.indexFile, JSON.stringify(this.skills, null, 2)); }

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
            time: t < 12000 ? `day (${t})` : `night (${t})`,
            health: `${Math.round(bot.health)}/20`, food: `${bot.food}/20`,
            inventory: world.getInventoryCounts(bot),
            equipped: bot.heldItem ? bot.heldItem.name : 'nothing',
            nearby_blocks: world.getNearbyBlockTypes(bot, 16),
            nearby_entities: world.getNearbyEntityTypes(bot),
        };
    }
    _stateText(s) {
        return Object.entries(s).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
    }
    _local() {
        if (!this.__local) this.__local = new Ollama(LOCAL.model, LOCAL.url, LOCAL.params);
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
        const res = await this.agent.actions.runAction(`voyager:replay:${task}`, async () => { await staged.func.main(this.agent.bot); }, { timeout: 5 });
        if (this.abort || res.interrupted) return { ok: false, interrupted: true };
        const after = this.observe();
        let ok;
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
        return { ok, name: r.name, output: String(res.message || '') };
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
            if (!ok && c.stats.fail >= 2) { gateLog(`REJECT candidate ${entry.name}: failed ${c.stats.fail}/${n} trial runs; keeping current version`); delete entry.candidate; }
            else if (n >= 2 && rate(c.stats) >= rate(entry.stats || newStats())) { gateLog(`PROMOTE candidate ${entry.name}: trial ${c.stats.success}/${n} >= current rate ${rate(entry.stats || newStats()).toFixed(2)}`); this._promote(entry, c); }
            else gateLog(`candidate ${entry.name} trial ${ok ? 'passed' : 'failed'} (${c.stats.success}/${n}); waiting for more runs`);
        } else {
            entry.stats = recordRun(entry.stats || newStats(), task, ok);
            if (!ok && entry.stats.streakFail >= 3 && !entry.primitive && !entry.demoted) { entry.demoted = true; gateLog(`DEMOTE ${entry.name}: failed 3 times in a row (kept on disk, not replayed)`); }
        }
        this._saveSkills();
    }
    _promote(entry, c) {
        entry.prev = { code: entry.code, description: entry.description, deps: entry.deps, stats: entry.stats, saved: entry.saved };
        Object.assign(entry, { code: c.code, description: c.description, deps: c.deps, effects: c.effects, embedding: c.embedding, saved: new Date().toISOString(), stats: c.stats, demoted: false });
        delete entry.candidate;
        writeFileSync(`${this.dir}/${entry.name}.js`, `// ${entry.description}\n${entry.code}\n`);
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
        const res = await this.agent.actions.runAction(`voyager:gate:${entry.name}`, async () => { await staged.func.main(this.agent.bot); }, { timeout: 4 });
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
        const done = this.progress.milestones ||= [];
        const inv = state.inventory || {};
        const empty = this.agent.bot.inventory.emptySlotCount();
        if (empty < 3 && this.skills.some(s => s.name === 'depositToChest' && !s.demoted)) {
            console.log(`[voyager] inventory nearly full (${empty} empty slots): storing items before anything else`);
            return { task: 'Store items in a chest to free inventory space', reasoning: `inventory has ${empty} empty slots`, context: 'depositToChest' };
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
    async proposeTask(state) {
        const system = `You are the automatic curriculum for a Minecraft bot named ${this.agent.name} (Voyager-style).
Goal: discover as many diverse things as possible and grow a small town of its own, progressing wood -> stone -> iron -> diamond tech.
Rules:
- The bot's town is at x=${TOWN.x}, y=${TOWN.y}, z=${TOWN.z} in a birch forest (a birch hut already exists at x -1505..-1501, z 545..549). Stay within ~150 blocks of town.
- NEVER go near the players' village around x=${VILLAGE.x}, z=${VILLAGE.z}; never take or break player builds.
- Propose ONE concrete, verifiable task achievable in a few minutes with the current inventory and surroundings (e.g. "Mine 5 birch_log", "Craft 1 stone_pickaxe", "Smelt 3 iron_ingot", "Build a 5x5 cobblestone floor next to the hut").
- Do not repeat completed tasks unless needed for progress; avoid tasks that failed recently unless prerequisites are now met.
- If it is night and the bot is far from town or low health, propose returning to the hut / staying safe.
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
        if (!em) return null;
        try { const v = await em.embed(text); return Array.isArray(v?.[0]?.values) ? v[0].values : v; }
        catch (e) { console.warn('[voyager] embedding failed: ' + e.message); return null; }
    }
    async retrieveSkills(query, k = 5) {
        if (!this.skills.length) return [];
        const q = await this._embed(query);
        if (q) {  // re-embed skills saved with a different embedding model (e.g. nomic -> gemini-embedding-001)
            let changed = false;
            for (const s of this.skills) {
                if (!s.embedding || s.embedding.length !== q.length) { s.embedding = await this._embed(s.description); changed = true; }
            }
            if (changed) { this._saveSkills(); console.log('[voyager] re-embedded skill library with current embedding model'); }
        }
        // embeddings unavailable (e.g. Gemini 429) -> fall back to word overlap so retrieval still works
        const scored = this.skills.map(s => ({ s, score: (q && s.embedding && s.embedding.length === q.length)
            ? cosineSimilarity(q, s.embedding) : wordOverlapScore(query, `${s.name} ${s.description} ${s.task || ''}`) }));
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
            writeFileSync(`${this.dir}/${name}.js`, `// ${description}\n${code}\n`);
            this._saveSkills();
            gateLog(`NEW ${name} deps=[${deps.join(', ')}]`);
            this._extractShared();
            console.log(`[voyager] saved skill ${name}: ${description}`);
            return true;
        }
        // updating an existing skill (learned or handwritten): never overwrite directly
        const entry = this.skills[idx];
        if (entry.handwritten && !entry.handwritten_original) entry.handwritten_original = { code: entry.code, description: entry.description, deps: entry.deps };
        const cand = { code, description, deps, embedding, task, effects: this._lastEffects || entry.effects || [], stats: newStats() };   // fix11 (B2): no seeded success; trial runs only
        const reg = await this._regressionRun(entry, code);
        if (reg === true) { gateLog(`PROMOTE ${name}: passed regression rerun on a past task`); this._promote(entry, cand); }
        else if (reg === false) { gateLog(`REJECT update to ${name}: failed regression rerun on a past task; keeping current version`); }
        else if (opts.repair) { entry.candidate = cand; gateLog(`HOLD repair of ${name}: kept as candidate; needs 2+ trial runs with success rate >= current ${rate(entry.stats || newStats()).toFixed(2)}`); }   // fix11 (B3)
        else if (!(entry.stats?.success)) { gateLog(`PROMOTE ${name}: current version has no recorded successes`); this._promote(entry, cand); }
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
        writeFileSync(`${this.dir}/${name}.js`, `// ${e.description}\n${e.code}\n`);
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

    // ---------- iterative prompting ----------
    // deterministic survival step, no LLM: eat, then get to the hut / shelter at night or low health
    async safety() {
        const bot = this.agent.bot;
        const night = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay < 23500;
        const p = bot.entity.position;
        const far = Math.hypot(p.x - HUT.x, p.z - HUT.z) > 12 || Math.abs(p.y - HUT.y) > 4;
        const needFood = bot.food < 14 && bot.inventory.items().some(i => i.foodPoints || /cooked|bread|apple|carrot|potato|beef|porkchop|mutton|chicken|cod|salmon|stew/.test(i.name));
        const lowHealth = bot.health < 8;
        // fix6: long-range figure scan (48 blocks, all entities incl. mannequins); shelter in hut early
        const inHut = q => q.x >= HUT.x - 2 && q.x <= HUT.x + 3 && q.z >= HUT.z - 2 && q.z <= HUT.z + 3 && Math.abs(q.y - (HUT.y - 1)) <= 2;
        const fig = bot.nearestEntity(e => e !== bot.entity && isDatapackHostile(e) && e.position.distanceTo(p) < 48);
        if (fig) {
            const fd = fig.position.distanceTo(p);
            console.log(`[voyager] safety: datapack hostile (${fig.name}${fig.username ? ' ' + fig.username : ''}) ${fd.toFixed(1)} blocks away at ${fig.position.floored()}; inHut=${inHut(p)} night=${night}`);
            await this.agent.actions.runAction('voyager:safety:figure', async () => {
                if (inHut(p)) { await this._sealHut(); return; }
                const hutD = Math.hypot(p.x - HUT.x, p.z - HUT.z);
                const figHutD = Math.hypot(fig.position.x - HUT.x, fig.position.z - HUT.z);
                if (hutD < 64 && figHutD > 6) { await skills.goToPosition(bot, HUT.x, HUT.y - 1, HUT.z, 1); if (!bot.interrupt_code) await this._sealHut(); }
                else { await skills.avoidEnemies(bot, 48); if (night && !bot.interrupt_code) await skills.shelterNow(bot); }
            }, { timeout: 2 });
            return true;
        }
        if (night && inHut(p)) {   // fix6: stay inside at night, door shut
            if (!this._sealedAt || Date.now() - this._sealedAt > 60000) { console.log('[voyager] safety: night, staying in hut'); await this.agent.actions.runAction('voyager:safety:seal', async () => { await this._sealHut(); }, { timeout: 1 }); this._sealedAt = Date.now(); }
            return true;
        }
        if (!needFood && !(night && far) && !(lowHealth && far)) { this._safetyStuck = 0; return false; }
        // back off when safety keeps making no progress (e.g. stuck in a cave under the hut), so learning can continue
        if (Date.now() < (this._safetyBackoff || 0)) return false;
        const key = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
        this._safetyStuck = key === this._safetyLastPos ? (this._safetyStuck || 0) + 1 : 0;
        this._safetyLastPos = key;
        if (this._safetyStuck >= 3) { console.log(`[voyager] safety made no progress 3x at ${key}; pausing safety for 5 min`); this._safetyBackoff = Date.now() + 5 * 60 * 1000; this._safetyStuck = 0; return false; }
        console.log(`[voyager] safety first: food=${bot.food} health=${Math.round(bot.health)} night=${night} far=${far}`);
        await this.agent.actions.runAction('voyager:safety', async () => {
            if (needFood) await skills.consume(bot);
            if ((night || lowHealth) && far) {
                if (Math.hypot(p.x - HUT.x, p.z - HUT.z) <= 24 && p.y < HUT.y - 4) await skills.goToSurface(bot);   // underground below the hut
                if (bot.interrupt_code) return;
                await skills.travelTo(bot, HUT.x, HUT.y, HUT.z);
                const q = bot.entity.position;
                if (Math.hypot(q.x - HUT.x, q.z - HUT.z) > 6 && night) await skills.shelterNow(bot);
            }
        }, { timeout: 4 });
        return true;
    }

    // fix4: in-place inventory housekeeping during night safety / shelter (no walking): toss clutter, then
    // craft planks -> sticks -> crafting_table (placed adjacent) -> wooden_pickaxe from inventory
    async _housekeep() {
        const bot = this.agent.bot;
        if (this.abort || Date.now() < (this._houseNext || 0)) return;
        this._houseNext = Date.now() + 45 * 1000;
        const hostile = bot.nearestEntity(e => e !== bot.entity && (isHostile(e) || e.type === 'hostile' || /zombie|skeleton|creeper|spider|witch|drowned|husk|stray|enderman|slime|phantom/.test(e.name || '')));
        const hd = hostile ? hostile.position.distanceTo(bot.entity.position) : Infinity;
        const roof = bot.blockAt(bot.entity.position.offset(0, 2, 0));
        const sheltered = roof && roof.boundingBox === 'block';
        if (hd < 16 && !sheltered) { console.log(`[house] skipped: ${isDatapackHostile(hostile) ? 'DATAPACK FIGURE ' : ''}${hostile.name} ${hd.toFixed(1)} blocks away and not sheltered`); return; }
        const inv = () => world.getInventoryCounts(bot);
        const empty = bot.inventory.emptySlotCount();
        if (empty < 6) {
            console.log(`[house] ${empty} empty slots; tossing clutter in place (sheltered=${!!sheltered}, nearest hostile ${hd === Infinity ? 'none' : hd.toFixed(1)})`);
            const staged = await this.agent.coder._stageCode(this._libSrc() + '\n\nasync function __house(bot) { await tossClutter(bot, 6); }\nawait __house(bot);');
            if (!staged) { console.log('[house] FAILED to stage tossClutter'); return; }
            const hr = await this.agent.actions.runAction('voyager:housekeeping:toss', async () => { await staged.func.main(bot); }, { timeout: 2 });
            console.log(`[house] toss output: ${String(hr?.message || '(none)').split(/\n|\|/).filter(l => /\[toss\]/.test(l)).join(' | ').slice(-800)}`);
            console.log(`[house] after toss: ${bot.inventory.emptySlotCount()} empty slots`);
            return;
        }
        const c = inv();
        if (c.wooden_pickaxe || c.stone_pickaxe || c.iron_pickaxe || c.diamond_pickaxe) return;
        const log = Object.keys(c).find(n => /_log$/.test(n) && !/stripped/.test(n));
        const planks = () => Object.entries(inv()).filter(([n]) => /_planks$/.test(n)).reduce((a, [, v]) => a + v, 0);
        await this.agent.actions.runAction('voyager:housekeeping:craft', async () => {
            const step = async (what, fn) => { const ok = await fn(); console.log(`[house] craft ${what}: ${ok ? 'ok' : 'FAILED'}`); return ok; };
            const needPlanks = (c.crafting_table ? 0 : 4) + 3 + ((c.stick || 0) >= 2 ? 0 : 2);
            if (planks() < needPlanks && log) await step(`planks from ${log}`, () => skills.craftRecipe(bot, log.replace(/_log$/, '_planks'), 2));
            if (bot.interrupt_code) return;
            if ((inv().stick || 0) < 2 && planks() >= 2) {
                const pl = Object.keys(inv()).find(n => /_planks$/.test(n));
                await step('sticks', () => skills.craftRecipe(bot, 'stick', 1)); void pl;
            }
            if (bot.interrupt_code) return;
            if (!world.getNearestBlock(bot, 'crafting_table', 4)) {
                if (!inv().crafting_table && planks() >= 4) await step('crafting_table', () => skills.craftRecipe(bot, 'crafting_table', 1));
                if (inv().crafting_table) {
                    const me = bot.entity.position.floored();
                    let placed = false;
                    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
                        const t = me.offset(dx, 0, dz), b = bot.blockAt(t), below = bot.blockAt(t.offset(0, -1, 0));
                        if (b?.name === 'air' && below?.boundingBox === 'block') { placed = await skills.placeBlock(bot, 'crafting_table', t.x, t.y, t.z); if (placed) break; }
                    }
                    console.log(`[house] place crafting_table adjacent: ${placed ? 'ok' : 'FAILED (no free adjacent spot)'}`);
                }
            }
            if (bot.interrupt_code) return;
            if (world.getNearestBlock(bot, 'crafting_table', 4) && planks() >= 3 && (inv().stick || 0) >= 2)
                await step('wooden_pickaxe', () => skills.craftRecipe(bot, 'wooden_pickaxe', 1));
            else console.log(`[house] wooden_pickaxe not yet possible: planks=${planks()} sticks=${inv().stick || 0} log=${log || 'none'} table=${!!world.getNearestBlock(bot, 'crafting_table', 4)}`);
        }, { timeout: 2 });
        if (inv().wooden_pickaxe) console.log('[house] MILESTONE wooden_pickaxe crafted in place');
    }

    // fix6: close any open doors in/around the hut and fill open air gaps in the wall at feet/head level if we carry blocks
    async _sealHut() {
        const bot = this.agent.bot; const V = bot.entity.position.constructor;
        let closed = 0, filled = 0;
        for (let x = HUT.x - 3; x <= HUT.x + 3; x++) for (let z = HUT.z - 3; z <= HUT.z + 3; z++) for (let y = HUT.y - 2; y <= HUT.y + 1; y++) {
            const bl = bot.blockAt(new V(x, y, z)); if (!bl || !/_door$/.test(bl.name)) continue;
            const pr = bl.getProperties(); if (pr.half === 'upper' || !pr.open) continue;
            try { await bot.activateBlock(bl); closed++; } catch (e) { console.log(`[seal] could not close door at ${bl.position}: ${e.message}`); }
        }
        const filler = bot.inventory.items().find(i => /cobblestone|dirt|planks|stone$|deepslate/.test(i.name));
        if (filler) for (let x = HUT.x - 3; x <= HUT.x + 3; x++) for (let z = HUT.z - 3; z <= HUT.z + 3; z++) {
            if (!(x === HUT.x - 3 || x === HUT.x + 3 || z === HUT.z - 3 || z === HUT.z + 3)) continue;
            for (const y of [HUT.y - 1, HUT.y]) { const bl = bot.blockAt(new V(x, y, z)); const inner = bot.blockAt(new V(Math.max(HUT.x - 2, Math.min(HUT.x + 2, x)), y, Math.max(HUT.z - 2, Math.min(HUT.z + 2, z))));
                if (bl && bl.name === 'air' && inner && inner.name === 'air') { try { await skills.placeBlock(bot, filler.name, x, y, z, 'bottom', true); filled++; } catch (e) {} } }
        }
        console.log(`[seal] hut: closed ${closed} door(s), filled ${filled} gap(s)${filler ? '' : ' (no filler blocks carried)'}`);
    }

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
        const TP = '/execute in minecraft:overworld run tp icefox2000 -1503 63 547';
        this._dimTimer = setInterval(() => {
            const dim = String(bot.game?.dimension || '');
            if (dim !== this._lastDim) { this._lastDim = dim; console.log(`[dimension] now ${dim}`); }
            if (!/abh:/.test(dim)) { if (this._abhSince) { console.log(`[dimension] back in ${dim} after ${Math.round((Date.now() - this._abhSince) / 1000)}s in abh dimension`); bot.setControlState('sneak', false); } this._abhSince = 0; return; }
            if (!this._abhSince) { this._abhSince = Date.now(); console.log(`!!! [dimension] in datapack dimension ${dim}; trying normal exit${dim === 'abh:truth' ? ' (sneak)' : ' (none in pack; waiting 60s)'}`); }
            if (dim === 'abh:truth') { bot.setControlState('sneak', true); setTimeout(() => bot.setControlState('sneak', false), 1500); }
            const waited = Date.now() - this._abhSince;
            if (waited > 60000 && Date.now() - (this._abhTpAt || 0) > 120000) {
                this._abhTpAt = Date.now();
                console.log(`!!! [dimension] still in ${dim} after ${Math.round(waited / 1000)}s; sending pre-approved command: ${TP}`);
                bot.chat(TP);
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
    _isLeaf(name) { const e = this.skills.find(s => s.name === name); return !!e && !!(e.primitive || e.handwritten) && !(e.deps || []).length; }
    _attribute(root, task, ok, over) {
        const bot = this.agent.bot, trace = bot.__psnTrace;
        bot.__psnTrace = null;
        if (!Array.isArray(trace) || !trace.length) { console.log('[psn] no execution trace recorded'); return; }
        annotateTrace(trace, bot.__psnOut || '');
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
        if (ok && !revalFail) return;
        console.log(`[psn] execution trace of ${root} (${trace.length} calls):\n${traceText(trace)}`);
        const b = blame(trace, n => this._isLeaf(n));
        if (!b) { console.log(`[psn] blame: every call met its contract; failure is in the task outcome, not a dependency`); return; }
        console.log(`[psn] blame: ${b.target || '(none editable)'} [${b.kind}${b.swallowed ? ', swallowed' : ''}] via ${b.path.join(' > ')}; deepest failure ${b.leaf}: ${b.evidence}`);
        if (b.target) this._repairQueue = { ...b, task, trace: traceText(trace, 60) };
    }
    // targeted repair of the blamed skill via the code model, through the normal regression gate (saveSkill)
    async _repair() {
        const q = this._repairQueue; this._repairQueue = null;
        if (!q) return false;
        const e = this.skills.find(s => s.name === q.target);
        if (!e) { console.log(`[psn] repair FAILED: blamed skill ${q.target} not in library`); return false; }
        this._repairs = (this.progress.repairs ||= {});   // fix11 (B8): repair cap persisted in progress.json
        if (Date.now() - (this._repairs[e.name] || 0) < 30 * 60e3) { console.log(`[psn] repair of ${e.name} skipped: already repaired in the last 30 min (cap)`); return false; }
        if (e.candidate) { console.log(`[psn] repair of ${e.name} skipped: a candidate is already under trial`); return false; }
        if (this._cursorLimited()) { console.log(`[psn] repair of ${e.name} skipped: code model at its limit`); return false; }
        this._repairs[e.name] = Date.now(); this._saveProgress();
        const kids = [...this._closure(e.name)].map(n => this.skills.find(s => s.name === n)).filter(Boolean);
        const system = `You repair ONE skill in a Minecraft mineflayer skill library (PSN-style targeted fix). Return a single \`\`\`javascript code block containing ONLY the fixed function, with the SAME name and a compatible signature. First line inside the block: // DESCRIPTION: <one sentence>. Call other library skills by name (they are in scope); never redefine them. Every loop must check bot.interrupt_code. If something still cannot be done, log(bot, 'FAILED: <reason>') and return a falsy value; no silent fallbacks.\nLIBRARY:\n${this.catalogue()}`;
        const user = `Blamed skill: ${e.name} (${q.kind === 'caller_fix' ? 'it calls the leaf ' + q.leaf + ' in a situation where the leaf cannot succeed: fix how/when it calls it, e.g. obtain the missing prerequisite first' : 'its own logic failed'})\nTask that failed: ${q.task}\nFailure path: ${q.path.join(' > ')}\nEvidence: ${q.evidence}\n--- execution trace (indent = call depth) ---\n${q.trace}\n--- current code of ${e.name} ---\n${e.code}\n--- skills it uses ---\n${kids.map(k => '// ' + k.description + '\n' + signatureOf(k.code, k.name)).join('\n')}\nWrite the fixed ${e.name}:`;
        console.log(`[psn] REPAIR ${e.name} [${q.kind}] with the code model (evidence: ${q.evidence.slice(0, 160)})`);
        let reply;
        try { reply = await this._ask(system, user); } catch (err) { console.log(`[psn] repair FAILED for ${e.name}: ${err.message}`); return false; }
        const code = extractCode(reply);
        const fn = code && code.match(/async\s+function\s+([A-Za-z_]\w*)\s*\(/);
        if (!fn || fn[1] !== e.name) { console.log(`[psn] repair FAILED for ${e.name}: reply did not define async function ${e.name}`); return false; }
        const desc = ((code.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || e.description).trim();
        const body = code.replace(/\n\s*await\s+\w+\(bot[^)]*\);\s*$/, '').trim();
        const staged = await this.agent.coder._stageCode(this._libSrc({ [e.name]: body }));
        const lint = staged ? await this.agent.coder._lintCode(staged.src_lint_copy) : 'staging failed';
        if (lint) { console.log(`[psn] repair FAILED for ${e.name}: lint: ${String(lint).slice(0, 300)}`); return false; }
        this._lastEffects = e.effects || [];
        const saved = await this.saveSkill(e.name, desc, body, `repair: ${q.task}`, { repair: true });
        if (!saved) { console.log(`[psn] repair of ${e.name} rejected by the gate`); return false; }
        console.log(`[psn] repaired ${e.name}: submitted to the gate (parents are re-validated once it is promoted)`);
        return true;
    }

    async step() {
        this._watchWindows();
        this._watchDimension();
        if (this.agent.bot.currentWindow) { const w = this.agent.bot.currentWindow; if (/CHOICE/.test(JSON.stringify(w.title))) { if (!this._choiceNoted) { this._choiceNoted = 1; console.log("[window] datapack dialog CHOICE (A Breach Happened multi_action dialog via ViaProxy) left open; not answering"); } } else console.log(`[window] STRAY ${w.type} id=${w.id} still open at step start (opened ${Math.round((Date.now() - (this._winOpenedAt || 0)) / 1000)}s ago); closing`); if (!/CHOICE/.test(JSON.stringify(w.title))) try { this.agent.bot.closeWindow(w); } catch (e) { console.log('[window] close failed: ' + e.message); } }
        this._oneshot();
        if (await this.safety()) { await this._housekeep(); return; }
        if (await this._leash()) return;
        if (this._repairQueue) { await this._repair(); return; }
        const before = this.observe();
        let proposal = this._milestoneTask(before) || await this.proposeTask(before);
        let task = String(proposal.task || '').trim();
        let invalid = task ? validateTask(task) : 'empty task';
        if (invalid) {
            console.log(`[voyager] rejected task "${task}": ${invalid}`);
            this.progress.failed.push(`${task} (invalid: ${invalid})`);
            proposal = await this.proposeTask({ ...before, note: `Your last proposal "${task}" was rejected: ${invalid}` });
            task = String(proposal.task || '').trim();
            invalid = task ? validateTask(task) : 'empty task';
            if (invalid) { console.log(`[voyager] rejected again "${task}": ${invalid}; skipping`); this._saveProgress(); return; }
        }
        console.log(`[voyager] new task: ${task} (${proposal.reasoning})`);
        this.currentTask = task;
        VERSION = this.agent.bot.version;
        const rp = await this._replay(task, before);
        if (rp?.interrupted) { console.log('[voyager] task interrupted'); return; }
        if (rp?.ok) {
            this.progress.completed.push(task); this.progress.failed = this.progress.failed.filter(t => t !== task); this._saveProgress();
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

        let feedback = '';
        let lastCode = '';
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
            const full = libOthers.map(s => s.code).join('\n\n') + '\n\n' + code;
            const plain = await this.agent.coder._stageCode(full);
            const lint = plain ? await this.agent.coder._lintCode(plain.src_lint_copy) : 'staging failed';
            // fix11 (B7): run the generated code with the PSN trace wrapper (rebinding happens before the code's own top-level call)
            const traced = [...libOthers.map(s => s.name), own];
            const staged = lint ? null : await this.agent.coder._stageCode(libOthers.map(s => s.code).join('\n\n') + '\n\n' + instrumentSrc(traced) + '\n\n' + code);
            if (!lint && !staged) throw new Error('[psn] staging of traced generated code failed');
            if (lint) { console.log('[voyager] lint failed: ' + String(lint).slice(0, 300)); feedback = 'Lint error:\n' + lint; lastCode = code; continue; }

            const res = await this.agent.actions.runAction(`voyager:${task}`, async () => {
                await staged.func.main(this.agent.bot);
            }, { timeout: 5 });
            if (this.abort || res.interrupted) { console.log('[voyager] task interrupted'); return; }
            const output = String(res.message || '').slice(-1500);
            const after = this.observe();
            const goal = countGoal(task);
            const gained = goal ? gainedFor(goal, before, after) : 0;
            const verdict = (goal && gained >= goal.count)
                ? { success: true, critique: '', reasoning: `inventory +${gained} ${goal.item}` }
                : await this.critique(task, before, after, output);
            if (goal && gained >= goal.count) console.log(`[voyager] verified from inventory (+${gained} ${goal.item}), critic skipped`);
            console.log(`[voyager] attempt ${i} critic: success=${verdict.success} ${verdict.critique || ''}`);
            this._attribute(own, task, !!verdict.success, {});   // fix11 (B7)
            if (this._repairQueue?.target === own) { console.log(`[psn] blame lands on the generated ${own} itself; the critic feedback loop fixes it (no library repair)`); this._repairQueue = null; }
            if (verdict.success) {
                this._lastEffects = Object.keys(after.inventory).filter(k => (after.inventory[k] || 0) > (before.inventory[k] || 0)).slice(0, 8);
                await this.saveSkill(fn[1], desc.trim(), code.replace(/\n\s*await\s+\w+\(bot\);\s*$/, '').trim(), task);
                this.progress.completed.push(task);
                this.progress.failed = this.progress.failed.filter(t => t !== task);
                this._saveProgress();
                this.agent.openChat?.(`Done: ${task}. Learned skill ${fn[1]}.`);
                return;
            }
            feedback = `Execution output:\n${output}\nCritic: ${verdict.critique}\nChat/behaviour log: ${this.agent.bot.modes.flushBehaviorLog().slice(-400)}`;
            lastCode = code;
        }
        this.progress.failed.push(task);
        this._saveProgress();
        console.log(`[voyager] task failed after ${MAX_ATTEMPTS} attempts: ${task}`);
    }
}
