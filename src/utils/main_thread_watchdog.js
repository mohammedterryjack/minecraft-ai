/**
 * fix64: off-main-thread watchdog for the agent process.
 *
 * The #44 stall guard (event_loop_guard.js) and the #44/#59 exit-on-disconnect path are both callbacks on the main event
 * loop: a setInterval poll that reads a monitorEventLoopDelay histogram, and mineflayer 'end'/'kicked' handlers. A loop
 * that never yields blocks all of them, so on 2026-11-06 the process sat blocked from 12:43:42Z (server: "standing on
 * air", then 12:44:12Z "lost connection: Timed out") until a manual kickstart at 13:03:59Z, logging nothing.
 *
 * This watchdog lives in a worker thread, which has its own isolate and is not scheduled by the main loop. The worker
 * never uses its own event loop either: it sleeps in Atomics.wait on a SharedArrayBuffer, which the main thread bumps
 * once per stall-guard poll (Nyquist half of the learned keep_alive gap). The silence limit is published by the guard
 * once it has learned the gap: limit = keep_alive gap + beat period, i.e. the main loop has been unable to run for a full
 * keep_alive gap. On a miss the worker writes the last published evidence (phase stack, running skill, PSN call stack)
 * straight to fd 2 with fs.writeSync, then SIGKILLs the process (SIGKILL cannot be caught by any JS handler), the parent
 * process sees the child exit and exits non-zero, and launchd restarts it.
 *
 * Evidence travels over a MessagePort that the worker drains with receiveMessageOnPort (synchronous), so the worker
 * needs no event loop and no fixed-size buffer.
 */
import { Worker, MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER_PATH = fileURLToPath(new URL('./main_thread_watchdog_worker.mjs', import.meta.url));
export const BEAT = 0;
export const LIMIT = 1;

/** @type {{ ctl: Int32Array, port: import('node:worker_threads').MessagePort, worker: Worker } | null} */
let _wd = null;

/** fix65: where the worker leaves its kill evidence for the next process (Voyager._settleDeadTrials reads it). */
export function watchdogEvidencePath(botDir) {
    return `${botDir}/watchdog_kill.json`;
}

/**
 * Start the worker once per process. Arming waits for the learned keep_alive gap (armMainThreadWatchdog).
 * @param {string} evidencePath file the worker writes (synchronously, before SIGKILL) for the next process to read
 */
export function startMainThreadWatchdog(evidencePath) {
    if (typeof evidencePath !== 'string' || !evidencePath) throw new Error('[watchdog] startMainThreadWatchdog: evidence path required');
    if (_wd) return _wd;
    const ctl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER_PATH, { workerData: { sab: ctl.buffer, port: port2, pid: process.pid, evidencePath }, transferList: [port2] });
    worker.on('error', (e) => { throw new Error(`[watchdog] LOUD FAIL: watchdog worker crashed: ${e && e.stack ? e.stack : e}`); });
    worker.on('exit', (code) => { throw new Error(`[watchdog] LOUD FAIL: watchdog worker exited (code ${code}); the main thread is unguarded`); });
    worker.unref();
    port1.unref();
    _wd = { ctl, port: port1, worker };
    console.log('[watchdog] main-thread watchdog worker started; it arms once the stall guard learns the server keep_alive gap');
    return _wd;
}

export function mainThreadWatchdogStarted() {
    return _wd !== null;
}

function _need() {
    if (!_wd) throw new Error('[watchdog] not started (call startMainThreadWatchdog first)');
    return _wd;
}

/**
 * @param {number} silenceLimitMs no heartbeat for this long => the main loop is blocked => SIGKILL
 */
export function armMainThreadWatchdog(silenceLimitMs) {
    if (typeof silenceLimitMs !== 'number' || !Number.isFinite(silenceLimitMs) || silenceLimitMs <= 0) {
        throw new Error(`[watchdog] armMainThreadWatchdog: need a positive finite silence limit, got ${silenceLimitMs}`);
    }
    const { ctl } = _need();
    Atomics.store(ctl, LIMIT, Math.ceil(silenceLimitMs));
    Atomics.notify(ctl, LIMIT);
    Atomics.notify(ctl, BEAT);   // a worker already waiting re-reads the limit
}

/** One heartbeat from the main loop. */
export function beatMainThreadWatchdog() {
    const { ctl } = _need();
    Atomics.add(ctl, BEAT, 1);
    Atomics.notify(ctl, BEAT);
}

/**
 * Latest attribution for the worker to print if the main loop stops.
 * @param {{ phases: string[], skill: string, stack: string }} ev
 */
export function publishMainThreadEvidence(ev) {
    _need().port.postMessage(ev);
}
