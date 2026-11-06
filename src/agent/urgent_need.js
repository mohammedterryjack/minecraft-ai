// fix80: shared urgent-need pre-emption (vitals hunger now; threat/fix77 plugs into the same Thompson slot).
// Interrupt/defer kind is always 'need' (never blamed on a skill or the goal backoff). fix77 adds kind 'threat'.
// Sources never use message-text matching; callers pass structured { kind, by }.

export function checkNeedSource(source) {
    if (source === null) {
        throw new Error(`[fix80] need source must be an object, got ${JSON.stringify(source)}`);
    }
    if (source === undefined) {
        throw new Error(`[fix80] need source must be an object, got ${JSON.stringify(source)}`);
    }
    if (typeof source !== 'object') {
        throw new Error(`[fix80] need source must be an object, got ${JSON.stringify(source)}`);
    }
    if (typeof source.kind !== 'string') {
        throw new Error(`[fix80] need source.kind required, got ${JSON.stringify(source.kind)}`);
    }
    if (source.kind.length === 0) {
        throw new Error(`[fix80] need source.kind required, got ${JSON.stringify(source.kind)}`);
    }
    if (typeof source.by !== 'string') {
        throw new Error(`[fix80] need source.by required, got ${JSON.stringify(source.by)}`);
    }
    if (source.by.length === 0) {
        throw new Error(`[fix80] need source.by required, got ${JSON.stringify(source.by)}`);
    }
    return source;
}

export function needInterruptSource(by) {
    if (typeof by !== 'string') throw new Error(`[fix80] needInterruptSource by required, got ${JSON.stringify(by)}`);
    if (by.length === 0) throw new Error(`[fix80] needInterruptSource by required, got ${JSON.stringify(by)}`);
    return checkNeedSource({ kind: 'need', by });
}

// Interrupt kinds that cut an action without blaming the skill or the goal backoff (fix74/fix51 accounting).
export function isUnblamedInterruptKind(kind) {
    if (kind === 'need') return true;
    if (kind === 'threat') return true;
    return false;
}

// Marsaglia-Tsang Gamma(shape, 1) for shape >= 1; Beta(α,β) = Gα/(Gα+Gβ). Used for Thompson draws over Beta(s+1,f+1).
function sampleGamma(shape, rng) {
    if (!(shape >= 1)) throw new Error(`[fix80] sampleGamma needs shape >= 1, got ${shape}`);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
        let x, v;
        do {
            const u = rng(), v2 = rng();
            x = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v2);
            v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u2 = rng();
        if (u2 < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
        if (Math.log(u2) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
}

export function sampleBeta(alpha, beta, rng = Math.random) {
    if (!(alpha >= 1)) throw new Error(`[fix80] sampleBeta needs alpha >= 1 (Beta(s+1,f+1)), got ${alpha},${beta}`);
    if (!(beta >= 1)) throw new Error(`[fix80] sampleBeta needs beta >= 1 (Beta(s+1,f+1)), got ${alpha},${beta}`);
    const x = sampleGamma(alpha, rng);
    const y = sampleGamma(beta, rng);
    const sum = x + y;
    if (sum === 0) throw new Error('[fix80] sampleBeta: gamma sum was 0');
    return x / sum;
}

// Argmax over Thompson-sampled candidate values (common currency: expected HP loss avoided for needs; task uses its backoff posterior).
export function pickUrgentCandidate(candidates) {
    if (!Array.isArray(candidates)) {
        throw new Error('[fix80] pickUrgentCandidate needs a non-empty candidates array');
    }
    if (candidates.length === 0) {
        throw new Error('[fix80] pickUrgentCandidate needs a non-empty candidates array');
    }
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
        const c = candidates[i];
        if (typeof c.value !== 'number') throw new Error(`[fix80] candidate value must be a number, got ${JSON.stringify(c)}`);
        if (Number.isNaN(c.value)) throw new Error(`[fix80] candidate value must be a number, got ${JSON.stringify(c)}`);
        if (c.value > best.value) best = c;
    }
    return best;
}
