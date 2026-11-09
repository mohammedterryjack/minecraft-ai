// fix93: ViaProxy delivered the kick, and the backend refused the connection.
// fix94: exit 0 under KeepAlive { SuccessfulExit: false } is never restarted (launchd.plist(5):
// SuccessfulExit false restarts "in the inverse condition"). The process stays up and watches
// the backend log. The first Done line after the refusal exits EX_TEMPFAIL (75, sysexits(3):
// "temp failure; user is invited to retry"), and launchd respawns exactly once. No plist change.
import { armBackendReady } from './backend_ready.js';

export const EXIT_BACKEND_UNAVAILABLE = 0;
// sysexits.h EX_TEMPFAIL — temporary failure, the caller is invited to retry. Not a tuned timer.
export const EXIT_BACKEND_READY = 75;

// Transport evidence only. The kick names ViaProxy's backend address, which is not settings
// host/port (the bot connects to the proxy). A literal address would miss a moved backend.
const REFUSAL_MARK = 'Connection refused';

function reasonText(reason) {
    if (typeof reason === 'string') return reason;
    if (reason instanceof Error) return reason.message;
    if (reason === null || reason === undefined) return '';
    if (typeof reason === 'object' && typeof reason.message === 'string') return reason.message;
    return '';
}

// Transport evidence only. A generic kick, ban, auth failure, protocol error, or
// "connection reset" is not a backend refusal.
export function classifyBackendRefusal(event, reason) {
    const text = reasonText(reason);
    if (text.length === 0) return null;
    if (!text.includes(REFUSAL_MARK)) return null;
    const transport = text.includes('finishConnect') || text.includes('AnnotatedConnectException') || text.includes('error(-61)');
    if (!transport) return null;
    return { kind: 'backend-unavailable', event, evidence: text };
}

export function latchDisconnect(latch, event, reason) {
    if (!latch || typeof latch !== 'object') throw new Error('[fix93] disconnect latch required');
    if (latch.latched === true) return { duplicate: true, kind: latch.kind, evidence: latch.evidence };
    const refusal = classifyBackendRefusal(event, reason);
    if (refusal) {
        latch.latched = true;
        latch.kind = 'backend-unavailable';
        latch.evidence = refusal.evidence;
        return { duplicate: false, kind: 'backend-unavailable', evidence: refusal.evidence };
    }
    latch.latched = true;
    latch.kind = 'disconnect';
    latch.evidence = reasonText(reason);
    return { duplicate: false, kind: 'disconnect', evidence: latch.evidence };
}

export function disconnectExitCode(outcome) {
    if (!outcome || outcome.duplicate === true) throw new Error('[fix93] a duplicate disconnect is not a second exit');
    if (outcome.kind === 'backend-unavailable') return EXIT_BACKEND_UNAVAILABLE;
    if (outcome.kind === 'disconnect') return 1;
    throw new Error(`[fix93] unknown disconnect outcome ${JSON.stringify(outcome && outcome.kind)}`);
}

export function applyDisconnect(latch, event, reason, exitFn) {
    const outcome = latchDisconnect(latch, event, reason);
    if (outcome.duplicate) return outcome;
    if (typeof exitFn !== 'function') throw new Error('[fix93] exit function required');
    exitFn(disconnectExitCode(outcome), outcome);
    return outcome;
}

export function latchBackendStopping(latch, event, reason) {
    if (!latch || typeof latch !== 'object') throw new Error('[fix94] disconnect latch required');
    if (latch.latched === true) return { duplicate: true, kind: latch.kind, evidence: latch.evidence };
    latch.latched = true;
    latch.kind = 'backend-stopping';
    latch.evidence = reasonText(reason);
    return { duplicate: false, kind: 'backend-stopping', event, evidence: latch.evidence };
}

export function authorizeBackendResume(latch) {
    if (!latch || latch.latched !== true) {
        throw new Error('[fix93] resume requires a latched backend-unavailable outcome');
    }
    if (latch.kind !== 'backend-unavailable' && latch.kind !== 'backend-stopping') {
        throw new Error('[fix93] resume requires a latched backend-unavailable outcome');
    }
    latch.latched = false;
    latch.kind = null;
    latch.evidence = null;
    latch.resumed = true;
}

// The Done line has been written. Exit 75 so launchd's SuccessfulExit false respawns once.
export function resumeWhenBackendReady({ logDir, latch, exitFn, watch, log }) {
    if (typeof logDir !== 'string' || logDir.length === 0) {
        throw new Error('[fix94] backend_log_dir is required; no backend readiness source configured');
    }
    if (typeof exitFn !== 'function') throw new Error('[fix94] exit function required');
    if (typeof log !== 'function') throw new Error('[fix94] log function required');
    let handle = watch;
    if (handle === undefined || handle === null) handle = armBackendReady({ logDir });
    if (!handle || typeof handle.ready !== 'object' || typeof handle.ready.then !== 'function') {
        throw new Error('[fix94] backend watch has no ready promise');
    }
    return handle.ready.then((line) => {
        if (typeof line !== 'string' || line.length === 0) throw new Error('[fix94] backend ready line missing');
        log(`[connection] backend ready: ${line}`);
        authorizeBackendResume(latch);
        exitFn(EXIT_BACKEND_READY);
        return line;
    });
}

// KeepAlive { SuccessfulExit: false } restarts only when the exit is not successful.
export function launchdWouldRestart(exitCode, policy) {
    if (!policy || policy.successfulExit !== false) throw new Error('[fix93] policy must be KeepAlive SuccessfulExit false');
    if (typeof exitCode !== 'number') throw new Error('[fix93] exit code required');
    return exitCode !== 0;
}

export function parentExitForChild(code, signal) {
    if (signal === 'SIGINT' && (code === 0 || code === null)) return { code: 0, kind: 'interrupt' };
    if (code === EXIT_BACKEND_UNAVAILABLE && (signal === null || signal === undefined)) return { code: 0, kind: 'successful-exit' };
    if (code === EXIT_BACKEND_READY && (signal === null || signal === undefined)) return { code: EXIT_BACKEND_READY, kind: 'backend-ready' };
    if (typeof code === 'number' && code !== 0) return { code, kind: 'crash' };
    return { code: 1, kind: 'crash' };
}

export function wrapperPreservesStatus(script) {
    if (typeof script !== 'string' || script.length === 0) throw new Error('[fix93] wrapper script required');
    const execAt = script.lastIndexOf('exec node');
    if (execAt < 0) throw new Error('[fix93] wrapper must exec node so the child status is the process status');
    if (/exit\s+/.test(script.slice(execAt))) throw new Error('[fix93] wrapper remaps the status after exec');
    return true;
}
