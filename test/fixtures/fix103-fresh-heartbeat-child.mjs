// One keep_alive, then the event loop keeps beating. The kill is the keep-alive clock.
// Heartbeat age stays under the beat interval, which is the live 2369ms case.
import { EventEmitter } from 'node:events';
import { startMainThreadWatchdog } from '../../src/utils/main_thread_watchdog.js';
import { startEventLoopStallGuard } from '../../src/utils/event_loop_guard.js';

const bot = { _client: new EventEmitter() };
startMainThreadWatchdog(process.argv[2]);
startEventLoopStallGuard(bot);
bot._client.emit('keep_alive');
await new Promise(() => {});
