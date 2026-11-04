import { CodeModelWithFallback } from './code_fallback.js';
import { OpenAIStrict } from './openai_strict.js';
import { hasKey } from '../utils/keys.js';
import { readFileSync, mkdirSync, writeFileSync, renameSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;
        const defaults_dir = path.join(__dirname, '../../profiles/defaults');
        let default_profile = JSON.parse(readFileSync(path.join(defaults_dir, '_default.json'), 'utf8'));
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = path.join(defaults_dir, 'survival.json');
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = path.join(defaults_dir, 'assistant.json');
        } else if (settings.base_profile.includes('creative')) {
            base_fp = path.join(defaults_dir, 'creative.json');
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = path.join(defaults_dir, 'god_mode.json');
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        // for backwards compatibility, move max_tokens to params
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = selectAPI(this.profile.model);
        this.chat_model = createModel(chat_model_profile);
        // Gemini only: on 429/quota the wrapper pauses for 60 min and fails loudly (no local fallback).
        this.chat_model = new CodeModelWithFallback(this.chat_model, null, 60 * 60 * 1000, 'chat-model');

        if (this.profile.code_model) {
            let code_model_profile = selectAPI(this.profile.code_model);
            this.code_model = createModel(code_model_profile);
            // usage limit: pause and re-check every 60 min (no fallback; OpenAI backup disabled by Mo)
            const isCursor = code_model_profile.api === 'cursor';
            // cursor usage limit -> OpenAI backup (profile.code_backup) if configured; retry cursor hourly while on backup
            const bk = this.profile.code_backup;
            const backup = (isCursor && bk && hasKey('OPENAI_API_KEY')) ? new OpenAIStrict(bk.model, bk.params || {}) : null;
            this.code_model = new CodeModelWithFallback(this.code_model, backup, 60 * 60 * 1000, 'code-model');
            if (backup) { this.code_model.switchOn = /usage limit|limit reached|quota/i; console.log(`[code-model] backup on cursor usage limit: openai ${bk.model}`); }
            this.code_model.timeoutMs = isCursor ? 180 * 1000 : this.code_model.timeoutMs;
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = selectAPI(this.profile.vision_model);
            this.vision_model = createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        
        let embedding_model_profile = null;
        if (this.profile.embedding) {
            embedding_model_profile = selectAPI(this.profile.embedding);
        }
        // fix14: embeddings are the only skill/example search path; no fallback
        if (!embedding_model_profile) throw new Error('profile.embedding is required (no fallback)');
        this.embedding_model = createModel(embedding_model_profile);

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        { const lp = `./bots/${name}/last_profile.json`; writeFileSync(lp + ".tmp", JSON.stringify(this.profile, null, 4)); renameSync(lp + ".tmp", lp); }
    }

    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            // fix14: embedding-based example selection (local nomic-embed-text)
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    _positionsText() {
        // richer surroundings for Gemini: nearest coords of each block type + entities with positions
        try {
            const bot = this.agent.bot; const me = bot.entity.position;
            const f = p => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
            let out = 'NEARBY_POSITIONS (nearest of each, within 16)';
            const seen = new Set();
            const blocks = bot.findBlocks({ matching: b => b && b.name !== 'air' && b.name !== 'cave_air', maxDistance: 16, count: 4000 });
            for (const p of blocks) {
                const b = bot.blockAt(p); if (!b || seen.has(b.name)) continue;
                seen.add(b.name); out += `\n- ${b.name} at ${f(p)} (${Math.round(p.distanceTo(me))}m)`;
                if (seen.size >= 25) break;
            }
            const ents = Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(me) <= 32)
                .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me)).slice(0, 15);
            for (const e of ents) out += `\n- ${e.username || e.name || e.type} at ${f(e.position)} (${Math.round(e.position.distanceTo(me))}m)`;
            return out;
        } catch (e) { return 'NEARBY_POSITIONS: unavailable (' + e.message + ')'; }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent) + '\n';
            stats += await getCommand('!entities').perform(this.agent) + '\n';
            stats += await getCommand('!nearbyBlocks').perform(this.agent);
            stats += '\n' + this._positionsText();
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY'))
            prompt = prompt.replaceAll('$MEMORY', this.agent.history.memory);
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages) {
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            await this.checkCooldown();
            if (current_msg_time !== this.most_recent_msg_time) {
                return '';
            }

            let prompt = this.profile.conversing;
            prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
            let generation;

            try {
                try { writeFileSync('/tmp/icefox_chat_prompt.txt', prompt); } catch (e) {}
                generation = await this.chat_model.sendRequest(messages, prompt);
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                // small model parrots the error string from history; strip it when real content follows
                if (generation.trim() !== "My brain disconnected, try again." && generation.includes("My brain disconnected, try again.")) {
                    generation = generation.replace(/My brain disconnected, try again\.\s*/g, "").trim();
                }
                console.log("Generated response:", generation);
                await this._saveLog(prompt, messages, generation, 'conversation');

            } catch (error) {
                console.error('Error during message generation or file writing:', error);
                continue;
            }

            // Check for hallucination or invalid output
            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                continue;
            }

            if (current_msg_time !== this.most_recent_msg_time) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return '';
            }

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>')
                generation = afterThink
            }

            return generation;
        }

        return '';
    }

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        let resp;
        try {
            try { writeFileSync('/tmp/icefox_code_prompt.txt', prompt); } catch (e) {}
            resp = await this.code_model.sendRequest(messages, prompt);
        } finally {
            this.awaiting_coding = false; // never leave coding locked after an error
        }
        await this._saveLog(prompt, messages, resp, 'coding');
        return resp;
    }

    async promptMemSaving(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        let resp = await this.chat_model.sendRequest([], prompt);
        await this._saveLog(prompt, to_summarize, resp, 'memSaving');
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>')
            resp = afterThink;
        }
        return resp;
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.chat_model.sendRequest([], prompt);
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        return await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer);
    }

    async promptGoalSetting(messages, last_goals) {
        // deprecated
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}
