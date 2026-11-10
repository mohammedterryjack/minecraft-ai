// fix64 fixture: a process that arms the real stall guard + watchdog from synthetic keep_alive packets, then either spins
// forever on the main thread (argv[2] === 'spin') or stays healthy and exits 0 after a few armed beat periods.
import { EventEmitter } from 'node:events';
import { startMainThreadWatchdog } from '../../src/utils/main_thread_watchdog.js';
import { startEventLoopStallGuard, pushStallPhase, stallPollIntervalMsForThreshold } from '../../src/utils/event_loop_guard.js';

const mode = process.argv[2];
const gapMs = Number(process.argv[3]);
const bot = { _client: new EventEmitter() };
startMainThreadWatchdog(process.argv[4]);   // fix65: evidence file for the next process
startEventLoopStallGuard(bot);
bot._client.emit('keep_alive');
setTimeout(() => {
    bot._client.emit('keep_alive');   // second packet: the guard learns the gap and arms the watchdog
    pushStallPhase('fixture:voyager:exec');
    bot.__psnRunningSkill = 'spinForever';
    bot.__psnStackStr = process.argv[5];
    if (mode === 'spin') {
        setImmediate(function spinForever() { for (;;) { /* never yields */ } });
    } else {
        const poll = stallPollIntervalMsForThreshold(bot.__eventLoopStallThresholdMs);
        setTimeout(() => process.exit(0), 3 * poll);
    }
}, gapMs);
