// fix66: learned "no progress" for movement and skill runs, replacing fix44's goToGoal constants (1 s poll, 0.5-block "moved",
// 15 s no progress) and fix27/fix33's Voyager run watchdog constants (5 s poll, 60 s no progress).
//
// Progress is counted in the game's own units, not seconds:
//   - a path step: the bot's block cell becomes one it has not stood in during this goto (bobbing/pacing in place is not
//     progress, as fix33 found for the run watchdog);
//   - a dig the pathfinder started has finished (bot.pathfinder.isMining() true -> false);
//   - a block the pathfinder was placing (pillar/bridge) is placed (isBuilding() true -> false).
// Time is only counted while the pathfinder is acting (isMoving/isMining/isBuilding); while it is computing a path it is
// bounded by its own thinkTimeout and errors out by itself.
// What is learned, per movement kind, is the longest ACTIVE time a completed step took (time per block):
//   walk  - on land;  swim - in water or lava;  build - a placement in the step;
//   dig   - a dig in the step, learned as excess over the game's dig time for that block and tool (bot.digTime), so a deepslate
//           block with a stone pickaxe gets its own allowance and a long healthy dig is never a stall.
// A step's kind is the slowest kind it contained (dig > build > swim > walk).
// 'run' is the Voyager skill-run signature (new ground, inventory, open window, lit furnace): the longest completed gap.
// Verdict: no progress = the open step has been active longer than every completed step of its kind (and, for digs, longer
// than that excess plus the game's dig time of the blocks being dug). Checked on the game's physics tick.
// Before a kind is learned there is no bound: the check is UNBOUNDED for that kind, announced once per kind, and the steps
// observed meanwhile are learned. A kind's bound only applies to gotos/runs that START after it was learned, so the first
// goto/run that meets a kind is observed whole. The store is the owner's persisted object (voyager progress.movement);
// without one nothing is learned and every check is unbounded.
let _store = null;
export function setMovementStore(store) {
    if (!store || typeof store !== 'object') throw new Error('[movement] store must be an object');
    _store = store;
}
export function movementStore() { return _store; }

export const KINDS = ['dig', 'build', 'swim', 'walk'];   // precedence: a step's kind is the first one it contained

export function recordStep(kind, activeMs, digMs) {
    if (!_store) return;
    if (!_store[kind]) _store[kind] = { n: 0, max: 0, cuts: 0 };
    const s = _store[kind];
    const x = activeMs - digMs;
    s.n += 1;
    if (x > s.max) s.max = x;
}
export function recordCut(kind) {
    _store[kind].cuts += 1;
}
/** kinds learned now; a check uses the snapshot taken when its goto/run started */
export function learnedKinds() {
    return new Set(_store ? Object.keys(_store).filter(k => _store[k].n > 0) : []);
}
/** null with a reason when the kind is not learned (or was not when this goto/run started) */
export function stepBound(kind, digMs, learnedAtStart) {
    if (!_store) return { ms: null, why: 'no movement store attached (nothing is learned in this process)' };
    if (!learnedAtStart.has(kind) || !_store[kind]) return { ms: null, why: `no completed ${kind} step learned before this started` };
    const s = _store[kind];
    return { ms: s.max + digMs, n: s.n, max: s.max };
}
const _announced = new Set();
/** true the first time a kind is found unbounded in this process (log once) */
export function noteUnbounded(kind) {
    if (_announced.has(kind)) return false;
    _announced.add(kind);
    return true;
}
export function _resetAnnouncementsForTest() { _announced.clear(); }

export const cellKey = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/**
 * Watch a pathfinder goto on the physics tick. Calls onStall({ kind, activeMs, bound }) once when the open step exceeds its
 * learned bound. Returns stop().
 * @param {import('mineflayer').Bot} bot
 * @param {(v: { kind: string, activeMs: number, bound: { ms: number, n: number, max: number } }) => void} onStall
 * @param {(line: string) => void} say
 */
export function watchPathing(bot, onStall, say) {
    const learnedAtStart = learnedKinds();
    const seen = new Set([cellKey(bot.entity.position)]);
    const pf = bot.pathfinder;
    // what the pathfinder was doing since the last tick; the time up to this tick belongs to that
    const kindNow = () => pf.isMining() ? 'dig' : pf.isBuilding() ? 'build' : pf.isMoving() ? ((bot.entity.isInWater || bot.entity.isInLava) ? 'swim' : 'walk') : null;
    let acting = kindNow(), wasMining = pf.isMining(), wasBuilding = pf.isBuilding();
    let active = 0, digMs = 0, kinds = new Set(), last = performance.now(), digTarget = null, fired = false;
    const noteDig = () => { if (pf.isMining() && bot.targetDigBlock && bot.targetDigBlock !== digTarget) { digTarget = bot.targetDigBlock; digMs += bot.digTime(digTarget); } };
    noteDig();
    const closeStep = () => {
        const kind = KINDS.find(k => kinds.has(k));
        if (kind) recordStep(kind, active, kind === 'dig' ? digMs : 0);
        active = 0; digMs = 0; kinds = new Set();
    };
    const onTick = () => {
        const now = performance.now(), dt = now - last; last = now;
        if (acting) { active += dt; kinds.add(acting); }   // computing a path (acting null) is bounded by the pathfinder's thinkTimeout
        const mining = pf.isMining(), building = pf.isBuilding();
        if ((wasMining && !mining) || (wasBuilding && !building)) closeStep();
        wasMining = mining; wasBuilding = building;
        const c = cellKey(bot.entity.position);
        if (!seen.has(c)) { seen.add(c); closeStep(); }
        acting = kindNow();
        noteDig();
        if (fired) return;
        const open = new Set(kinds); if (acting) open.add(acting);
        const kind = KINDS.find(k => open.has(k));
        if (!kind) return;
        const bound = stepBound(kind, kind === 'dig' ? digMs : 0, learnedAtStart);
        if (bound.ms === null) { if (noteUnbounded(kind)) say(`[movement] UNBOUNDED ${kind}: ${bound.why}; no-progress check is off for ${kind} until learned`); return; }
        if (active > bound.ms) { fired = true; recordCut(kind); onStall({ kind, activeMs: active, bound }); }
    };
    bot.on('physicsTick', onTick);
    return () => bot.removeListener('physicsTick', onTick);
}
