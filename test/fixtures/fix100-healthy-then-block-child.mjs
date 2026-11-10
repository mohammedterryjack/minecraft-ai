// Keep-alives further apart than half the kick limit (a healthy vanilla cycle is already
// >= 15000 ms), then a real synchronous block. The capture must name the block, not the
// timer that was running while the bot was healthy.
import { EventEmitter } from 'node:events';
import { startMainThreadWatchdog } from '../../src/utils/main_thread_watchdog.js';
import { startEventLoopStallGuard, KEEP_ALIVE_INTERVAL_MS, KEEP_ALIVE_KICK_MS } from '../../src/utils/event_loop_guard.js';

const GAP_MS = (KEEP_ALIVE_INTERVAL_MS + KEEP_ALIVE_KICK_MS) / 2;
const START_AFTER_KEEPALIVE_MS = 13_000;
const BLOCK_MS = 20_000;
const bot = { _client: new EventEmitter() };
startMainThreadWatchdog(process.argv[2]);
startEventLoopStallGuard(bot);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < 3; i++) {
    bot._client.emit('keep_alive');
    if (i < 2) await sleep(GAP_MS);
}
await sleep(START_AFTER_KEEPALIVE_MS);
function laterRealBlock() {
    const start = performance.now();
    while (performance.now() - start < BLOCK_MS) { /* the block the kill must name */ }
}
laterRealBlock();
console.error('block ended without kill');
process.exit(0);
