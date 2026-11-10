// fix94: the Minecraft backend tells us it is back by writing its own startup line.
// launchd WatchPaths/PathState are not used (launchd.plist(5): WatchPaths is race-prone
// and can miss modifications; PathState is race-prone). fs.watch on the log directory
// sees latest.log being replaced when the server gzips the old file and creates a new one.
// https://nodejs.org/api/fs.html#caveats — a directory watch is not a poll. Re-read from
// the saved offset on every event. Arm does not start at EOF: a refusal during startup
// can land after the server has already written Done, and skipping that line waits forever.
// The current run is the bytes of latest.log. Vanilla log4j2.xml (server jar, and the
// same appender wiki.vg documents) is a RollingRandomAccessFile: fileName logs/latest.log,
// filePattern logs/%d{yyyy-MM-dd}-%i.log.gz, with TimeBasedTriggeringPolicy and
// OnStartupTriggeringPolicy. TimeBasedTriggeringPolicy rolls when the smallest unit in
// that %d pattern changes (Apache Log4j, Rolling file appenders:
// https://logging.apache.org/log4j/2.x/manual/appenders/rolling-file.html — daily, at
// midnight of the server timezone, on the next log event). The JVM keeps running, so
// the "Starting minecraft server" line moves into the gzip and latest.log has none:
// the current run starts at offset 0. OnStartupTriggeringPolicy rolls because a new
// JVM started, and that JVM's start line is in the new latest.log. A new inode (the
// roll replaced the file) or a shrunk file resets the offset to 0. Rotated .gz files
// are not read. The launchd job's pid is not the run: the job's script exits 0 when
// the screen session already exists, and the pid launchd reports is the screen
// process.
import fs from 'node:fs';
import path from 'node:path';

// Vanilla dedicated server, e.g. [12:05:38] [Server thread/INFO]: Done (146.414s)!
export const DONE_RE = /\]: Done \(\d+(?:\.\d+)?s\)!/;
export const STOPPING_MARK = 'Stopping server';
// The first line of a server run, e.g. [12:04:00] [Server thread/INFO]: Starting minecraft server version 1.21.4
export const START_MARK = 'Starting minecraft server';

// Byte offset of the current run inside latest.log. A start line is a run boundary.
// No start line means TimeBasedTriggeringPolicy already rolled that line into the dated
// gzip while the JVM kept running, so the current run is the whole file.
export function offsetOfCurrentRun(buf) {
    if (!Buffer.isBuffer(buf)) throw new Error('[fix94] latest.log bytes required');
    const text = buf.toString('utf8');
    const at = text.lastIndexOf(START_MARK);
    if (at < 0) return 0;
    const newlineAt = text.lastIndexOf('\n', at);
    const lineStart = newlineAt < 0 ? 0 : newlineAt + 1;
    return Buffer.byteLength(text.slice(0, lineStart));
}

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
    let doneFollowedByStop = false;
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
    if (!initial) throw new Error(`[fix94] ${logPath} is missing; backend_log_dir has no latest.log`);
    const whole = Buffer.alloc(initial.size);
    let fd0;
    try {
        fd0 = fs.openSync(logPath, 'r');
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            throw new Error(`[fix94] ${logPath} is missing; backend_log_dir has no latest.log`);
        }
        throw err;
    }
    try {
        const n = fs.readSync(fd0, whole, 0, initial.size, 0);
        if (n !== initial.size) {
            throw new Error(`[fix94] short read of ${logPath}: wanted ${initial.size} bytes, got ${n}`);
        }
    } finally {
        fs.closeSync(fd0);
    }
    ino = initial.ino;
    offset = offsetOfCurrentRun(whole);

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
        // Log4j's roll replaces latest.log (new inode) or the file shrinks under the saved offset.
        // Either one is a new file boundary: read from the start.
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
                if (line.includes(START_MARK)) {
                    done = null;
                    doneFollowedByStop = false;
                }
                if (line.includes(STOPPING_MARK)) {
                    if (stopping === null) {
                        stopping = line;
                        resolveStopping(line);
                    }
                    if (done !== null) doneFollowedByStop = true;
                }
                if (DONE_RE.test(line)) {
                    done = line;
                    doneFollowedByStop = false;
                }
            }
            if (done !== null && doneFollowedByStop === false) finish(done);
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
