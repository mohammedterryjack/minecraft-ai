// The worker crashes. Node emits 'error' before 'exit'. The error handler throws, which is an
// uncaughtException, then the fatal path (Voyager._onProcessError → agent.fatal → fatalExit)
// calls process.exit. That exit must return. The worker cannot ack after 'error'.
import { startMainThreadWatchdog, READY } from '../../src/utils/main_thread_watchdog.js';
import { watchdogBeatPeriodMs } from '../../src/utils/event_loop_guard.js';
import { fatalExit } from '../../src/agent/fatal.js';

const wd = startMainThreadWatchdog(process.argv[2]);
setInterval(() => {}, watchdogBeatPeriodMs());
process.on('uncaughtException', (err) => {
    fatalExit('fix100', 'UNCAUGHT EXCEPTION outside a task step', err);
});
while (Atomics.load(wd.ctl, READY) !== 1) { /* READY is stored before the worker accepts a message */ }
wd.port.postMessage({ code: { label: 'x', source: 's', at: 'now', gen: 1 } });
wd.port.postMessage({ codeEnded: null });
