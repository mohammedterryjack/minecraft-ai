// fix100: a 20s synchronous block that starts 13s after a keep-alive.
// The beat-silence kill is 30s with no heartbeat, so this block alone never reaches it.
// The server kicks once the block covers the last keep-alive plus one interval and the
// following interval (vanilla keepConnectionAlive, 15000L). The watchdog must kill during
// the block and the inspector stack must name it.
import { EventEmitter } from 'node:events';
import { startMainThreadWatchdog, publishMainThreadCode } from '../../src/utils/main_thread_watchdog.js';
import { startEventLoopStallGuard, pushStallPhase, popStallPhase } from '../../src/utils/event_loop_guard.js';

const START_AFTER_KEEPALIVE_MS = 13_000;
const BLOCK_MS = 20_000;

const bot = { _client: new EventEmitter() };
startMainThreadWatchdog(process.argv[2]);
startEventLoopStallGuard(bot);
publishMainThreadCode({ label: 'voyager:stage-exec', source: 'async function eatFood(bot) { /* this run already settled */ }' });
pushStallPhase('action:hunger-serve');
popStallPhase();
bot._client.emit('keep_alive');
const stamped = performance.now();
await new Promise((resolve) => setTimeout(resolve, START_AFTER_KEEPALIVE_MS - (performance.now() - stamped)));
const spinStart = performance.now();
function blockedInHungerServe() {
    while (performance.now() - spinStart < BLOCK_MS) { /* the hunger-serve planner block */ }
}
blockedInHungerServe();
process.exit(0);
