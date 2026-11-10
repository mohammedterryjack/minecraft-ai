// The worker has already exited. process.exit must say so and return, not wait for its ack.
import { startMainThreadWatchdog } from '../../src/utils/main_thread_watchdog.js';
import { watchdogBeatPeriodMs } from '../../src/utils/event_loop_guard.js';

const wd = startMainThreadWatchdog(process.argv[2]);
setInterval(() => {}, watchdogBeatPeriodMs());
process.on('uncaughtException', (err) => {
    const msg = err && err.message ? err.message : String(err);
    if (!msg.includes('LOUD FAIL: watchdog worker exited')) {
        process.stderr.write(`[watchdog] LOUD: unexpected ${msg}\n`);
        process.exit(1);
    }
    process.exit(0);
});
wd.worker.terminate();
