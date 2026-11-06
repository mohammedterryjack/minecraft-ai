// fix64: watchdog worker (see main_thread_watchdog.js). Runs only Atomics.wait + synchronous calls: nothing here waits on
// any event loop, so a blocked main thread cannot block it.
import { workerData, receiveMessageOnPort } from 'node:worker_threads';
import { writeSync, writeFileSync, renameSync } from 'node:fs';

const BEAT = 0, LIMIT = 1;
const ctl = new Int32Array(workerData.sab);
const port = workerData.port;
const pid = workerData.pid;
const evidencePath = workerData.evidencePath;
let evidence = { phases: [], skill: '(none published)', stack: '(none published)' };
const drain = () => { for (let m = receiveMessageOnPort(port); m; m = receiveMessageOnPort(port)) evidence = m.message; };

while (Atomics.load(ctl, LIMIT) === 0) Atomics.wait(ctl, LIMIT, 0);
let seen = Atomics.load(ctl, BEAT);
let since = performance.now();
for (;;) {
    const limit = Atomics.load(ctl, LIMIT);
    const silent = performance.now() - since;
    if (silent < limit) {
        Atomics.wait(ctl, BEAT, seen, limit - silent);
        const now = Atomics.load(ctl, BEAT);
        if (now !== seen) { seen = now; since = performance.now(); drain(); }
        continue;
    }
    drain();
    const phaseStr = evidence.phases.length ? evidence.phases.join(' <- ') : '(no phase)';
    writeSync(2, `[watchdog] MAIN THREAD BLOCKED: no heartbeat for ${Math.round(silent)}ms (limit ${limit}ms = learned keep_alive gap + beat period); `
        + `phase_stack="${phaseStr}" skill="${evidence.skill}" stack="${evidence.stack}" at ${new Date().toISOString()}; SIGKILL pid ${pid} so the supervisor restarts it\n`);
    // fix65: the same evidence as a file the next process's learner reads (counts the hang against the trial candidate on
    // the stack). The kill happens even if the write throws.
    // fix79: written to a temp file and renamed, so the file is either absent or complete (writeFileSync truncates first).
    try {
        const tmp = `${evidencePath}.tmp-${pid}`;
        writeFileSync(tmp, JSON.stringify({ pid, at: new Date().toISOString(), silentMs: Math.round(silent), limitMs: limit, phases: evidence.phases, skill: evidence.skill, stack: evidence.stack }));
        renameSync(tmp, evidencePath);
    } finally {
        process.kill(pid, 'SIGKILL');
    }
    // fix79: one kill, then nothing. A self-SIGKILL does not stop this thread at once (macOS: the worker ran on after kill()
    // returned), so the loop went round again, re-logged, and re-wrote the evidence file - truncating it - while the process
    // was torn down: iMac, 40 runs of the fix64 child: 5 double/triple "MAIN THREAD BLOCKED" lines, 2 empty evidence files
    // (the flaky fix65 end-to-end test's "Unexpected end of JSON input", and an empty file for the next process's learner).
    // Park on a cell no one else can notify: Atomics.wait with no timeout never returns.
    const parked = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(parked, 0, 0);
    throw new Error(`[watchdog] worker woke after SIGKILL of pid ${pid}; nothing can notify its parked cell`);
}
