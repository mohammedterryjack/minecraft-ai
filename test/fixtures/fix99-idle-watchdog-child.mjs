// fix99: the 06:40:21Z kill. A keep_alive gap of 3133ms armed SIGKILL at 3133 + floor(3133/2)
// after earlier gaps had armed a 33–40s limit. Evidence was "no phase" and "no bot API call".
// This process learns long gaps, then that short gap, then holds the main thread with no phase
// and no bot API call for longer than 4699ms. The grounded budget must keep it alive.
import { EventEmitter } from 'node:events';
import { startMainThreadWatchdog } from '../../src/utils/main_thread_watchdog.js';
import { startEventLoopStallGuard, KEEP_ALIVE_INTERVAL_MS } from '../../src/utils/event_loop_guard.js';

const SHORT_GAP_MS = 3133;
const collapsedMs = SHORT_GAP_MS + Math.floor(SHORT_GAP_MS / 2);
const evidence = process.argv[2];
const bot = { _client: new EventEmitter() };
startMainThreadWatchdog(evidence);
startEventLoopStallGuard(bot);

const realNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
bot._client.emit('keep_alive');
for (const gap of [KEEP_ALIVE_INTERVAL_MS * 2, KEEP_ALIVE_INTERVAL_MS + Math.floor(KEEP_ALIVE_INTERVAL_MS / 2), SHORT_GAP_MS]) {
    now += gap;
    bot._client.emit('keep_alive');
}
Date.now = realNow;

const holdMs = collapsedMs + Math.floor(SHORT_GAP_MS / 2);
const start = performance.now();
while (performance.now() - start < holdMs) { /* no phase, no bot API call */ }
process.exit(0);
