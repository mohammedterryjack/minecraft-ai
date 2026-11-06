/**
 * Event-loop stall monitoring: threshold is the most recently observed gap between inbound
 * `keep_alive` packets from the server (minecraft-protocol), measured on `bot._client`.
 * Poll cadence follows the Nyquist sampling rule: sample at least twice per keep-alive period,
 * i.e. poll interval = (learned interval ms) / 2 (see `stallPollIntervalMsForThreshold`).
 *
 * Root cause of long stalls in production was unknown; this guard plus `withStallPhase` phase
 * stacks attribute stalls to labeled phases so the next step is diagnosis from real logs — not guessing.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mainThreadWatchdogStarted, armMainThreadWatchdog, beatMainThreadWatchdog, publishMainThreadEvidence } from './main_thread_watchdog.js';

/** @type {string[]} */
let _phaseStack = [];
/** fix64: what the PSN harness is running right now (mirrored from bot.__psnRunningSkill / __psnStackStr) */
let _psnSkill = '(none)';
let _psnStack = '(none)';

/** fix64: hand the current attribution to the off-thread watchdog, which cannot read main-thread state once it is blocked */
function _publishEvidence() {
    if (mainThreadWatchdogStarted()) publishMainThreadEvidence({ phases: [..._phaseStack], skill: _psnSkill, stack: _psnStack });
}

/**
 * Nyquist: sample the event-loop delay at least twice per keep-alive period.
 * @param {number} thresholdMs observed keep_alive gap (ms)
 */
export function stallPollIntervalMsForThreshold(thresholdMs) {
    if (typeof thresholdMs !== 'number' || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
        throw new Error('[event_loop_guard] stallPollIntervalMsForThreshold: need positive finite thresholdMs');
    }
    const half = thresholdMs / 2;
    // setInterval requires a positive integer ms; never 0
    const interval = Math.max(1, Math.floor(half));
    return interval;
}

/**
 * After at least two server keep_alive packets, holds the latest observed interval (ms).
 * @param {import('mineflayer').Bot} bot
 */
export function stallThresholdMs(bot) {
    if (!bot) throw new Error('[event_loop_guard] bot required');
    const t = bot.__eventLoopStallThresholdMs;
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
        throw new Error('[event_loop_guard] stall threshold not learned yet (need two inbound keep_alive packets from server)');
    }
    return t;
}

export function setStallPhase(phase) {
    _phaseStack = [String(phase)];
    _publishEvidence();
}

export function getStallPhase() {
    return _phaseStack.length ? _phaseStack[_phaseStack.length - 1] : 'idle';
}

/** @returns {string[]} shallow copy of the current phase stack (deepest / innermost last) */
export function getStallPhaseStack() {
    return [..._phaseStack];
}

/**
 * @param {import('mineflayer').Bot | null | undefined} bot
 */
export function captureStallContext(bot) {
    const phases = getStallPhaseStack();
    const phaseStr = phases.length ? phases.join(' <- ') : '(no phase)';
    const skill = bot && bot.__psnRunningSkill != null ? String(bot.__psnRunningSkill) : '(none)';
    const stack = bot && bot.__psnStackStr != null ? String(bot.__psnStackStr) : '(none)';
    return { phases, phaseStr, skill, stack };
}

/**
 * @param {string} phase
 * @param {() => void} fn
 */
export function pushStallPhase(phase) {
    _phaseStack.push(String(phase));
    _publishEvidence();
}

export function popStallPhase() {
    _phaseStack.pop();
    _publishEvidence();
}

/**
 * @param {import('mineflayer').Bot} bot
 */
/** Exposed for tests: run one stall poll tick with the current histogram sample. */
export function runStallPollTickForTest(bot) {
    _stallPollTick(bot);
}

function _stallPollTick(bot) {
    if (mainThreadWatchdogStarted()) beatMainThreadWatchdog();   // fix64: this tick running at all is the heartbeat
    const threshold = bot.__eventLoopStallThresholdMs;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) return;
    const h = bot.__stallEventLoopHist;
    if (!h) return;
    const maxNs = h.max;
    h.reset();
    const maxMs = maxNs / 1e6;
    if (maxMs >= threshold) {
        const ctx = captureStallContext(bot);
        console.error(`[event-loop] STALL: event loop delayed ${maxMs.toFixed(0)}ms (>= ${threshold}ms observed keep_alive gap) phase_stack="${ctx.phaseStr}" skill="${ctx.skill}" stack="${ctx.stack}"`);
    }
}

/**
 * (Re)schedule poll: interval is always derived from current threshold via Nyquist.
 * @param {import('mineflayer').Bot} bot
 */
/**
 * fix65: `material` = this keep_alive gap fell outside every gap observed before it (a new min or max of the learned
 * spread). Only then is ARMED logged; inside the spread the threshold still tracks the latest gap, silently. Before, both
 * ARMED lines were logged on every keep_alive (37 lines in 5 minutes on the iMac).
 * @param {import('mineflayer').Bot} bot
 * @param {boolean} material
 */
function _scheduleStallPoll(bot, material) {
    const thresholdMs = bot.__eventLoopStallThresholdMs;
    if (typeof thresholdMs !== 'number' || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
        throw new Error('[event_loop_guard] cannot schedule stall poll: invalid threshold on bot');
    }
    const pollMs = stallPollIntervalMsForThreshold(thresholdMs);
    if (bot.__stallPollInterval) {
        clearInterval(bot.__stallPollInterval);
        bot.__stallPollInterval = null;
    }
    const spread = bot.__keepAliveGapSpread;
    if (material) console.log(`[event-loop] stall guard ARMED: threshold tracks observed server keep_alive gap (currently ${thresholdMs}ms, outside the ${spread.n - 1} gap(s) seen before; spread now ${spread.min}-${spread.max}ms); poll every ${pollMs}ms (Nyquist: interval/2)`);

    if (!bot.__stallEventLoopHist) {
        bot.__stallEventLoopHist = monitorEventLoopDelay({ resolution: 20 });
        bot.__stallEventLoopHist.enable();
    }

    bot.__stallPollInterval = setInterval(() => _stallPollTick(bot), pollMs);
    // fix64: blocked = the loop could not run for one full learned keep_alive gap; a healthy loop beats every pollMs, so
    // silence beyond gap + pollMs means a whole gap passed with no turn
    if (mainThreadWatchdogStarted()) {
        armMainThreadWatchdog(thresholdMs + pollMs);
        beatMainThreadWatchdog();
        if (material) console.log(`[watchdog] ARMED: SIGKILL after ${thresholdMs + pollMs}ms without a main-loop heartbeat (keep_alive gap ${thresholdMs}ms + beat period ${pollMs}ms)`);
    }
}

/**
 * Subscribe once per bot; learn threshold from inter-arrival time of inbound keep_alive packets.
 * @param {import('mineflayer').Bot} bot
 */
export function startEventLoopStallGuard(bot) {
    if (!bot || !bot._client || typeof bot._client.on !== 'function') {
        throw new Error('[event_loop_guard] bot._client.on missing (cannot observe keep_alive)');
    }
    if (bot.__eventLoopStallGuardHooked) return;
    bot.__eventLoopStallGuardHooked = true;
    // fix64: the PSN harness (skill_graph instrumentSrc) assigns these on every traced call; mirror them to the watchdog
    Object.defineProperty(bot, '__psnRunningSkill', {
        configurable: true, enumerable: true,
        get: () => (_psnSkill === '(none)' ? null : _psnSkill),
        set: (v) => { _psnSkill = v == null ? '(none)' : String(v); _publishEvidence(); },
    });
    Object.defineProperty(bot, '__psnStackStr', {
        configurable: true, enumerable: true,
        get: () => (_psnStack === '(none)' ? '' : _psnStack),
        set: (v) => { _psnStack = v ? String(v) : '(none)'; _publishEvidence(); },
    });

    const onKeepAlive = () => {
        const now = Date.now();
        const prev = bot.__prevServerKeepAliveAt;
        bot.__prevServerKeepAliveAt = now;
        if (prev === undefined || prev === null) {
            if (!bot.__stallGuardUnarmedLogged) {
                bot.__stallGuardUnarmedLogged = true;
                console.error('[event-loop] LOUD: stall guard is NOT ARMED yet — waiting for a second inbound keep_alive from the server to learn the keep-alive interval; STALL detection stays off until then.');
            }
            return;
        }
        const intervalMs = now - prev;
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            throw new Error(`[event_loop_guard] invalid observed keep_alive gap ${intervalMs}ms`);
        }
        bot.__serverKeepAliveIntervalMs = intervalMs;
        bot.__eventLoopStallThresholdMs = intervalMs;
        const sp = bot.__keepAliveGapSpread;
        const material = !sp || intervalMs < sp.min || intervalMs > sp.max;
        bot.__keepAliveGapSpread = sp
            ? { min: Math.min(sp.min, intervalMs), max: Math.max(sp.max, intervalMs), n: sp.n + 1 }
            : { min: intervalMs, max: intervalMs, n: 1 };
        _scheduleStallPoll(bot, material);
    };
    bot.__stallGuardKeepAliveHandler = onKeepAlive;
    bot._client.on('keep_alive', onKeepAlive);
}

export function stopEventLoopStallGuard(bot) {
    if (bot && bot.__stallPollInterval) {
        clearInterval(bot.__stallPollInterval);
        bot.__stallPollInterval = null;
    }
    if (bot && bot.__stallEventLoopHist) {
        bot.__stallEventLoopHist.disable();
        bot.__stallEventLoopHist = null;
    }
    if (bot && bot._client && bot.__stallGuardKeepAliveHandler) {
        bot._client.removeListener('keep_alive', bot.__stallGuardKeepAliveHandler);
        bot.__stallGuardKeepAliveHandler = null;
    }
    if (bot) {
        bot.__eventLoopStallGuardHooked = false;
    }
}

/**
 * Run an async function with a stall phase label (for loud logging when the loop lags).
 * Pushes onto the phase stack for STALL attribution.
 * @template T
 * @param {string} phase
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withStallPhase(phase, fn) {
    pushStallPhase(phase);
    const t0 = Date.now();
    try {
        return await fn();
    } finally {
        popStallPhase();
        const dt = Date.now() - t0;
        if (dt > 100) {
            console.log(`[event-loop] phase "${phase}" finished in ${dt}ms (async wall time)`);
        }
    }
}
