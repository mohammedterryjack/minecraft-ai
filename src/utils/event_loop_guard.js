/**
 * Event-loop stall monitoring: threshold is the most recently observed gap between inbound
 * `keep_alive` packets from the server (minecraft-protocol), measured on `bot._client`.
 * Poll cadence comes from settings.event_loop_stall_poll_interval_ms only.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import agentSettings from '../agent/settings.js';
import rootSettings from '../../settings.js';

function stallPollIntervalMs() {
    if (typeof agentSettings.event_loop_stall_poll_interval_ms === 'number') {
        return agentSettings.event_loop_stall_poll_interval_ms;
    }
    if (typeof rootSettings.event_loop_stall_poll_interval_ms === 'number') {
        return rootSettings.event_loop_stall_poll_interval_ms;
    }
    throw new Error('[event_loop_guard] event_loop_stall_poll_interval_ms missing: set in settings.js (root) or agent settings after MindServer sync');
}

let _phase = 'idle';

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
    _phase = String(phase);
}

export function getStallPhase() {
    return _phase;
}

/**
 * @param {import('mineflayer').Bot} bot
 */
function _armStallPoll(bot) {
    if (bot.__stallPollInterval) return;
    const pollMs = stallPollIntervalMs();
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
        throw new Error('[event_loop_guard] event_loop_stall_poll_interval_ms must be a positive finite number');
    }
    const thresholdMs = bot.__eventLoopStallThresholdMs;
    if (typeof thresholdMs !== 'number' || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
        throw new Error(`[event_loop_guard] cannot arm stall poll: invalid threshold on bot`);
    }
    console.log(`[event-loop] stall guard ARMED: threshold tracks observed server keep_alive gap (currently ${thresholdMs}ms); poll every ${pollMs}ms`);

    bot.__stallEventLoopHist = monitorEventLoopDelay({ resolution: 20 });
    bot.__stallEventLoopHist.enable();

    bot.__stallPollInterval = setInterval(() => {
        const threshold = bot.__eventLoopStallThresholdMs;
        if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) return;
        const h = bot.__stallEventLoopHist;
        if (!h) return;
        const maxNs = h.max;
        h.reset();
        const maxMs = maxNs / 1e6;
        if (maxMs >= threshold) {
            const skill = bot.__psnRunningSkill !== undefined && bot.__psnRunningSkill !== null ? String(bot.__psnRunningSkill) : '(none)';
            const stack = bot.__psnStackStr !== undefined && bot.__psnStackStr !== null ? String(bot.__psnStackStr) : '(none)';
            console.error(`[event-loop] STALL: event loop delayed ${maxMs.toFixed(0)}ms (>= ${threshold}ms observed keep_alive gap) during phase "${_phase}" skill="${skill}" stack="${stack}"`);
        }
    }, pollMs);
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
        _armStallPoll(bot);
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
 * @template T
 * @param {string} phase
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withStallPhase(phase, fn) {
    const prev = _phase;
    _phase = phase;
    const t0 = Date.now();
    const out = await fn();
    const dt = Date.now() - t0;
    if (dt > 100) {
        console.log(`[event-loop] phase "${phase}" finished in ${dt}ms (async wall time)`);
    }
    _phase = prev;
    return out;
}
