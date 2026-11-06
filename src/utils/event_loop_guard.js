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

/** @type {string[]} */
let _phaseStack = [];

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
}

export function popStallPhase() {
    _phaseStack.pop();
}

/**
 * @param {import('mineflayer').Bot} bot
 */
/** Exposed for tests: run one stall poll tick with the current histogram sample. */
export function runStallPollTickForTest(bot) {
    _stallPollTick(bot);
}

function _stallPollTick(bot) {
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
function _scheduleStallPoll(bot) {
    const thresholdMs = bot.__eventLoopStallThresholdMs;
    if (typeof thresholdMs !== 'number' || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
        throw new Error('[event_loop_guard] cannot schedule stall poll: invalid threshold on bot');
    }
    const pollMs = stallPollIntervalMsForThreshold(thresholdMs);
    if (bot.__stallPollInterval) {
        clearInterval(bot.__stallPollInterval);
        bot.__stallPollInterval = null;
    }
    console.log(`[event-loop] stall guard ARMED: threshold tracks observed server keep_alive gap (currently ${thresholdMs}ms); poll every ${pollMs}ms (Nyquist: interval/2)`);

    if (!bot.__stallEventLoopHist) {
        bot.__stallEventLoopHist = monitorEventLoopDelay({ resolution: 20 });
        bot.__stallEventLoopHist.enable();
    }

    bot.__stallPollInterval = setInterval(() => _stallPollTick(bot), pollMs);
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
        _scheduleStallPoll(bot);
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
