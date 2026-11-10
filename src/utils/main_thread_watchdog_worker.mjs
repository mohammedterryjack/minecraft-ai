// fix64 / fix100: watchdog worker. Atomics.waitAsync leaves this thread's event loop free so
// inspector.Session.connectToMainThread() can deliver Debugger.paused (Node inspector docs; worker threads only).
// Debugger.enable is sent only when a deadline is reached, and Debugger.disable after the frames are copied, so the
// debugger is off while the bot is healthy.
//
// Kill clock: the armed limit is the vanilla kick bound (event_loop_guard.js KEEP_ALIVE_KICK_MS = 15000 × 2).
// Once the main thread has processed a keep_alive, capture at last stamp + limit/2 and kill at last stamp + limit.
// That is ServerCommonPacketListenerImpl.keepConnectionAlive: a pending keep-alive older than 15000L disconnects,
// so the kick lands one or two intervals after the last keep-alive the client handled. A heartbeat does not move
// that deadline. Before any keep-alive, the same limit is silence since the last beat (startup has no server timer yet).
import { workerData } from 'node:worker_threads';
import { writeSync, writeFileSync, renameSync } from 'node:fs';
import { Session } from 'node:inspector';

const BEAT = 0, LIMIT = 1, READY = 2;
const NS = 1_000_000n;
const ctl = new Int32Array(workerData.sab);
if (ctl.length < READY + 1) throw new Error('[watchdog] LOUD: control buffer must hold beat, limit, and ready');
if (!(workerData.kaSab instanceof SharedArrayBuffer) || !(workerData.ackSab instanceof SharedArrayBuffer)) {
    throw new Error('[watchdog] LOUD: worker needs workerData.kaSab and workerData.ackSab (keep-alive stamp and exit ack)');
}
if (!(workerData.callLenSab instanceof SharedArrayBuffer) || !(workerData.callSab instanceof SharedArrayBuffer)) {
    throw new Error('[watchdog] worker needs workerData.callLenSab and workerData.callSab (fix96 bot API call slot)');
}
const kaNs = new BigInt64Array(workerData.kaSab);
const ack = new Int32Array(workerData.ackSab);
const callLen = new Int32Array(workerData.callLenSab);
const callBytes = new Uint8Array(workerData.callSab);
const port = workerData.port;
const pid = workerData.pid;
const evidencePath = workerData.evidencePath;

let evidence = { phases: [], skill: '(none published)', stack: '(none published)' };
let code = null;
let frames = null;
let captureStarted = false;
let dead = false;

const session = new Session();
session.connectToMainThread();

function shutdown() {
    try { session.disconnect(); }
    catch (e) {
        const text = e && e.stack ? e.stack : String(e);
        writeSync(2, `[watchdog] LOUD: inspector disconnect failed: ${text}\n`);
    }
    Atomics.store(ack, 0, 1);
    Atomics.notify(ack, 0);
}

port.on('message', (m) => {
    if (dead) return;
    if (m && m.shutdown === true) { shutdown(); return; }
    if (m && Object.hasOwn(m, 'codeEnded')) {
        const end = m.codeEnded;
        if (code && Object.hasOwn(code, 'gen') && code.gen === end.gen) code = { label: code.label, endedAt: end.endedAt };
        return;
    }
    if (m && Object.hasOwn(m, 'code')) { code = m.code; return; }
    evidence = m;
});
port.start();
Atomics.store(ctl, READY, 1);

function post(method) {
    return new Promise((resolve, reject) => {
        session.post(method, {}, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

function frameText(list) {
    return list.map(f => `${f.functionName}@${f.url}:${f.lineNumber}`).join(' <- ');
}

async function captureStack() {
    if (captureStarted) return;
    captureStarted = true;
    let enabled = false;
    try {
        await post('Debugger.enable');
        enabled = true;
        const paused = new Promise((resolve) => {
            session.once('Debugger.paused', (msg) => resolve(msg));
        });
        await post('Debugger.pause');
        const msg = await paused;
        const callFrames = msg && msg.params ? msg.params.callFrames : undefined;
        if (dead) return;
        if (!Array.isArray(callFrames) || callFrames.length === 0) {
            frames = 'stack not captured';
            writeSync(2, '[watchdog] LOUD: stack not captured\n');
        } else {
            const out = [];
            let bad = false;
            for (const f of callFrames) {
                if (!f || !f.location || typeof f.location.lineNumber !== 'number' || typeof f.location.columnNumber !== 'number' || typeof f.functionName !== 'string' || typeof f.url !== 'string') {
                    bad = true;
                    break;
                }
                out.push({ functionName: f.functionName, url: f.url, lineNumber: f.location.lineNumber + 1, columnNumber: f.location.columnNumber });
            }
            if (bad || out.length === 0) {
                frames = 'stack not captured';
                writeSync(2, '[watchdog] LOUD: stack not captured\n');
            } else if (!dead) {
                frames = out;
                writeSync(2, `[watchdog] captured stack: ${frameText(out)}\n`);
            }
        }
    } catch (e) {
        if (!dead) {
            frames = 'stack not captured';
            const text = e && e.stack ? e.stack : String(e);
            writeSync(2, `[watchdog] LOUD: stack not captured: ${text}\n`);
        }
    }
    if (enabled) {
        try { await post('Debugger.resume'); }
        catch (e) {
            const text = e && e.stack ? e.stack : String(e);
            writeSync(2, `[watchdog] LOUD: Debugger.resume failed: ${text}\n`);
        }
        try { await post('Debugger.disable'); }
        catch (e) {
            const text = e && e.stack ? e.stack : String(e);
            writeSync(2, `[watchdog] LOUD: Debugger.disable failed: ${text}\n`);
        }
    }
}

const currentCall = () => {
    const n = Atomics.load(callLen, 0);
    if (n === 0) return { call: '(no bot API call in progress)', unread: 0 };
    const readable = Math.min(n, callBytes.length);
    return { call: new TextDecoder().decode(callBytes.slice(0, readable)), unread: n - readable };
};

function codeForFile(c) {
    if (c === null) return null;
    if (Object.hasOwn(c, 'endedAt')) return { label: c.label, endedAt: c.endedAt };
    return { label: c.label, source: c.source, at: c.at };
}

function kill(reason, silentMs, limit, kaAgeMs, killClock) {
    dead = true;
    if (frames === null) {
        frames = 'stack not captured';
        writeSync(2, '[watchdog] LOUD: stack not captured\n');
    }
    const shown = frames === 'stack not captured' ? 'stack not captured' : frameText(frames);
    const phaseStr = evidence.phases.length ? evidence.phases.join(' <- ') : '(no phase)';
    const call = currentCall();
    const recorded = codeForFile(code);
    const codeStr = recorded === null ? 'no staged code published'
        : Object.hasOwn(recorded, 'endedAt') ? `${recorded.label} (finished ${recorded.endedAt}; not running)`
        : `${recorded.label} (${recorded.source.length} chars, staged ${recorded.at}; source in ${evidencePath})`;
    const popped = Object.hasOwn(evidence, 'lastPopped') ? ` lastPopped="${evidence.lastPopped}" at ${evidence.at}` : '';
    writeSync(2, `[watchdog] MAIN THREAD BLOCKED: ${reason}; `
        + `phase_stack="${phaseStr}"${popped} skill="${evidence.skill}" stack="${evidence.stack}" bot_api_call="${call.call}"${call.unread ? ` (+${call.unread} bytes not held by the slot)` : ''} code="${codeStr}" inspector="${shown}" at ${new Date().toISOString()}; SIGKILL pid ${pid} so the supervisor restarts it\n`);
    try {
        const tmp = `${evidencePath}.tmp-${pid}`;
        writeFileSync(tmp, JSON.stringify({
            pid, at: new Date().toISOString(), silentMs, limitMs: limit, kaAgeMs, killClock,
            phases: evidence.phases, skill: evidence.skill, stack: evidence.stack,
            lastPopped: Object.hasOwn(evidence, 'lastPopped') ? evidence.lastPopped : null,
            lastPoppedAt: Object.hasOwn(evidence, 'at') ? evidence.at : null,
            call: call.call, callUnreadBytes: call.unread, code: recorded, callFrames: frames,
        }));
        renameSync(tmp, evidencePath);
    } finally {
        process.kill(pid, 'SIGKILL');
    }
    // fix79: one kill, then nothing. Park on a cell no one else can notify.
    const parked = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(parked, 0, 0);
    throw new Error(`[watchdog] worker woke after SIGKILL of pid ${pid}; nothing can notify its parked cell`);
}

function msOf(ns) {
    return Number(ns / NS);
}

async function loop() {
    while (Atomics.load(ctl, LIMIT) === 0) await Atomics.waitAsync(ctl, LIMIT, 0).value;
    let seen = Atomics.load(ctl, BEAT);
    let beatAt = process.hrtime.bigint();
    for (;;) {
        const limit = Atomics.load(ctl, LIMIT);
        const now = process.hrtime.bigint();
        const beat = Atomics.load(ctl, BEAT);
        if (beat !== seen) { seen = beat; beatAt = now; }
        const limitNs = BigInt(limit) * NS;
        const halfNs = limitNs / 2n;
        const ka = Atomics.load(kaNs, 0);
        const beatSilent = now - beatAt;
        const kaAge = ka === 0n ? null : now - ka;
        // Re-read the stamp immediately: a keep-alive processed while this thread was asleep moved the deadline.
        const captureDue = !captureStarted && ((ka !== 0n && now - ka >= halfNs) || beatSilent >= halfNs);
        if (captureDue) {
            const ka2 = Atomics.load(kaNs, 0);
            const now2 = process.hrtime.bigint();
            const still = (ka2 !== 0n && now2 - ka2 >= halfNs) || (now2 - beatAt >= halfNs);
            if (still) await captureStack();
            continue;
        }
        if (dead) return;
        const kaKill = kaAge !== null && kaAge >= limitNs;
        const beatKill = beatSilent >= limitNs;
        if (kaKill || beatKill) {
            const beatMs = msOf(beatSilent);
            const intervalMs = msOf(halfNs);
            const kaMs = kaAge === null ? null : msOf(kaAge);
            const reason = kaKill
                ? `last keep-alive ${kaMs}ms ago (limit ${limit}ms = vanilla keep-alive kick, ${intervalMs}ms × 2); heartbeat age ${beatMs}ms (evidence, not the kill clock)`
                : `no heartbeat for ${beatMs}ms (limit ${limit}ms = vanilla keep-alive kick, ${intervalMs}ms × 2)`;
            kill(reason, Math.round(beatMs), limit, kaMs === null ? null : Math.round(kaMs), kaKill ? 'keep-alive' : 'heartbeat');
            return;
        }
        let waitNs = limitNs;
        if (ka !== 0n && !captureStarted) {
            const until = ka + halfNs - now;
            if (until < waitNs) waitNs = until;
        }
        if (ka !== 0n) {
            const until = ka + limitNs - now;
            if (until < waitNs) waitNs = until;
        }
        if (!captureStarted) {
            const until = beatAt + halfNs - now;
            if (until < waitNs) waitNs = until;
        }
        const untilBeatKill = beatAt + limitNs - now;
        if (untilBeatKill < waitNs) waitNs = untilBeatKill;
        if (waitNs <= 0n) continue;
        const timeoutMs = Number((waitNs + NS - 1n) / NS);
        const cur = Atomics.load(ctl, BEAT);
        await Atomics.waitAsync(ctl, BEAT, cur, timeoutMs).value;
    }
}

loop();
