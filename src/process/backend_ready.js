// fix94: the Minecraft backend tells us it is back by writing its own startup line.
// launchd WatchPaths/PathState are not used (launchd.plist(5): WatchPaths is race-prone
// and can miss modifications; PathState is race-prone). fs.watch on the log directory
// sees latest.log being replaced when the server gzips the old file and creates a new one.
// https://nodejs.org/api/fs.html#caveats — a directory watch is not a poll. Re-read from
// the saved offset on every event. Arm does not start at EOF: a refusal during startup
// can land after the server has already written Done, and skipping that line waits forever.
// The current run is the minecraft server process. Vanilla
// log4j2.xml (server jar, and the same appender wiki.vg documents) is a
// RollingRandomAccessFile: fileName logs/latest.log, filePattern
// logs/%d{yyyy-MM-dd}-%i.log.gz, with TimeBasedTriggeringPolicy and
// OnStartupTriggeringPolicy. TimeBasedTriggeringPolicy rolls when the smallest unit
// in that %d pattern changes (Apache Log4j, Rolling file appenders: daily, at midnight
// of the server timezone, on the next log event). The JVM keeps running, so the
// "Starting minecraft server" line is in the gzip and latest.log is the tail of the
// same run. OnStartupTriggeringPolicy rolls because a new JVM started; that process
// has a new pid and its start line is in the new latest.log. The running server is
// launchd job com.mo.minecraftserver (launchctl print gui/<uid>/com.mo.minecraftserver,
// launchctl(1): print service-target). Its pid is the run. A latest.log with no start
// line is that process's post-rollover tail. A job that is not running is not a run.
// Rotated .gz files are not read.
import fs from 'node:fs';
import path from 'node:path';

// Vanilla dedicated server, e.g. [12:05:38] [Server thread/INFO]: Done (146.414s)!
export const DONE_RE = /\]: Done \(\d+(?:\.\d+)?s\)!/;
export const STOPPING_MARK = 'Stopping server';
// The first line of a server run, e.g. [12:04:00] [Server thread/INFO]: Starting minecraft server version 1.21.4
export const START_MARK = 'Starting minecraft server';
// launchd job that runs ~/bin/start-minecraftserver-screen.sh (settings.js).
export const MINECRAFT_SERVER_JOB = 'com.mo.minecraftserver';
export const LAUNCHCTL = 'launchctl';

export function launchdTarget(uid) {
    if (!Number.isInteger(uid) || uid < 0) throw new Error('[fix99] uid required to address the launchd gui domain');
    return `gui/${uid}/${MINECRAFT_SERVER_JOB}`;
}

// Top-level `launchctl print` keys are one tab. Nested dictionaries are indented further and are not the job.
function launchdField(text, name) {
    const prefix = `\t${name} = `;
    const lines = text.split('\n').filter((line) => line.startsWith(prefix));
    if (lines.length !== 1) throw new Error(`[fix99] launchctl print has ${lines.length} ${name} lines for ${MINECRAFT_SERVER_JOB}`);
    return lines[0].slice(prefix.length);
}

export function readLaunchdPrint(text) {
    if (typeof text !== 'string' || text.length === 0) throw new Error('[fix99] launchctl print returned no job description');
    const state = launchdField(text, 'state');
    if (state !== 'running') {
        throw new Error(`[fix99] ${MINECRAFT_SERVER_JOB} is ${state}; the minecraft server process is not running`);
    }
    const pidText = launchdField(text, 'pid');
    if (!/^[0-9]+$/.test(pidText)) throw new Error(`[fix99] ${MINECRAFT_SERVER_JOB} pid is not an integer: ${JSON.stringify(pidText)}`);
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`[fix99] ${MINECRAFT_SERVER_JOB} pid is not a live process: ${pidText}`);
    return { pid };
}

export function queryMinecraftServer(execFile) {
    if (typeof execFile !== 'function') throw new Error('[fix99] execFile required');
    const uid = process.getuid();
    if (!Number.isInteger(uid)) throw new Error(`[fix99] process.getuid() returned ${uid}; the launchd gui domain cannot be named`);
    const target = launchdTarget(uid);
    let text;
    try {
        text = execFile(LAUNCHCTL, ['print', target], { encoding: 'utf8' });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[fix99] launchctl print ${target} failed: ${msg}`);
    }
    if (typeof text !== 'string') throw new Error(`[fix99] launchctl print ${target} returned ${typeof text}, not text`);
    return readLaunchdPrint(text);
}

export function requireRunningServer(server) {
    if (server === undefined || server === null || typeof server !== 'object') {
        throw new Error('[fix99] the minecraft server process is not running; cannot locate the current server run');
    }
    if (!Number.isInteger(server.pid) || server.pid <= 0) {
        throw new Error(`[fix99] the minecraft server process is not running (pid ${server.pid}); cannot locate the current server run`);
    }
    return server;
}

// Byte offset of this process's run inside latest.log. A start line in this file is a
// run boundary (the JVM that logged it). No start line means TimeBasedTriggeringPolicy
// already rolled that line into the dated gzip; the bytes here are still pid's run.
export function offsetOfCurrentRun(buf, server) {
    if (!Buffer.isBuffer(buf)) throw new Error('[fix94] latest.log bytes required');
    requireRunningServer(server);
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

export function armBackendReady({ logDir, server }) {
    if (typeof logDir !== 'string' || logDir.length === 0) {
        throw new Error('[fix94] backend_log_dir is required; no backend readiness source configured');
    }
    const running = requireRunningServer(server);
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
    offset = offsetOfCurrentRun(whole, running);

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
