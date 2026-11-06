// fix58: vitals relations LEARNED from the bot's own observations; no hard-coded regen food level and no health/food cutoffs.
// regen[food] = { n, up } over 1 Hz samples taken while hp was below max with no damage in the interval:
//   - a rise is credited to the highest food level seen in the interval (regen can only be credited to food the bot actually had);
//   - a non-rise is evidence only for a food level the bot stayed at for the whole interval.
// runs[skill] = { n, food, hp }: summed vitals deltas over that skill's traced runs (pre/post snapshots), i.e. its learned vitals effect.
// fix76: foodSamples learn food decay / food-gain intervals at any HP (hunger is not only an HP-regen problem).
export class VitalsModel {
    constructor(store) {
        if (!store || typeof store.regen !== 'object' || typeof store.runs !== 'object') throw new Error('[fix58] VitalsModel needs a persisted store { regen: {}, runs: {} }');
        if (store.foodSamples !== undefined && typeof store.foodSamples !== 'object') throw new Error('[fix76] vitals.foodSamples must be an object when present');
        if (!store.foodSamples) store.foodSamples = { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } };
        this.s = store;
    }
    static _nums(o) { for (const [k, v] of Object.entries(o)) if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`[fix58] vitals ${k} must be a number, got ${JSON.stringify(v)}`); }
    _level(f) { if (!this.s.regen[f]) this.s.regen[f] = { n: 0, up: 0 }; return this.s.regen[f]; }
    // prev/cur: { h, f } consecutive samples. Returns the counter that was updated, or null when the interval carries no regen evidence.
    observeSample(prev, cur, hpMax) {
        VitalsModel._nums({ 'prev.h': prev.h, 'prev.f': prev.f, 'cur.h': cur.h, 'cur.f': cur.f, hpMax });
        this.observeFoodSample(prev, cur);   // fix76: food change evidence even when hp is full
        if (prev.h <= 0 || cur.h <= 0 || prev.h >= hpMax || cur.h < prev.h) return null;   // dead/respawning, nothing to regenerate, or damaged
        if (cur.h > prev.h) { const c = this._level(Math.max(prev.f, cur.f)); c.n++; c.up++; return c; }
        if (prev.f !== cur.f) return null;
        const c = this._level(prev.f); c.n++; return c;
    }
    // fix76: learn food drops and rises from the 1 Hz sampler at any HP (starvation / eating are food facts, not only regen).
    // Returns the bucket updated, or null when food did not change.
    observeFoodSample(prev, cur) {
        VitalsModel._nums({ 'prev.f': prev.f, 'cur.f': cur.f });
        const d = cur.f - prev.f;
        if (d === 0) return null;
        const fs = this.s.foodSamples;
        if (d < 0) { fs.drop.n++; fs.drop.sum += -d; return fs.drop; }
        fs.rise.n++; fs.rise.sum += d; return fs.rise;
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
    // fix76: learned hunger outlook — food relative to the learned regen floor and observed food decay/gains.
    // Works at full HP (recoveryText is null when !below). No hard-coded eat-at-N threshold.
    hunger(hp, hpMax, food, foodMax) {
        VitalsModel._nums({ hp, hpMax, food, foodMax });
        const rec = this.recovery(hp, hpMax, food);
        const fs = this.s.foodSamples;
        const belowRegen = rec.firstRise !== null && food < rec.firstRise.f;
        const notFull = food < foodMax;
        // urgency: food is below the learned regen floor (eat before the next hit), or food has been seen dropping and is not full
        // with at least one observed food-raiser (so eating is a known option).
        const decayKnown = fs.drop.n > 0;
        const raisers = rec.raisers;
        let urgent = false;
        if (notFull) {
            if (belowRegen) urgent = true;
            else if (decayKnown && raisers.length > 0) urgent = true;
        }
        return {
            urgent, belowRegen, notFull, decayKnown,
            food, foodMax, hp, hpMax,
            firstRise: rec.firstRise,
            raisers,
            drop: { n: fs.drop.n, mean: fs.drop.n ? fs.drop.sum / fs.drop.n : 0 },
            rise: { n: fs.rise.n, mean: fs.rise.n ? fs.rise.sum / fs.rise.n : 0 },
        };
    }
    // fix74 (nit on fix58/fix76): every learned food-raiser, best first. Was raisers.slice(0, 3) in both texts: a fixed cut that
    //        could hide the one raiser the bot holds food for. The list is bounded by the skills seen raising food (foodRaisers).
    static raisersText(raisers) {
        if (!Array.isArray(raisers)) throw new Error(`[fix74] raisersText needs the foodRaisers() list, got ${JSON.stringify(raisers)}`);
        if (!raisers.length) return 'none observed yet';
        return raisers.map(x => `${x.name} +${x.food.toFixed(1)} food/run (${x.n} runs)`).join(', ');
    }
    // fix80: drive-reduction serve predicate. NOT hunger().urgent (true at 19/20 → thrash as a trigger).
    // Only belowRegen triggers pre-emption: above the learned floor there is no HP-harm evidence in VitalsModel
    // (no starvation-at-food-level samples, no food-drop rate×duration), so a fitsGain branch would be value 0 forever.
    // HungerText / urgent stay prompt-only for soft hunger above the floor.
    hungerServe(food, foodMax, hp, hpMax) {
        VitalsModel._nums({ food, foodMax, hp, hpMax });
        const raisers = this.foodRaisers();
        const best = raisers.length > 0 ? raisers[0] : null;
        const deficit = foodMax - food;
        const rec = this.recovery(hp, hpMax, food);
        const belowRegen = rec.firstRise !== null && food < rec.firstRise.f;
        const K = best !== null ? best.food : null;
        const servable = belowRegen;
        let regenLossHp = 0;
        if (belowRegen) {
            // Below the learned floor, recovery is at stake: unrecovered HP if damaged, else the full observed max
            // (the bar that would not regenerate after the next hit). hpMax comes from the bot, not a tuned threshold.
            regenLossHp = hp < hpMax ? (hpMax - hp) : hpMax;
        }
        return {
            servable, belowRegen, deficit,
            best: best !== null ? { name: best.name, K, n: best.n } : null,
            regenLossHp,
            firstRise: rec.firstRise,
        };
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
        const raisers = VitalsModel.raisersText(r.raisers);
        return `health_recovery (learned from own vitals): hp ${hp}/${r.hpMax}, food ${r.food}; at food <= ${r.food} hp rose in ${r.low.up}/${r.low.n} below-max samples; ${rise}${out}; skills observed raising food: ${raisers}`;
    }
    // fix76: plain hunger facts for the curriculum even when hp is full; null when not urgent
    hungerText(h) {
        if (!h) throw new Error('[fix76] hungerText requires a hunger() result');
        if (!h.urgent) return null;
        const floor = h.firstRise ? `learned regen food floor ${h.firstRise.f}` : 'no regen food floor learned yet';
        const decay = h.decayKnown ? `food drops observed ${h.drop.n}x (mean ${h.drop.mean.toFixed(1)}/drop)` : 'no food drops observed yet';
        const raisers = VitalsModel.raisersText(h.raisers);
        const why = h.belowRegen ? `food ${h.food}/${h.foodMax} is below ${floor}` : `food ${h.food}/${h.foodMax} is not full and ${decay}`;
        return `hunger (learned from own vitals): ${why}; ${decay}; skills observed raising food: ${raisers}`;
    }
}
