/**
 * Event-loop stall monitoring for long synchronous work (staging, lint, SES eval).
 * Threshold equals the minecraft-protocol client keep-alive interval (mineflayer: bot._client.checkTimeoutInterval),
 * set at createBot from settings.check_timeout_interval_ms (see src/utils/mcdata.js). Poll interval comes from
 * settings.event_loop_stall_poll_interval_ms.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import agentSettings from '../agent/settings.js';
import rootSettings from '../../settings.js';

function checkTimeoutMs() {
    if (typeof agentSettings.check_timeout_interval_ms === 'number') {
        return agentSettings.check_timeout_interval_ms;
    }
    if (typeof rootSettings.check_timeout_interval_ms === 'number') {
        return rootSettings.check_timeout_interval_ms;
    }
    throw new Error('[event_loop_guard] check_timeout_interval_ms missing: set in settings.js (root) or agent settings after MindServer sync');
}

function stallPollIntervalMs() {
    if (typeof agentSettings.event_loop_stall_poll_interval_ms === 'number') {
        return agentSettings.event_loop_stall_poll_interval_ms;
    }
    if (typeof rootSettings.event_loop_stall_poll_interval_ms === 'number') {
        return rootSettings.event_loop_stall_poll_interval_ms;
    }
    throw new Error('[event_loop_guard] event_loop_stall_poll_interval_ms missing: set in settings.js (root) or agent settings after MindServer sync');
}

let _histogram = null;
let _watchInterval = null;
let _phase = 'idle';

/** @param {import('mineflayer').Bot} bot */
export function protocolKeepaliveIntervalMs(bot) {
    const ms = checkTimeoutMs();
    if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error('[event_loop_guard] check_timeout_interval_ms must be a positive finite number');
    }
    const c = bot && bot._client;
    if (c && typeof c.checkTimeoutInterval === 'number' && c.checkTimeoutInterval !== ms) {
        throw new Error(`[event_loop_guard] bot._client.checkTimeoutInterval (${c.checkTimeoutInterval}) !== configured check_timeout_interval_ms (${ms})`);
    }
    return ms;
}

export function stallThresholdMs(bot) {
    return protocolKeepaliveIntervalMs(bot);
}

export function setStallPhase(phase) {
    _phase = String(phase);
}

export function getStallPhase() {
    return _phase;
}

export function startEventLoopStallGuard(bot) {
    if (_watchInterval) return;
    const threshold = stallThresholdMs(bot);
    const ms = protocolKeepaliveIntervalMs(bot);
    const pollMs = stallPollIntervalMs();
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
        throw new Error('[event_loop_guard] event_loop_stall_poll_interval_ms must be a positive finite number');
    }
    console.log(`[event-loop] stall guard: threshold ${threshold}ms (= check_timeout_interval_ms ${ms}ms, mineflayer createBot checkTimeoutInterval / minecraft-protocol keep-alive); poll every ${pollMs}ms`);
    _histogram = monitorEventLoopDelay({ resolution: 20 });
    _histogram.enable();
    _watchInterval = setInterval(() => {
        const maxNs = _histogram.max;
        _histogram.reset();
        const maxMs = maxNs / 1e6;
        if (maxMs >= threshold) {
            const skill = bot && bot.__psnRunningSkill !== undefined && bot.__psnRunningSkill !== null ? String(bot.__psnRunningSkill) : '(none)';
            const stack = bot && bot.__psnStackStr !== undefined && bot.__psnStackStr !== null ? String(bot.__psnStackStr) : '(none)';
            console.error(`[event-loop] STALL: event loop delayed ${maxMs.toFixed(0)}ms (>= ${threshold}ms) during phase "${_phase}" skill="${skill}" stack="${stack}"`);
        }
    }, pollMs);
}

export function stopEventLoopStallGuard() {
    if (_watchInterval) {
        clearInterval(_watchInterval);
        _watchInterval = null;
    }
    if (_histogram) {
        _histogram.disable();
        _histogram = null;
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
