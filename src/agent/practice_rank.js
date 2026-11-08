// fix93: idle-practice admission and effect evidence.
// A post that already holds on the unchanged world is not practice.
// A run that changes nothing is not an effect success, however the post reads c.ret.

export function betaUncertainty(successes, failures) {
    if (typeof successes !== 'number' || !Number.isFinite(successes)) throw new Error('[fix93] successes must be a finite number');
    if (typeof failures !== 'number' || !Number.isFinite(failures)) throw new Error('[fix93] failures must be a finite number');
    const n = successes + failures;
    return ((successes + 1) * (failures + 1)) / (Math.pow(n + 2, 2) * (n + 3));
}

export function printedUncertainty(uncertainty) {
    if (typeof uncertainty !== 'number' || !Number.isFinite(uncertainty)) throw new Error('[fix93] uncertainty must be a finite number');
    return uncertainty.toFixed(4);
}

function slotName(v) {
    if (typeof v !== 'string') throw new Error(`[fix93] equipment slot is not a string (${JSON.stringify(v)})`);
    return v === 'empty' ? null : v;
}

export function practiceWorld(obs) {
    if (obs === null || obs === undefined || typeof obs !== 'object') throw new Error('[fix93] observation required');
    const world = {};
    if (typeof obs.position === 'string') {
        const parts = obs.position.split(',').map(s => Number(s.trim()));
        if (parts.length === 3 && parts.every(n => Number.isFinite(n))) world.pos = { x: parts[0], y: parts[1], z: parts[2] };
    }
    if (obs.inventory !== null && obs.inventory !== undefined && typeof obs.inventory === 'object') world.inv = obs.inventory;
    if (obs.equipment !== null && obs.equipment !== undefined && typeof obs.equipment === 'object') {
        const eq = obs.equipment;
        const out = {};
        if (Object.hasOwn(eq, 'hand')) out.heldItem = slotName(eq.hand);
        if (Object.hasOwn(eq, 'off_hand')) out.offHand = slotName(eq.off_hand);
        if (Object.hasOwn(eq, 'head')) out.helmet = slotName(eq.head);
        if (Object.hasOwn(eq, 'torso')) out.chestplate = slotName(eq.torso);
        if (Object.hasOwn(eq, 'legs')) out.leggings = slotName(eq.legs);
        if (Object.hasOwn(eq, 'feet')) out.boots = slotName(eq.feet);
        world.eq = out;
    }
    if (typeof obs.food_value === 'number') world.food = obs.food_value;
    if (typeof obs.health_value === 'number') world.hp = obs.health_value;
    if (typeof obs.alive === 'boolean') world.alive = obs.alive;
    if (typeof obs.dimension === 'string') world.dim = obs.dimension;
    if (typeof obs.empty_inventory_slots === 'number') world.free = obs.empty_inventory_slots;
    return world;
}

function posKey(p) {
    if (p === null || p === undefined) return null;
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return null;
    return `${p.x},${p.y},${p.z}`;
}

function objectChanges(before, after, kind) {
    if (before === null || before === undefined || after === null || after === undefined) return [];
    if (typeof before !== 'object' || typeof after !== 'object') throw new Error(`[fix93] ${kind} observations must be objects`);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const out = [];
    for (const key of keys) {
        const b = Object.hasOwn(before, key) ? before[key] : 0;
        const a = Object.hasOwn(after, key) ? after[key] : 0;
        if (b !== a) out.push({ kind, key, from: b, to: a });
    }
    return out;
}

// Causal world change: position, inventory counts, or equipment. A truthy return with the same
// alive flag and dimension is not a change.
export function causalChanges({ before, after, traceRoot }) {
    if (before === null || before === undefined || after === null || after === undefined) throw new Error('[fix93] before and after observations required');
    const changes = [];
    if (typeof before.position === 'string' && typeof after.position === 'string' && before.position !== after.position) {
        changes.push({ kind: 'position', from: before.position, to: after.position });
    }
    if (traceRoot !== null && traceRoot !== undefined) {
        const from = posKey(traceRoot.s0 && traceRoot.s0.pos);
        const to = posKey(traceRoot.s1 && traceRoot.s1.pos);
        if (from !== null && to !== null && from !== to) changes.push({ kind: 'position', from, to });
        if (traceRoot.s0 && traceRoot.s1) changes.push(...objectChanges(traceRoot.s0.eq, traceRoot.s1.eq, 'equipment'));
        if (traceRoot.delta !== null && traceRoot.delta !== undefined && typeof traceRoot.delta === 'object') {
            for (const [item, n] of Object.entries(traceRoot.delta)) {
                if (n !== 0) changes.push({ kind: 'inventory', key: item, delta: n });
            }
        }
    }
    changes.push(...objectChanges(before.inventory, after.inventory, 'inventory'));
    changes.push(...objectChanges(before.equipment, after.equipment, 'equipment'));
    return changes;
}

// postOk true with no causal change is not an effect success (stats stay put).
export function effectVerdict(postOk, changes) {
    if (!Array.isArray(changes)) throw new Error('[fix93] causal changes must be an array');
    if (postOk === true && changes.length === 0) return { effect: null, reason: 'no causal state change' };
    if (postOk === true) return { effect: true, reason: changes.map(c => c.kind).join(',') };
    if (postOk === false) return { effect: false, reason: 'post does not hold' };
    if (postOk === null) return { effect: null, reason: 'no verdict' };
    throw new Error(`[fix93] post verdict must be true, false, or null, got ${JSON.stringify(postOk)}`);
}

export function noteCausalSuccess(skill) {
    if (!skill || typeof skill !== 'object') throw new Error('[fix93] skill required');
    if (!Object.hasOwn(skill, 'causalEvidence')) skill.causalEvidence = { success: 0, fail: 0 };
    if (typeof skill.causalEvidence.success !== 'number') throw new Error(`[fix93] ${skill.name} causalEvidence.success is not a number`);
    skill.causalEvidence.success += 1;
}
