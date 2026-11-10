// fix99: a real 31s silence. The kick bound is 15000×2 = 30000ms, so 31s with no heartbeat
// arms SIGKILL. This is wall time, not a Date.now gap.
import { EventEmitter } from 'node:events';
import { startMainThreadWatchdog } from '../../src/utils/main_thread_watchdog.js';
import { startEventLoopStallGuard } from '../../src/utils/event_loop_guard.js';

const evidence = process.argv[2];
const bot = { _client: new EventEmitter() };
startMainThreadWatchdog(evidence);
startEventLoopStallGuard(bot);
const start = performance.now();
while (performance.now() - start < 31_000) { /* no phase, no bot API call */ }
process.exit(0);
