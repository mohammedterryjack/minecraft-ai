// Read-only stream overlay: MindServer socket + mindcraft.log tail. Sends no commands.
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const AGENT = process.env.AGENT || 'icefox2000';
const LOG = path.join(ROOT, 'logs/mindcraft.log');
const SKILLS = path.join(ROOT, `bots/${AGENT}/skills/index.json`);
const MS_URL = process.env.MINDSERVER || 'http://[::1]:8080';

const S = { state: null, connected: false, feed: [], task: null, milestone: null, milestonesReached: [],
  critic: null, skills: { count: null, recent: [] }, gate: [], success: 0, fail: 0, deaths: [],
  hut: null, safety: null, model: null, timing: null, updated: Date.now() };
const push = (arr, v, n) => { arr.push(v); while (arr.length > n) arr.shift(); };
const feed = (kind, text) => push(S.feed, { kind, text: String(text).slice(0, 220), t: Date.now() }, 8);

function parseLine(l) {
  let m;
  if ((m = l.match(/^\[voyager\] new task: (.*)/))) { S.task = m[1].slice(0, 160); feed('task', 'New task: ' + S.task);
    if ((m = l.match(/birch hut at x=(-?\d+), y=(-?\d+), z=(-?\d+)/))) S.hut = { x: +m[1], y: +m[2], z: +m[3] }; }
  else if ((m = l.match(/^\[voyager\] attempt (\d+) critic: success=(true|false)\s*(.*)/))) {
    S.critic = { attempt: +m[1], ok: m[2] === 'true', text: m[3].slice(0, 200), t: Date.now() };
    if (S.critic.ok) S.success++; feed('critic', (S.critic.ok ? '✔ critic: success' : '✘ critic: ') + (S.critic.ok ? '' : S.critic.text)); }
  else if ((m = l.match(/^\[voyager\] task failed after/))) { S.fail++; feed('fail', l.slice(10, 200)); }
  else if ((m = l.match(/^\[voyager\] safety first: food=(\d+) health=(\d+) night=(\w+) far=(\w+)/)))
    S.safety = { food: +m[1], health: +m[2], night: m[3] === 'true', far: m[4] === 'true', t: Date.now() };
  else if ((m = l.match(/^\[voyager\] (REPLAY skill .*|task interrupted|step failed.*)/))) feed('voyager', m[1]);
  else if ((m = l.match(/^\[psn\] milestone reached: (\S+)/))) { push(S.milestonesReached, m[1], 30); feed('psn', '★ milestone reached: ' + m[1]); }
  else if ((m = l.match(/^\[psn\] milestone (\S+): next (.*)/))) S.milestone = { name: m[1], next: m[2].replace(/\s*\(.*\)$/, '') };
  else if ((m = l.match(/^\[gate\] (\w+) (.*)/))) { push(S.gate, { op: m[1], text: m[2].slice(0, 120), t: Date.now() }, 5); feed('gate', `gate ${m[1]} ${m[2].split(/[ (]/)[m[1]==='MERGE'?1:0]}`); }
  else if ((m = l.match(/^\[chat-model\] used (\S+)/))) S.model = m[1];
  else if ((m = l.match(/^\[ollama-timing\] model=(\S+).*total_ms=(\d+)/))) { S.model = m[1]; S.timing = +m[2]; }
  else if ((m = l.match(/Last death: (.*?)(?:\. [A-Z]|$)/))) { const d = m[1].slice(0, 120); if (S.deaths.at(-1) !== d) push(S.deaths, d, 3); }
  else if (/^\[(house|toss|contract|skillv)\]/.test(l) && !/^\s/.test(l)) { if (/^\[(house|contract)\]/.test(l)) feed('info', l.slice(0, 160)); }
  else return;
  S.updated = Date.now();
}

// Tail with rotation/truncation handling
let pos = 0, ino = null, buf = '', quiet = true;
function readNew() {
  let st; try { st = fs.statSync(LOG); } catch { return; }
  if (ino !== null && st.ino !== ino) pos = 0;           // rotated
  if (st.size < pos) pos = 0;                             // truncated
  ino = st.ino; if (st.size === pos) return;
  const fd = fs.openSync(LOG, 'r'); const len = st.size - pos; const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos); fs.closeSync(fd); pos = st.size;
  buf += b.toString('utf8'); const lines = buf.split('\n'); buf = lines.pop();
  for (const l of lines) parseLine(l);
}
// backfill last ~2MB for context, then quietly reset feed timestamps
try { const st = fs.statSync(LOG); pos = Math.max(0, st.size - 2_000_000); ino = st.ino; readNew(); buf = ''; } catch {}

readNew();
try { fs.watch(path.dirname(LOG), () => readNew()); } catch {}
setInterval(readNew, 1000);

function loadSkills() {
  try { const j = JSON.parse(fs.readFileSync(SKILLS, 'utf8'));
    const names = j.map(s => s.name); const prev = S.skills.names;
    if (prev) for (const n of names) if (!prev.includes(n)) { push(S.skills.recent, n, 5); feed('skill', '📘 learned skill: ' + n); }
    if (!prev) S.skills.recent = names.slice(-3);
    S.skills.names = names; S.skills.count = names.length; } catch {}
}
loadSkills(); setInterval(loadSkills, 5000);

// MindServer (read-only listener, like its web UI)
const ms = ioc(MS_URL, { reconnection: true, transports: ['websocket', 'polling'] });
ms.on('connect', () => { S.connected = true; ms.emit('listen-to-agents'); console.log('mindserver connected'); });
ms.on('disconnect', () => { S.connected = false; });
ms.on('connect_error', e => { S.connected = false; });
ms.on('state-update', st => { if (st && st[AGENT]) { S.state = st[AGENT]; S.stateT = Date.now(); } });
ms.on('bot-output', (name, msg) => { if (name === AGENT) feed('chat', '💬 ' + msg); });

const app = express();
app.use(express.static(path.join(__dir, 'public')));
app.get('/state.json', (q, r) => r.json(S));
const http = createServer(app); const out = new Server(http);
setInterval(() => out.emit('s', S), 1000);
http.listen(3100, '127.0.0.1', () => console.log('overlay on http://127.0.0.1:3100'));
setInterval(() => console.log('sample', JSON.stringify({ c: S.connected, hp: S.state?.gameplay?.health, act: S.state?.action?.current, task: S.task, model: S.model, skills: S.skills.count })), 60000);
