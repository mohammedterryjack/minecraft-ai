/**
 * Event-loop stall monitoring. The silence limit is fixed. It is not learned from keep_alive
 * arrival times: Date.now() in that handler included the bot's own stalls, so the maximum
 * only climbed, and it had already passed the server's kick bound.
 *
 * Vanilla ServerCommonPacketListenerImpl.keepConnectionAlive (Paper's patch of that method
 * says "use vanilla's 15000L between keep alive packets"): when now - keepAliveTime >= 15000L,
 * a pending keep-alive disconnects the client, otherwise the server sends ClientboundKeepAlivePacket
 * and sets keepAliveTime to now. The kick therefore lands 15–30s after a keepalive.
 * minecraft.wiki, Java Edition protocol, Keep Alive (clientbound); wiki.vg Keep Alive.
 *
 * The beat period is the Nyquist poll, half of the 15000 ms interval. The armed silence
 * limit is the kick bound (15000 × 2). A healthy loop beats inside that bound, so the beat
 * is not added on top of it: adding it would leave the process alive after the server had
 * already kicked the client.
 *
 * Root cause of long stalls in production was unknown; this guard plus `withStallPhase` phase
 * stacks attribute stalls to labeled phases so the next step is diagnosis from real logs.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mainThreadWatchdogStarted, armMainThreadWatchdog, beatMainThreadWatchdog, publishMainThreadEvidence } from './main_thread_watchdog.js';

// Vanilla ServerCommonPacketListenerImpl.keepConnectionAlive compares against 15000L.
// That check both sends the next ClientboundKeepAlivePacket and, when one is already
// pending, disconnects. The kick lands one or two of those intervals after a keepalive.
export const KEEP_ALIVE_INTERVAL_MS = 15000;
export const KEEP_ALIVE_KICK_MS = KEEP_ALIVE_INTERVAL_MS * 2;

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
 * Nyquist: sample the event-loop delay at least twice per keep-alive interval.
 * @param {number} thresholdMs interval being sampled (ms)
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

/** The beat is one Nyquist poll of the keep-alive interval. It is not learned. */
export function watchdogBeatPeriodMs() {
    return stallPollIntervalMsForThreshold(KEEP_ALIVE_INTERVAL_MS);
}

/**
 * The stall threshold is the server kick bound. It does not depend on observed gaps.
 * @param {import('mineflayer').Bot} bot
 */
export function stallThresholdMs(bot) {
    if (!bot) throw new Error('[event_loop_guard] bot required');
    const t = bot.__eventLoopStallThresholdMs;
    if (t !== KEEP_ALIVE_KICK_MS) {
        throw new Error(`[event_loop_guard] stall threshold is ${t}, not the keep-alive kick bound ${KEEP_ALIVE_KICK_MS}ms`);
    }
    return t;
}

/** Silence that arms SIGKILL: the keep-alive kick bound, 15000 ms × 2. */
export function watchdogSilenceLimitMs() {
    return KEEP_ALIVE_KICK_MS;
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
        console.error(`[event-loop] STALL: event loop delayed ${maxMs.toFixed(0)}ms (>= ${threshold}ms keep-alive kick bound) phase_stack="${ctx.phaseStr}" skill="${ctx.skill}" stack="${ctx.stack}"`);
    }
}

/**
 * Arm once. The threshold is the kick bound and the poll is the beat period.
 * A keep_alive gap does not reach here.
 * @param {import('mineflayer').Bot} bot
 */
function _scheduleStallPoll(bot) {
    const thresholdMs = stallThresholdMs(bot);
    const pollMs = watchdogBeatPeriodMs();
    if (bot.__stallPollInterval) {
        clearInterval(bot.__stallPollInterval);
        bot.__stallPollInterval = null;
    }
    console.log(`[event-loop] stall guard ARMED: threshold is the keep-alive kick bound (currently ${thresholdMs}ms = ${KEEP_ALIVE_INTERVAL_MS}×2); poll every ${pollMs}ms (Nyquist: interval/2)`);

    if (!bot.__stallEventLoopHist) {
        bot.__stallEventLoopHist = monitorEventLoopDelay({ resolution: 20 });
        bot.__stallEventLoopHist.enable();
    }

    bot.__stallPollInterval = setInterval(() => _stallPollTick(bot), pollMs);
    // The kick bound is the silence limit. The beat period is the poll. A healthy loop
    // beats inside the bound, so the bound is not extended by a beat.
    if (mainThreadWatchdogStarted()) {
        const silenceMs = watchdogSilenceLimitMs();
        armMainThreadWatchdog(silenceMs);
        beatMainThreadWatchdog();
        console.log(`[watchdog] ARMED: SIGKILL after ${silenceMs}ms without a main-loop heartbeat (vanilla keepConnectionAlive ${KEEP_ALIVE_INTERVAL_MS}ms × 2, beat period ${pollMs}ms)`);
    }
}

/**
 * Arm once per bot at the keep-alive kick bound. Inbound keep_alive times are not read:
 * Date.now() there included the bot's own stalls and the maximum only climbed.
 * @param {import('mineflayer').Bot} bot
 */
export function startEventLoopStallGuard(bot) {
    if (!bot || !bot._client || typeof bot._client.on !== 'function') {
        throw new Error('[event_loop_guard] bot._client.on is not a function');
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
    bot.__eventLoopStallThresholdMs = KEEP_ALIVE_KICK_MS;
    _scheduleStallPoll(bot);
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
    if (bot) {
        bot.__eventLoopStallGuardHooked = false;
        bot.__eventLoopStallThresholdMs = null;
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
