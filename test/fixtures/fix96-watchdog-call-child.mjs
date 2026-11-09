// fix96 fixture: arms the real stall guard + watchdog from synthetic keep_alive packets, publishes a staged bundle the way
// coder._stageCode does, then blocks the main thread INSIDE a bot API call made through the bot_api_timing proxy (the way
// generated code calls bot.findBlocks). The kill evidence must name that call and carry the staged source.
import { EventEmitter } from 'node:events';
import { startMainThreadWatchdog, publishMainThreadCode } from '../../src/utils/main_thread_watchdog.js';
import { startEventLoopStallGuard, pushStallPhase } from '../../src/utils/event_loop_guard.js';
import { wrapBotForApiTiming } from '../../src/utils/bot_api_timing.js';

const gapMs = Number(process.argv[2]);
const bot = { _client: new EventEmitter(), findBlocks() { for (;;) { /* a search that never returns */ } } };
startMainThreadWatchdog(process.argv[3]);
startEventLoopStallGuard(bot);
bot._client.emit('keep_alive');
setTimeout(() => {
    bot._client.emit('keep_alive');
    pushStallPhase('fixture:voyager:exec');
    publishMainThreadCode({ label: 'fixture:voyager:exec', source: 'async function searchFar(bot) { return bot.findBlocks({ matching: 81, maxDistance: 512, count: 1 }); }' });
    bot.__psnStackStr = 'searchFar';
    const proxied = wrapBotForApiTiming(bot);
    setImmediate(() => proxied.findBlocks({ matching: 81, maxDistance: 512, count: 1 }));
}, gapMs);
