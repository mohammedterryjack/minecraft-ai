// fix94: the Minecraft backend tells us it is back by writing its own startup line.
// launchd WatchPaths/PathState are not used (launchd.plist(5): WatchPaths is race-prone
// and can miss modifications; PathState is race-prone). fs.watch on the log directory
// sees latest.log being replaced when the server gzips the old file and creates a new one.
// https://nodejs.org/api/fs.html#caveats — a directory watch is not a poll. Re-read from
// the saved offset on every event and once at arm time, so a missed event is recovered
// on the next one and an old Done line (already on disk at arm) never counts.
import fs from 'node:fs';
import path from 'node:path';

// Vanilla dedicated server, e.g. [12:05:38] [Server thread/INFO]: Done (146.414s)!
export const DONE_RE = /\]: Done \(\d+(?:\.\d+)?s\)!/;
export const STOPPING_MARK = 'Stopping server';

export function requireBackendLogDir(settings) {
    if (!settings || typeof settings !== 'object') throw new Error('[fix94] settings required');
    if (!Object.hasOwn(settings, 'backend_log_dir')) {
        throw new Error('[fix94] backend_log_dir is required; no backend readiness source configured');
    }
    const logDir = settings.backend_log_dir;
    if (typeof logDir !== 'string' || logDir.length === 0) {
        throw new Error('[fix94] backend_log_dir is required; no backend readiness source configured');
    }
    const latest = path.join(logDir, 'latest.log');
    if (!fs.existsSync(latest)) {
        throw new Error(`[fix94] ${latest} is missing; backend_log_dir has no latest.log`);
    }
    return logDir;
}

// The bot's link is settings host/port (ViaProxy on the iMac). The refusal text names
// ViaProxy's backend, which is not this link, so the classifier does not match an address.
export function configuredLink(settings) {
    if (!settings || typeof settings.host !== 'string' || settings.host.length === 0) {
        throw new Error('[fix94] settings.host required');
    }
    const port = settings.port;
    if (typeof port === 'number' && Number.isInteger(port)) return `${settings.host}:${port}`;
    if (typeof port === 'string' && /^[0-9]+$/.test(port)) return `${settings.host}:${port}`;
    throw new Error('[fix94] settings.port required');
}

export function armBackendReady({ logDir }) {
    if (typeof logDir !== 'string' || logDir.length === 0) {
        throw new Error('[fix94] backend_log_dir is required; no backend readiness source configured');
    }
    const logPath = path.join(logDir, 'latest.log');
    let ino = null;
    let offset = 0;
    let carry = '';
    let stopping = null;
    let done = null;
    let settled = false;
    let resolveReady;
    let rejectReady;
    let resolveStopping;
    const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const stopped = new Promise((resolve) => {
        resolveStopping = resolve;
    });

    function stat() {
        try {
            return fs.statSync(logPath);
        } catch (err) {
            if (err && err.code === 'ENOENT') return null;
            throw err;
        }
    }

    const initial = stat();
    if (initial) {
        ino = initial.ino;
        offset = initial.size;
    }

    function finish(line) {
        if (settled) return;
        settled = true;
        watcher.close();
        resolveReady(line);
    }

    function fail(err) {
        if (settled) return;
        settled = true;
        rejectReady(err);
        watcher.close();
    }

    function readNew() {
        if (settled) return;
        const st = stat();
        if (!st) return;
        if (ino === null || st.ino !== ino || st.size < offset) {
            ino = st.ino;
            offset = 0;
            carry = '';
        }
        if (st.size === offset) return;
        let fd;
        try {
            fd = fs.openSync(logPath, 'r');
        } catch (err) {
            if (err && err.code === 'ENOENT') return;
            throw err;
        }
        try {
            const len = st.size - offset;
            const buf = Buffer.alloc(len);
            const n = fs.readSync(fd, buf, 0, len, offset);
            offset += n;
            ino = st.ino;
            const text = carry + buf.subarray(0, n).toString('utf8');
            const lines = text.split('\n');
            carry = lines.pop();
            for (const line of lines) {
                if (stopping === null && line.includes(STOPPING_MARK)) {
                    stopping = line;
                    resolveStopping(line);
                }
                if (done === null && DONE_RE.test(line)) done = line;
            }
            if (done !== null) finish(done);
        } finally {
            fs.closeSync(fd);
        }
    }

    let watcher;
    watcher = fs.watch(logDir, { persistent: true }, () => {
        try {
            readNew();
        } catch (err) {
            fail(err);
        }
    });
    watcher.on('error', (err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
    });
    try {
        readNew();
    } catch (err) {
        fail(err);
    }

    return {
        ready,
        stopped,
        readNew,
        sawStopping() { return stopping !== null; },
        stoppingLine() { return stopping; },
        close() {
            if (settled) return;
            settled = true;
            watcher.close();
        },
    };
}
