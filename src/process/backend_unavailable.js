// fix93: ViaProxy delivered the kick, and the backend refused the connection.
// That is one terminal outcome. launchd KeepAlive { SuccessfulExit: false } restarts a
// nonzero exit and does not restart exit 0, so this outcome exits 0. A crash stays nonzero.
// There is no launchd key that excludes one nonzero code and still restarts the others.

export const EXIT_BACKEND_UNAVAILABLE = 0;

const REFUSAL = ['Connection refused', '127.0.0.1:25565'];

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
    for (const part of REFUSAL) {
        if (!text.includes(part)) return null;
    }
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

export function authorizeBackendResume(latch) {
    if (!latch || latch.kind !== 'backend-unavailable' || latch.latched !== true) {
        throw new Error('[fix93] resume requires a latched backend-unavailable outcome');
    }
    latch.latched = false;
    latch.kind = null;
    latch.evidence = null;
    latch.resumed = true;
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
