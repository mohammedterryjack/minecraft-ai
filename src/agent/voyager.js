// Voyager-style lifelong learning loop (after MineDojo/Voyager):
// automatic curriculum -> iterative code generation with env feedback -> self-verification critic -> skill library.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import * as world from './library/world.js';
import { cosineSimilarity } from '../utils/math.js';

const TOWN = { x: -1507, y: 63, z: 542 };
const VILLAGE = { x: -800, z: 500 };
const MAX_ATTEMPTS = 4;
const PLAYER_QUIET_MS = 90 * 1000;   // pause after any player message
const TASK_COOLDOWN_MS = 5 * 1000;

function parseJSON(text) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in model reply: ' + String(text).slice(0, 200));
    return JSON.parse(m[0]);
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
            health: bot.health, food: bot.food,
            inventory: world.getInventoryCounts(bot),
            equipped: bot.heldItem ? bot.heldItem.name : 'nothing',
            nearby_blocks: world.getNearbyBlockTypes(bot, 16),
            nearby_entities: world.getNearbyEntityTypes(bot),
        };
    }
    _stateText(s) {
        return Object.entries(s).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
    }
    async _ask(system, user) {
        // code model = gemini-3.6-flash (quota-only switch to local lives in CodeModelWithFallback)
        return await this.agent.prompter.code_model.sendRequest([{ role: 'user', content: user }], system);
    }

    // ---------- automatic curriculum ----------
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
known_skills: ${JSON.stringify(this.skills.map(s => s.name))}`;
        return parseJSON(await this._ask(system, user));
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
        const scored = this.skills.map(s => ({ s, score: (q && s.embedding) ? cosineSimilarity(q, s.embedding) : 0 }));
        return scored.sort((a, b) => b.score - a.score).slice(0, k).map(x => x.s);
    }
    async saveSkill(name, description, code, task) {
        const existing = this.skills.findIndex(s => s.name === name);
        const entry = { name, description, task, code, embedding: await this._embed(description), saved: new Date().toISOString() };
        if (existing >= 0) this.skills[existing] = entry; else this.skills.push(entry);
        writeFileSync(`${this.dir}/${name}.js`, `// ${description}\n${code}\n`);
        this._saveSkills();
        console.log(`[voyager] saved skill ${name}: ${description}`);
    }

    // ---------- critic ----------
    async critique(task, before, after, output) {
        const system = `You are an assistant that checks whether a Minecraft bot completed its task, using its state before and after and the code output.
Be strict: success only if the evidence (inventory/position/output) shows the task is done.
Reply ONLY with JSON: {"reasoning": "...", "success": true|false, "critique": "how to fix it if failed, else empty"}`;
        const user = `task: ${task}\n--- before ---\n${this._stateText(before)}\n--- after ---\n${this._stateText(after)}\n--- code output ---\n${output}`;
        return parseJSON(await this._ask(system, user));
    }

    // ---------- iterative prompting ----------
    async step() {
        const before = this.observe();
        const proposal = await this.proposeTask(before);
        const task = String(proposal.task || '').trim();
        if (!task) throw new Error('curriculum returned no task');
        console.log(`[voyager] new task: ${task} (${proposal.reasoning})`);
        this.agent.openChat?.(`New goal: ${task}`);
        const related = await this.retrieveSkills(task + ' ' + (proposal.context || ''));
        const prompter = this.agent.prompter;
        let system = await prompter.replaceStrings(prompter.profile.coding, [{ role: "user", content: `!newAction(${task})` }], prompter.coding_examples);
        system += `\n\nVOYAGER MODE: write ONE reusable async function \`async function camelCaseName(bot) {...}\` that completes the task, then call it at the end with \`await camelCaseName(bot);\`.
The first line of the code block must be a comment: // DESCRIPTION: <one sentence of what the function does>.
You may call these previously learned skills (already defined, do not redefine them): ${related.map(s => s.name).join(', ') || '(none yet)'}.`;
        const learnedSrc = related.map(s => s.code).join('\n\n');
        const ctx = related.map(s => `// ${s.description}\n${s.code}`).join('\n\n');

        let feedback = '';
        let lastCode = '';
        for (let i = 1; i <= MAX_ATTEMPTS; i++) {
            if (this.abort) { console.log('[voyager] aborted for player'); return; }
            const user = `Task: ${task}\nHint: ${proposal.context || ''}\n--- state ---\n${this._stateText(this.observe())}
--- learned skills you can call ---\n${ctx || '(none)'}
${lastCode ? `--- your previous code ---\n${lastCode}\n` : ''}${feedback ? `--- feedback from last attempt ---\n${feedback}\n` : ''}Attempt ${i}/${MAX_ATTEMPTS}. Write the code block:`;
            const reply = await this._ask(system, user);
            const code = extractCode(reply);
            if (!code) { feedback = 'Error: no code block. Reply with a ```javascript``` code block.'; continue; }
            const fn = code.match(/async\s+function\s+([A-Za-z_]\w*)\s*\(/);
            if (!fn) { feedback = 'Error: code must define `async function name(bot)` and call it.'; lastCode = code; continue; }
            const desc = (code.match(/\/\/\s*DESCRIPTION:\s*(.+)/) || [])[1] || task;
            const full = (learnedSrc ? learnedSrc + '\n\n' : '') + code;
            const staged = await this.agent.coder._stageCode(full);
            const lint = staged ? await this.agent.coder._lintCode(staged.src_lint_copy) : 'staging failed';
            if (lint) { feedback = 'Lint error:\n' + lint; lastCode = code; continue; }

            const res = await this.agent.actions.runAction(`voyager:${task}`, async () => {
                await staged.func.main(this.agent.bot);
            }, { timeout: 5 });
            if (this.abort || res.interrupted) { console.log('[voyager] task interrupted'); return; }
            const output = String(res.message || '').slice(-1500);
            const after = this.observe();
            const verdict = await this.critique(task, before, after, output);
            console.log(`[voyager] attempt ${i} critic: success=${verdict.success} ${verdict.critique || ''}`);
            if (verdict.success) {
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
