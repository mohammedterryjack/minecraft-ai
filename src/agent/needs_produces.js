// ADAM-style needs/produces graph (after https://arxiv.org/abs/2410.22194)
// Learns item relationships from observed inventory deltas during skill/task runs.
// Links are confirmed only when observed repeatedly (threshold-based learning).

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { writeAtomic } from './voyager.js';

const CONFIRM_THRESHOLD = 3;

export class NeedsProducesGraph {
    constructor(botName) {
        this.botName = botName;
        this.dir = `./bots/${botName}`;
        this.file = `${this.dir}/needs_produces.json`;
        mkdirSync(this.dir, { recursive: true });
        this._load();
    }

    _load() {
        try {
            if (existsSync(this.file)) {
                const data = JSON.parse(readFileSync(this.file, 'utf8'));
                this.observations = data.observations || {};
                this.confirmed = data.confirmed || {};
                this.lastUpdated = data.lastUpdated || null;
                console.log(`[needs/produces] loaded ${Object.keys(this.confirmed).length} confirmed links from ${this.file}`);
            } else {
                this.observations = {};
                this.confirmed = {};
                this.lastUpdated = null;
                console.log(`[needs/produces] initialized empty graph`);
            }
        } catch (e) {
            throw new Error(`[needs/produces] FAILED to load ${this.file}: ${e.message}`);
        }
    }

    _save() {
        try {
            this.lastUpdated = new Date().toISOString();
            writeAtomic(this.file, JSON.stringify({
                observations: this.observations,
                confirmed: this.confirmed,
                lastUpdated: this.lastUpdated,
            }, null, 2));
        } catch (e) {
            throw new Error(`[needs/produces] FAILED to persist to ${this.file}: ${e.message}`);
        }
    }

    recordDelta(skillOrTask, beforeInv, afterInv) {
        if (!skillOrTask || typeof skillOrTask !== 'string') return;
        const key = skillOrTask.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80);
        
        const consumed = [];
        const produced = [];
        
        const allItems = new Set([...Object.keys(beforeInv || {}), ...Object.keys(afterInv || {})]);
        for (const item of allItems) {
            const before = beforeInv?.[item] || 0;
            const after = afterInv?.[item] || 0;
            const delta = after - before;
            if (delta < 0) consumed.push({ item, count: -delta });
            if (delta > 0) produced.push({ item, count: delta });
        }
        
        if (!consumed.length && !produced.length) return;
        
        const obs = (this.observations[key] ||= { needs: {}, produces: {}, runs: 0 });
        obs.runs++;
        obs.lastRun = new Date().toISOString();
        
        for (const { item, count } of consumed) {
            obs.needs[item] = (obs.needs[item] || 0) + 1;
        }
        for (const { item, count } of produced) {
            obs.produces[item] = (obs.produces[item] || 0) + 1;
        }
        
        this._updateConfirmed(key, obs);
        this._save();
        
        console.log(`[needs/produces] recorded delta for "${skillOrTask}": -[${consumed.map(c => c.item).join(',')}] +[${produced.map(p => p.item).join(',')}]`);
    }

    _updateConfirmed(key, obs) {
        let changed = false;
        const conf = (this.confirmed[key] ||= { needs: [], produces: [] });
        
        for (const [item, count] of Object.entries(obs.needs)) {
            if (count >= CONFIRM_THRESHOLD && !conf.needs.includes(item)) {
                conf.needs.push(item);
                changed = true;
                console.log(`[needs/produces] CONFIRMED: "${key}" needs ${item} (observed ${count}x)`);
            }
        }
        for (const [item, count] of Object.entries(obs.produces)) {
            if (count >= CONFIRM_THRESHOLD && !conf.produces.includes(item)) {
                conf.produces.push(item);
                changed = true;
                console.log(`[needs/produces] CONFIRMED: "${key}" produces ${item} (observed ${count}x)`);
            }
        }
        
        if (!conf.needs.length && !conf.produces.length) {
            delete this.confirmed[key];
        }
        
        return changed;
    }

    getConfirmedLinks() {
        return this.confirmed;
    }

    getFactsForPlanner() {
        const facts = [];
        for (const [key, links] of Object.entries(this.confirmed)) {
            if (links.needs?.length) {
                facts.push(`${key} needs: ${links.needs.join(', ')}`);
            }
            if (links.produces?.length) {
                facts.push(`${key} produces: ${links.produces.join(', ')}`);
            }
        }
        return facts;
    }

    getFactsText() {
        const facts = this.getFactsForPlanner();
        if (!facts.length) return '';
        return 'LEARNED ITEM RELATIONSHIPS (from past runs):\n' + facts.join('\n');
    }

    getProducersOf(item) {
        const producers = [];
        for (const [key, links] of Object.entries(this.confirmed)) {
            if (links.produces?.includes(item)) {
                producers.push(key);
            }
        }
        return producers;
    }

    getRequirementsOf(skillOrTask) {
        const key = skillOrTask.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80);
        return this.confirmed[key]?.needs || [];
    }
}
