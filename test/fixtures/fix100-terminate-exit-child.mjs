// terminate() does not emit 'exit' in the same tick. process.exit on that tick must not wait
// for an ack the worker will not send.
import { startMainThreadWatchdog, READY } from '../../src/utils/main_thread_watchdog.js';
import { watchdogBeatPeriodMs } from '../../src/utils/event_loop_guard.js';

const wd = startMainThreadWatchdog(process.argv[2]);
setInterval(() => {}, watchdogBeatPeriodMs());
while (Atomics.load(wd.ctl, READY) !== 1) { /* READY is stored before terminate can race the ack */ }
wd.worker.terminate();
process.exit(0);
