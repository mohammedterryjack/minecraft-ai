// Keep-alives further apart than half the kick limit (a healthy vanilla cycle is already
// >= 15000 ms), then a real synchronous block. The capture must name the block, not the
// timer that was running while the bot was healthy.
import { EventEmitter } from 'node:events';
import { startMainThreadWatchdog, beatMainThreadWatchdog } from '../../src/utils/main_thread_watchdog.js';
import { startEventLoopStallGuard, KEEP_ALIVE_INTERVAL_MS, KEEP_ALIVE_KICK_MS } from '../../src/utils/event_loop_guard.js';

const GAP_MS = (KEEP_ALIVE_INTERVAL_MS + KEEP_ALIVE_KICK_MS) / 2;
const START_AFTER_KEEPALIVE_MS = 13_000;
const BLOCK_MS = 20_000;
const bot = { _client: new EventEmitter() };
startMainThreadWatchdog(process.argv[2]);
startEventLoopStallGuard(bot);
// bound once: the `performance` global accessor puts a `get performance` frame on any sample
// that lands in it, racing laterRealBlock for callFrames[0]
const now = performance.now.bind(performance);
// The 13 s gap before the block is waited SYNCHRONOUSLY: a setTimeout gap drifts late under
// suite load while the worker's deadlines (anchored on hrtime stamps) do not.
function waitSync(ms) {
    const t0 = now();
    while (now() - t0 < ms) { /* silence without the event loop */ }
}
function laterRealBlock() {
    const start = now();
    while (now() - start < BLOCK_MS) { /* the block the kill must name */ }
}
// The GAP waits stay on the event loop so the stall-guard poll beats the watchdog heartbeat;
// a synchronous GAP starves the beat and the heartbeat kill fires mid-keepalive phase.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < 3; i++) {
    bot._client.emit('keep_alive');
    if (i < 2) await sleep(GAP_MS);
}
// Beat the heartbeat in the same synchronous turn as the last keep-alive — an alive loop beats
// right up to the moment it blocks. Without this the last poll tick trails the keep-alive by up
// to one beat period, and both worker clocks anchor on that tick: the capture (heartbeat silent
// limit/2) fires during the 13 s wait before the block (it named `waitSync`, and under suite
// load a drifting setTimeout gap made it name `get performance`/`fireDOMTimer`), and the
// heartbeat kill (tick + 30 s) would beat the keep-alive deadline (ka + 30 s) with killClock
// 'heartbeat'. Anchored at the keep-alive: capture lands 15 s into the 20 s block window
// (block starts at +13 s), the kill at +30 s names the ka clock — both deterministic because
// the final gap is waited synchronously and cannot drift.
beatMainThreadWatchdog();
waitSync(START_AFTER_KEEPALIVE_MS);
laterRealBlock();
console.error('block ended without kill');
process.exit(0);
