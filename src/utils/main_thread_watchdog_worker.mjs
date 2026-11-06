// fix64: watchdog worker (see main_thread_watchdog.js). Runs only Atomics.wait + synchronous calls: nothing here waits on
// any event loop, so a blocked main thread cannot block it.
import { workerData, receiveMessageOnPort } from 'node:worker_threads';
import { writeSync } from 'node:fs';

const BEAT = 0, LIMIT = 1;
const ctl = new Int32Array(workerData.sab);
const port = workerData.port;
const pid = workerData.pid;
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
    process.kill(pid, 'SIGKILL');
}
