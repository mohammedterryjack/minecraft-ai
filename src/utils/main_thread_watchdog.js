/**
 * fix64: off-main-thread watchdog for the agent process.
 *
 * The #44 stall guard (event_loop_guard.js) and the #44/#59 exit-on-disconnect path are both callbacks on the main event
 * loop: a setInterval poll that reads a monitorEventLoopDelay histogram, and mineflayer 'end'/'kicked' handlers. A loop
 * that never yields blocks all of them, so on 2026-11-06 the process sat blocked from 12:43:42Z (server: "standing on
 * air", then 12:44:12Z "lost connection: Timed out") until a manual kickstart at 13:03:59Z, logging nothing.
 *
 * This watchdog lives in a worker thread, which has its own isolate and is not scheduled by the main loop. It sleeps
 * with Atomics.waitAsync (not Atomics.wait) so its event loop stays free for inspector.Session.connectToMainThread
 * (Node inspector docs: worker threads only). The debugger stays disabled until a deadline. The beat (Nyquist half of
 * the vanilla 15000 ms keep-alive) is evidence of the main loop turning. The kill clock, once a keep-alive packet has
 * been processed, is that packet's time plus the armed limit: vanilla ServerCommonPacketListenerImpl.keepConnectionAlive
 * kicks at one or two 15000L intervals after a keep-alive, and a block of 15–30 s can cover that kick while a heartbeat
 * is still younger than the limit (the 09:07–09:31Z timeouts). Until the first keep-alive, the armed silence limit is
 * the same bound. On a miss the worker writes the last published evidence straight to fd 2 with fs.writeSync, then
 * SIGKILLs the process.
 *
 * Evidence travels over a MessagePort. The worker's event loop drains it, because inspector callbacks need that loop.
 */
import { Worker, MessageChannel } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKER_PATH = fileURLToPath(new URL('./main_thread_watchdog_worker.mjs', import.meta.url));
export const BEAT = 0;
export const LIMIT = 1;
export const READY = 2;
export const CTL_LEN = 3;
// fix96: the bot API call running on the main thread right now, for the kill evidence. A blocked main thread cannot post a
// message, so the call is written into shared memory before it starts: [length, ...utf8 bytes]. The slot holds the longest
// description the worker reports; a longer one is stored with its length so the worker says how much it could not read.
export const CALL_SLOT_BYTES = 8192;

/** @type {{ ctl: Int32Array, kaNs: BigInt64Array, ack: Int32Array, port: import('node:worker_threads').MessagePort, worker: Worker, callLen: Int32Array, callBytes: Uint8Array, encoder: TextEncoder } | null} */
let _wd = null;
let _codeGen = 0;
let _openGen = null;
let _shuttingDown = false;

/** fix65: where the worker leaves its kill evidence for the next process (Voyager._settleDeadTrials reads it). */
export function watchdogEvidencePath(botDir) {
    return `${botDir}/watchdog_kill.json`;
}

/**
 * Start the worker once per process. The stall guard arms it at the keep-alive kick bound (armMainThreadWatchdog).
 * @param {string} evidencePath file the worker writes (synchronously, before SIGKILL) for the next process to read
 */
export function startMainThreadWatchdog(evidencePath) {
    if (typeof evidencePath !== 'string' || !evidencePath) throw new Error('[watchdog] startMainThreadWatchdog: evidence path required');
    if (_wd) return _wd;
    const ctl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CTL_LEN));
    const kaNs = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
    const ack = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const callLen = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const callBytes = new Uint8Array(new SharedArrayBuffer(CALL_SLOT_BYTES));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER_PATH, {
        workerData: { sab: ctl.buffer, kaSab: kaNs.buffer, ackSab: ack.buffer, callLenSab: callLen.buffer, callSab: callBytes.buffer, port: port2, pid: process.pid, evidencePath },
        transferList: [port2],
    });
    let workerAlive = true;
    let workerDeadReason = null;
    // 'error' is emitted before 'exit'. A throw here reaches uncaughtException, then fatalExit, then
    // process.exit, while 'exit' has not run. The flag has to be clear before that throw or process.exit
    // waits on a worker that can no longer ack, and launchd never restarts.
    const markWorkerDead = (reason) => {
        workerAlive = false;
        workerDeadReason = reason;
        Atomics.store(ack, 0, 1);
        Atomics.notify(ack, 0);
    };
    worker.on('error', (e) => {
        markWorkerDead('crashed');
        throw new Error(`[watchdog] LOUD FAIL: watchdog worker crashed: ${e && e.stack ? e.stack : e}`);
    });
    worker.on('exit', (code) => {
        markWorkerDead('exited');
        // The exit event cannot run while the main thread is inside Atomics.wait, so a worker that
        // dies earlier is marked dead by 'error' or by terminate() before any wait.
        if (_shuttingDown) return;
        throw new Error(`[watchdog] LOUD FAIL: watchdog worker exited (code ${code}); the main thread is unguarded`);
    });
    // terminate() only emits 'exit' later. A process.exit in the same tick would still see the worker
    // as alive. The flag is cleared on the call, before the returned promise settles.
    const terminateWorker = worker.terminate.bind(worker);
    worker.terminate = function () {
        markWorkerDead('terminated');
        return terminateWorker();
    };
    worker.unref();
    port1.unref();
    _wd = { ctl, kaNs, ack, port: port1, worker, callLen, callBytes, encoder: new TextEncoder() };
    // A clean exit must disconnect the inspector session first. Node otherwise prints
    // "Waiting for the debugger to disconnect..." (inspector.Session.connectToMainThread).
    // The worker acks after session.disconnect(); waiting on that ack is the worker's own handshake, not a new timer.
    const origExit = process.exit;
    process.exit = function (code) {
        _shuttingDown = true;
        const finish = () => origExit.call(process, code);
        // Wait only while the worker is alive and has reached its message loop, so the shutdown post
        // has a thread that can store the ack. A crash, a terminate(), or a worker that has not
        // reached that loop has no such path: say so and leave. Atomics.wait would not return.
        const ackCanArrive = workerAlive && Atomics.load(ctl, READY) === 1;
        if (!ackCanArrive) {
            const why = !workerAlive
                ? (workerDeadReason === 'exited' ? 'the watchdog worker already exited' : `the watchdog worker ${workerDeadReason}`)
                : 'the watchdog worker is not ready to ack';
            writeSync(2, `[watchdog] LOUD: process.exit with ${why}; not waiting for an ack from a dead worker\n`);
            finish();
            return;
        }
        try {
            port1.postMessage({ shutdown: true });
        } catch (e) {
            const text = e && e.stack ? e.stack : String(e);
            writeSync(2, `[watchdog] LOUD: shutdown post failed: ${text}\n`);
            finish();
            return;
        }
        Atomics.wait(ack, 0, 0);
        if (!workerAlive) writeSync(2, '[watchdog] LOUD: watchdog worker died before acknowledging shutdown; not hanging on its ack\n');
        finish();
    };
    console.log('[watchdog] main-thread watchdog worker started; the stall guard arms it at the keep-alive kick bound');
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
 * @param {number} silenceLimitMs no heartbeat for this long, and last keep-alive plus this long, => SIGKILL
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

/** One heartbeat from the main loop. Evidence that the loop turned. It does not move the keep-alive deadline. */
export function beatMainThreadWatchdog() {
    const { ctl } = _need();
    Atomics.add(ctl, BEAT, 1);
    Atomics.notify(ctl, BEAT);
}

/**
 * fix100: the client's keep_alive handler ran, so this packet was processed. The stamp is process.hrtime (monotonic,
 * shared by the worker). The interval is the armed limit, not the gap since the previous packet: a gap includes stalls,
 * which is the bug fix99 removed from the threshold.
 */
export function noteMainThreadKeepAlive() {
    const { kaNs } = _need();
    Atomics.store(kaNs, 0, process.hrtime.bigint());
}

/**
 * Latest attribution for the worker to print if the main loop stops.
 * @param {{ phases: string[], skill: string, stack: string }} ev
 */
export function publishMainThreadEvidence(ev) {
    _need().port.postMessage(ev);
}

/**
 * fix96: the code about to run on the main thread (the staged bundle). Posted once per staging, not with every evidence
 * update; the worker keeps the latest and writes it into watchdog_kill.json, so a kill names the code that was running.
 * fix100: returns the generation. finishMainThreadCode(gen) clears it when that run settles, so a finished bundle is not
 * blamed for a later block. A finish for an older generation does not clear a newer publish.
 * @param {{ label: string, source: string }} code
 * @returns {number}
 */
export function publishMainThreadCode(code) {
    if (!code || typeof code.label !== 'string' || typeof code.source !== 'string') throw new Error('[watchdog] publishMainThreadCode: { label, source } required');
    const gen = ++_codeGen;
    _openGen = gen;
    _need().port.postMessage({ code: { label: code.label, source: code.source, at: new Date().toISOString(), gen } });
    return gen;
}

/**
 * The staged main for `gen` settled (returned, threw, or was never a function). The worker drops the source when the
 * generation still matches, and records when it finished.
 * @param {number} gen
 */
export function finishMainThreadCode(gen) {
    if (!Number.isInteger(gen) || gen < 1) throw new Error(`[watchdog] finishMainThreadCode: gen must be a positive integer, got ${JSON.stringify(gen)}`);
    if (_openGen === gen) _openGen = null;
    _need().port.postMessage({ codeEnded: { gen, endedAt: new Date().toISOString() } });
}

/** The action phase popped. The staged bundle it wrapped has settled; clear it if a finish was not already posted. */
export function finishOpenMainThreadCode() {
    if (_openGen === null) return;
    finishMainThreadCode(_openGen);
}

/**
 * fix96: the synchronous bot API call starting now ('' when it returned). Written to shared memory: no message, no allocation
 * on the worker side, so it is readable while the main thread is blocked inside that call.
 * @param {string} text
 */
export function noteMainThreadCall(text) {
    if (typeof text !== 'string') throw new Error('[watchdog] noteMainThreadCall: text required');
    const wd = _need();
    const { read, written } = wd.encoder.encodeInto(text, wd.callBytes);
    const full = read < text.length ? Buffer.byteLength(text) : written;
    Atomics.store(wd.callLen, 0, full);
}
