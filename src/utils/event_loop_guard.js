/**
 * Event-loop stall monitoring. The silence budget is the greater of two values: the maximum
 * observed gap between inbound `keep_alive` packets on `bot._client`, and the server's
 * keep-alive interval. A single short gap cannot reduce a maximum.
 *
 * ServerCommonPacketListenerImpl.keepConnectionAlive (vanilla, shown by Paper's patch of that
 * method: "use vanilla's 15000L between keep alive packets"): when now - keepAliveTime >= 15000L,
 * a pending keep-alive disconnects the client, otherwise the server sends ClientboundKeepAlivePacket.
 * The client is kicked if it does not answer within 15 seconds (minecraft.wiki, Java Edition protocol, Keep Alive).
 *
 * Poll cadence follows the Nyquist sampling rule: sample at least twice per that budget,
 * i.e. poll interval = budget / 2 (see `stallPollIntervalMsForThreshold`).
 *
 * Root cause of long stalls in production was unknown; this guard plus `withStallPhase` phase
 * stacks attribute stalls to labeled phases so the next step is diagnosis from real logs.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mainThreadWatchdogStarted, armMainThreadWatchdog, beatMainThreadWatchdog, publishMainThreadEvidence } from './main_thread_watchdog.js';

// Vanilla ServerCommonPacketListenerImpl.keepConnectionAlive compares against 15000L, which is
// both the gap before the next ClientboundKeepAlivePacket and the unanswered-keepalive kick.
export const KEEP_ALIVE_INTERVAL_MS = 15000;

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
 * After at least two server keep_alive packets, the greater of the max observed gap and
 * KEEP_ALIVE_INTERVAL_MS.
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

/** Silence that arms SIGKILL: the grounded keep-alive budget plus one Nyquist poll. */
export function watchdogSilenceLimitMs(bot) {
    const thresholdMs = stallThresholdMs(bot);
    return thresholdMs + stallPollIntervalMsForThreshold(thresholdMs);
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
 * Called only when the grounded budget changes (a new maximum gap, or the first sample).
 * A shorter gap does not reach here, so it cannot clear the poll or publish a smaller LIMIT.
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
    const maxGap = bot.__keepAliveGapMaxMs;
    console.log(`[event-loop] stall guard ARMED: threshold is the max observed keep_alive gap, at least the server keep-alive interval (currently ${thresholdMs}ms, max gap ${maxGap}ms); poll every ${pollMs}ms (Nyquist: interval/2)`);

    if (!bot.__stallEventLoopHist) {
        bot.__stallEventLoopHist = monitorEventLoopDelay({ resolution: 20 });
        bot.__stallEventLoopHist.enable();
    }

    bot.__stallPollInterval = setInterval(() => _stallPollTick(bot), pollMs);
    // fix64: blocked = the loop could not run for one full grounded keep-alive budget; a healthy loop beats every pollMs, so
    // silence beyond budget + pollMs means a whole budget passed with no turn
    if (mainThreadWatchdogStarted()) {
        armMainThreadWatchdog(thresholdMs + pollMs);
        beatMainThreadWatchdog();
        console.log(`[watchdog] ARMED: SIGKILL after ${thresholdMs + pollMs}ms without a main-loop heartbeat (max keep_alive gap ${maxGap}ms, protocol floor ${KEEP_ALIVE_INTERVAL_MS}ms, threshold ${thresholdMs}ms + beat period ${pollMs}ms)`);
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
        const prevMax = bot.__keepAliveGapMaxMs;
        if (prevMax !== undefined && (typeof prevMax !== 'number' || !Number.isFinite(prevMax))) {
            throw new Error(`[event_loop_guard] keep_alive gap max is ${prevMax}`);
        }
        const maxGap = prevMax === undefined ? intervalMs : Math.max(prevMax, intervalMs);
        bot.__keepAliveGapMaxMs = maxGap;
        // A short sample cannot reduce the max, and the protocol interval is the floor:
        // the server kicks a client that is silent for KEEP_ALIVE_INTERVAL_MS.
        const grounded = Math.max(maxGap, KEEP_ALIVE_INTERVAL_MS);
        if (bot.__eventLoopStallThresholdMs === grounded) return;
        bot.__eventLoopStallThresholdMs = grounded;
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
