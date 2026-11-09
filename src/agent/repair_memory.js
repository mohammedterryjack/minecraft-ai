// AWM-style repair/workflow memory (after https://arxiv.org/abs/2409.07429)
// Stores repair outcomes with error signatures and retrieves past lessons for coder retry feedback.
// Optionally extracts short workflows from successful multi-step runs.

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { writeAtomic } from './voyager.js';
import { cosineSimilarity } from '../utils/math.js';

const MAX_ENTRIES = 200;
const MAX_WORKFLOWS = 50;

export class RepairMemory {
    constructor(botName, embedFn = null) {
        this.botName = botName;
        this.dir = `./bots/${botName}`;
        this.file = `${this.dir}/repair_memory.json`;
        this.embedFn = embedFn;
        mkdirSync(this.dir, { recursive: true });
        this._load();
    }

    _load() {
        try {
            if (existsSync(this.file)) {
                const data = JSON.parse(readFileSync(this.file, 'utf8'));
                this.repairs = data.repairs || [];
                this.workflows = data.workflows || [];
                this.lastUpdated = data.lastUpdated || null;
                console.log(`[repair-memory] loaded ${this.repairs.length} repair lessons, ${this.workflows.length} workflows from ${this.file}`);
            } else {
                this.repairs = [];
                this.workflows = [];
                this.lastUpdated = null;
                console.log(`[repair-memory] initialized empty memory`);
            }
        } catch (e) {
            throw new Error(`[repair-memory] FAILED to load ${this.file}: ${e.message}`);
        }
    }

    _save() {
        try {
            this.lastUpdated = new Date().toISOString();
            writeAtomic(this.file, JSON.stringify({
                repairs: this.repairs,
                workflows: this.workflows,
                lastUpdated: this.lastUpdated,
            }, null, 2));
        } catch (e) {
            throw new Error(`[repair-memory] FAILED to persist to ${this.file}: ${e.message}`);
        }
    }

    normalizeError(error) {
        if (!error) return '';
        let sig = String(error).toLowerCase();
        sig = sig.replace(/\d+/g, 'N');
        sig = sig.replace(/at line \w+/g, 'at line N');
        sig = sig.replace(/position \([\d.,\s-]+\)/g, 'position (N,N,N)');
        sig = sig.replace(/\b[a-f0-9]{8,}\b/g, 'HASH');
        sig = sig.replace(/['"][^'"]+['"]/g, '"X"');
        sig = sig.slice(0, 200);
        return sig;
    }

    // fix96: entries are stored whole (errorRaw, fixSnippet, taskHint were cut at 300/500/200 chars and shown cut again at
    //        150/200 in every repair prompt); repair lessons now carry the change's description, not the head of its code
    async recordRepair({ errorSignature, fixSnippet, outcome, taskHint, skillName }) {
        if (!errorSignature) return;
        
        const entry = {
            id: `repair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            errorSignature: this.normalizeError(errorSignature),
            errorRaw: String(errorSignature),
            fixSnippet: String(fixSnippet || ''),
            outcome: outcome === true ? 'success' : outcome === false ? 'failure' : String(outcome),
            taskHint: String(taskHint || ''),
            skillName: String(skillName || ''),
            timestamp: new Date().toISOString(),
            embedding: null,
        };
        
        if (this.embedFn && entry.errorSignature) {
            try {
                entry.embedding = await this.embedFn(entry.errorSignature);
            } catch (e) {
                console.log(`[repair-memory] embedding failed (continuing without): ${e.message}`);
            }
        }
        
        this.repairs.unshift(entry);
        
        if (outcome === 'success') {
            const existing = this.repairs.findIndex((r, i) => 
                i > 0 && r.errorSignature === entry.errorSignature && r.outcome === 'success'
            );
            if (existing > 0) {
                this.repairs.splice(existing, 1);
            }
        }
        
        this._cap();
        this._save();
        
        console.log(`[repair-memory] recorded ${entry.outcome} repair for "${entry.skillName}": ${entry.errorSignature.slice(0, 60)}...`);
    }

    _cap() {
        if (this.repairs.length > MAX_ENTRIES) {
            const successes = this.repairs.filter(r => r.outcome === 'success');
            const failures = this.repairs.filter(r => r.outcome !== 'success');
            const keepSuccesses = successes.slice(0, Math.floor(MAX_ENTRIES * 0.7));
            const keepFailures = failures.slice(0, MAX_ENTRIES - keepSuccesses.length);
            this.repairs = [...keepSuccesses, ...keepFailures].sort((a, b) => 
                new Date(b.timestamp) - new Date(a.timestamp)
            );
        }
        if (this.workflows.length > MAX_WORKFLOWS) {
            this.workflows = this.workflows.slice(0, MAX_WORKFLOWS);
        }
    }

    async retrieveSimilar(errorSignature, limit = 3) {
        if (!errorSignature || !this.repairs.length) return [];
        
        const normSig = this.normalizeError(errorSignature);
        let results = [];
        
        const exactMatches = this.repairs.filter(r => r.errorSignature === normSig);
        if (exactMatches.length) {
            results = exactMatches.slice(0, limit);
        } else if (this.embedFn) {
            try {
                const queryEmb = await this.embedFn(normSig);
                const withScores = this.repairs
                    .filter(r => r.embedding && r.embedding.length === queryEmb.length)
                    .map(r => ({ ...r, score: cosineSimilarity(queryEmb, r.embedding) }))
                    .filter(r => r.score > 0.7)
                    .sort((a, b) => b.score - a.score);
                results = withScores.slice(0, limit);
            } catch (e) {
                console.log(`[repair-memory] embedding retrieval failed: ${e.message}`);
            }
        }
        
        if (!results.length) {
            const fuzzyMatches = this.repairs
                .map(r => ({ ...r, score: this._fuzzyScore(normSig, r.errorSignature) }))
                .filter(r => r.score > 0.3)
                .sort((a, b) => b.score - a.score);
            results = fuzzyMatches.slice(0, limit);
        }
        
        return results;
    }

    _fuzzyScore(a, b) {
        if (!a || !b) return 0;
        const wordsA = new Set(a.split(/\s+/));
        const wordsB = new Set(b.split(/\s+/));
        const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
        const union = new Set([...wordsA, ...wordsB]).size;
        return union ? intersection / union : 0;
    }

    formatHintsForCoder(lessons) {
        if (!lessons?.length) return '';
        
        const hints = lessons.map((r, i) => {
            const outcomeIcon = r.outcome === 'success' ? '✓' : '✗';
            return `${i + 1}. [${outcomeIcon}] Error pattern: ${r.errorRaw}
   ${r.outcome === 'success' ? 'Successful fix' : 'Failed attempt'}: ${r.fixSnippet}${r.taskHint ? `\n   Context: ${r.taskHint}` : ''}`;
        }).join('\n');
        
        return `PAST REPAIR EXPERIENCE (hints, not rules - adapt as needed):
${hints}`;
    }

    recordWorkflow({ steps, task, outcome }) {
        if (!steps?.length || steps.length < 2) return;
        
        const workflow = {
            id: `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            task: String(task || ''),
            steps: steps.map(s => String(s)),
            outcome: outcome === true ? 'success' : outcome === false ? 'failure' : String(outcome),
            timestamp: new Date().toISOString(),
        };
        
        this.workflows.unshift(workflow);
        this._cap();
        this._save();
        
        console.log(`[repair-memory] recorded workflow for "${task}": ${steps.length} steps, ${outcome}`);
    }

    getWorkflowsForTask(taskKeywords, limit = 2) {
        if (!taskKeywords || !this.workflows.length) return [];
        
        const keywords = String(taskKeywords).toLowerCase().split(/\s+/).filter(w => w.length > 2);
        
        return this.workflows
            .filter(w => w.outcome === 'success')
            .map(w => {
                const taskWords = w.task.toLowerCase().split(/\s+/);
                const matchCount = keywords.filter(k => taskWords.some(tw => tw.includes(k))).length;
                return { ...w, score: matchCount / keywords.length };
            })
            .filter(w => w.score > 0.3)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    formatWorkflowHints(workflows) {
        if (!workflows?.length) return '';
        
        return `PAST SUCCESSFUL WORKFLOWS (reference, adapt as needed):
${workflows.map((w, i) => `${i + 1}. "${w.task}": ${w.steps.join(' -> ')}`).join('\n')}`;
    }
}
