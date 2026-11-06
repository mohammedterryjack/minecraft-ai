// fix58: vitals relations LEARNED from the bot's own observations; no hard-coded regen food level and no health/food cutoffs.
// regen[food] = { n, up } over 1 Hz samples taken while hp was below max with no damage in the interval:
//   - a rise is credited to the highest food level seen in the interval (regen can only be credited to food the bot actually had);
//   - a non-rise is evidence only for a food level the bot stayed at for the whole interval.
// runs[skill] = { n, food, hp }: summed vitals deltas over that skill's traced runs (pre/post snapshots), i.e. its learned vitals effect.
export class VitalsModel {
    constructor(store) {
        if (!store || typeof store.regen !== 'object' || typeof store.runs !== 'object') throw new Error('[fix58] VitalsModel needs a persisted store { regen: {}, runs: {} }');
        this.s = store;
    }
    static _nums(o) { for (const [k, v] of Object.entries(o)) if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`[fix58] vitals ${k} must be a number, got ${JSON.stringify(v)}`); }
    _level(f) { if (!this.s.regen[f]) this.s.regen[f] = { n: 0, up: 0 }; return this.s.regen[f]; }
    // prev/cur: { h, f } consecutive samples. Returns the counter that was updated, or null when the interval carries no regen evidence.
    observeSample(prev, cur, hpMax) {
        VitalsModel._nums({ 'prev.h': prev.h, 'prev.f': prev.f, 'cur.h': cur.h, 'cur.f': cur.f, hpMax });
        if (prev.h <= 0 || cur.h <= 0 || prev.h >= hpMax || cur.h < prev.h) return null;   // dead/respawning, nothing to regenerate, or damaged
        if (cur.h > prev.h) { const c = this._level(Math.max(prev.f, cur.f)); c.n++; c.up++; return c; }
        if (prev.f !== cur.f) return null;
        const c = this._level(prev.f); c.n++; return c;
    }
    // one traced skill run: accumulate its observed food/hp change
    noteRun(name, s0, s1) {
        VitalsModel._nums({ 's0.food': s0.food, 's1.food': s1.food, 's0.hp': s0.hp, 's1.hp': s1.hp });
        if (!this.s.runs[name]) this.s.runs[name] = { n: 0, food: 0, hp: 0 };
        const e = this.s.runs[name]; e.n++; e.food += s1.food - s0.food; e.hp += s1.hp - s0.hp;
        return e;
    }
    // skills whose observed mean food change per run is positive, best first
    foodRaisers() {
        return Object.entries(this.s.runs).map(([name, e]) => ({ name, n: e.n, food: e.food / e.n, hp: e.hp / e.n }))
            .filter(x => x.food > 0).sort((a, b) => b.food - a.food);
    }
    // learned recovery outlook at the current vitals.
    // blocked: hp below max, every food level <= current has 0 rises, a higher level has rises, and at that level's observed rise
    // rate the no-rise samples at <= current food would have produced at least one rise (so the absence is evidence, not chance).
    recovery(hp, hpMax, food) {
        VitalsModel._nums({ hp, hpMax, food });
        const levels = Object.entries(this.s.regen).map(([f, c]) => ({ f: Number(f), n: c.n, up: c.up })).sort((a, b) => a.f - b.f);
        const atOrBelow = levels.filter(l => l.f <= food), rose = levels.filter(l => l.up > 0);
        const low = { n: atOrBelow.reduce((a, l) => a + l.n, 0), up: atOrBelow.reduce((a, l) => a + l.up, 0) };
        const firstRise = rose.length ? rose[0] : null;
        const below = hp < hpMax;
        const blocked = below && low.up === 0 && firstRise !== null && firstRise.f > food && low.n * (firstRise.up / firstRise.n) >= 1;
        // fix59: regenFood = current food is at/above the lowest level hp has been seen rising at (null until a rise is observed)
        const regenFood = firstRise === null ? null : food >= firstRise.f;
        return { below, blocked, regenFood, hp, hpMax, food, low, firstRise, raisers: this.foodRaisers() };
    }
    // fix59: which part of the LEARNED recovery outlook changed between two recovery() results, or null if none did.
    // Replaces _planStale's fixed "hp/food dropped by 6": vitals only invalidate a plan when they cross a learned boundary.
    static outlookChange(a, b) {
        if (!a || !b) throw new Error('[fix59] outlookChange needs two recovery() results');
        const word = x => x ? 'blocked' : 'not blocked';
        if (a.blocked !== b.blocked) return `learned health recovery changed (${word(a.blocked)} -> ${word(b.blocked)})`;
        if (a.regenFood !== b.regenFood) {
            const lvl = (b.firstRise === null ? a.firstRise : b.firstRise).f;
            return `food crossed the learned regen level ${lvl} (${a.food} -> ${b.food})`;
        }
        return null;
    }
    // plain facts for the curriculum (no imperatives); null when hp is at max (nothing to recover)
    recoveryText(r) {
        if (!r.below) return null;
        const hp = r.hp.toFixed(1);
        const rise = r.firstRise ? `lowest food level at which hp has risen: ${r.firstRise.f} (${r.firstRise.up}/${r.firstRise.n} samples)` : 'hp has not been seen rising at any food level yet';
        const out = r.blocked ? `; so hp is not recovering at food ${r.food}` : '';
        const raisers = r.raisers.length ? r.raisers.slice(0, 3).map(x => `${x.name} +${x.food.toFixed(1)} food/run (${x.n} runs)`).join(', ') : 'none observed yet';
        return `health_recovery (learned from own vitals): hp ${hp}/${r.hpMax}, food ${r.food}; at food <= ${r.food} hp rose in ${r.low.up}/${r.low.n} below-max samples; ${rise}${out}; skills observed raising food: ${raisers}`;
    }
}
