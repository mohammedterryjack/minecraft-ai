// fix87: a launchd bootout (SIGTERM) and a socket reconnect used to end the process with no line
// ("step end" was followed by a new "MindServer running"). Every signal, unhandled rejection
// with nobody to own it, and process.exit is written to fd 2 with writeSync before the process
// ends, so a full stdout buffer cannot swallow it. console.log is block-buffered when stdout
// is the log file (run-native.sh).
//
// A V8 heap abort (--max-old-space-size) does not run JavaScript. It writes
// "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"
// to stderr, which is the same log, and the process dies without a "signal SIGTERM" line.
// Every line this module writes includes heapUsed and heapLimit so a near-limit exit is
// distinguishable from a signal.
import { writeSync } from 'node:fs';
import { inspect } from 'node:util';
import v8 from 'node:v8';

const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

let logged = false;
let exitFn = (code) => process.exit(code);

export function exitLoudLine(cause) {
    if (typeof cause !== 'string' || cause === '') throw new Error('[fix87] exitLoudLine: cause required');
    const u = process.memoryUsage();
    const lim = v8.getHeapStatistics().heap_size_limit;
    return `[exit] LOUD: ${cause} pid=${process.pid} heapUsed=${u.heapUsed} heapLimit=${lim}\n`;
}

export function writeProcessLoud(cause) {
    writeSync(2, exitLoudLine(cause));
}

// The cause is on disk. A later 'exit' listener must not repeat it.
export function logExitCause(cause) {
    writeProcessLoud(cause);
    logged = true;
}

export function signalExitCode(sig) {
    if (!Object.hasOwn(SIGNAL_EXIT, sig)) throw new Error(`[fix87] LOUD: no exit code for signal ${sig}`);
    return SIGNAL_EXIT[sig];
}

export function onProcessSignal(sig) {
    const code = signalExitCode(sig);
    logExitCause(`signal ${sig}; exiting ${code}`);
    exitFn(code);
}

export function _setExitForTest(fn) {
    if (typeof fn !== 'function') throw new Error('[fix87] _setExitForTest: exit function required');
    exitFn = fn;
}

function rejectionText(reason) {
    return reason instanceof Error ? reason.stack : inspect(reason, { depth: 6, maxArrayLength: 50, breakLength: 120 });
}

// Parent (main.js) and child (init_agent.js). Returns a disposer so a test can remove the listeners.
export function installExitLogging() {
    if (globalThis.__exitLogging) return globalThis.__exitLogging;
    const sigs = Object.keys(SIGNAL_EXIT);
    const sigHandlers = {};
    for (const sig of sigs) {
        sigHandlers[sig] = () => onProcessSignal(sig);
        process.on(sig, sigHandlers[sig]);
    }
    const onExit = (code) => {
        if (logged) return;
        writeProcessLoud(`process exit code ${code}`);
    };
    const onMonitor = (err, origin) => {
        const text = err instanceof Error ? err.stack : inspect(err, { depth: 6, maxArrayLength: 50, breakLength: 120 });
        writeProcessLoud(`${origin}: ${text}`);
    };
    const onRejection = (reason) => {
        const text = rejectionText(reason);
        // Voyager's own listener decides whether a rejection during a task step keeps the process alive.
        // Before that listener exists, Node's default is to exit 1. A listener suppresses that default,
        // so this one exits when nothing else will.
        if (!globalThis.__voyagerGuard) {
            logExitCause(`unhandled rejection (no task loop): ${text}`);
            exitFn(1);
            return;
        }
        writeProcessLoud(`unhandled rejection: ${text}`);
    };
    process.on('exit', onExit);
    process.on('uncaughtExceptionMonitor', onMonitor);
    process.on('unhandledRejection', onRejection);
    const dispose = () => {
        for (const sig of sigs) process.removeListener(sig, sigHandlers[sig]);
        process.removeListener('exit', onExit);
        process.removeListener('uncaughtExceptionMonitor', onMonitor);
        process.removeListener('unhandledRejection', onRejection);
        logged = false;
        if (globalThis.__exitLogging === dispose) globalThis.__exitLogging = null;
    };
    globalThis.__exitLogging = dispose;
    return dispose;
}
