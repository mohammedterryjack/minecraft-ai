// fix59: per-skill inventory-slot effect LEARNED from traced runs (pre/post snapshot `free` = empty inventory slots).
// Replaces fix39's name regex / name list for "space-freeing" skills: a skill frees space iff its observed runs freed slots.
// runs[skill] = { n, freed }: summed (post.free - pre.free) over that skill's traced, non-interrupted, alive runs.
export class SlotEffects {
    constructor(store) {
        if (!store || typeof store.runs !== 'object' || store.runs === null) throw new Error('[fix59] SlotEffects needs a persisted store { runs: {} }');
        this.s = store;
    }
    noteRun(name, s0, s1) {
        for (const [k, v] of Object.entries({ 's0.free': s0.free, 's1.free': s1.free })) if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`[fix59] slot snapshot ${k} must be a number, got ${JSON.stringify(v)}`);
        if (!this.s.runs[name]) this.s.runs[name] = { n: 0, freed: 0 };
        const e = this.s.runs[name]; e.n++; e.freed += s1.free - s0.free;
        return e;
    }
    // learned mean slots freed per run, or null when the skill has no traced run yet
    effect(name) { const e = this.s.runs[name]; return e ? { n: e.n, freed: e.freed / e.n } : null; }
}
