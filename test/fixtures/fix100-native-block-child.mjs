// A native block (execSync) right after a keep-alive. The inspector cannot pause it.
// The kill is the keep-alive deadline, and the record says the stack was not captured.
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import { startMainThreadWatchdog } from '../../src/utils/main_thread_watchdog.js';
import { startEventLoopStallGuard, KEEP_ALIVE_INTERVAL_MS, KEEP_ALIVE_KICK_MS } from '../../src/utils/event_loop_guard.js';

const blockSec = (KEEP_ALIVE_KICK_MS + KEEP_ALIVE_INTERVAL_MS) / 1000;
const bot = { _client: new EventEmitter() };
startMainThreadWatchdog(process.argv[2]);
startEventLoopStallGuard(bot);
bot._client.emit('keep_alive');
console.error('native block start');
execSync(`sleep ${blockSec}`);
console.error('native block ended');
process.exit(0);
