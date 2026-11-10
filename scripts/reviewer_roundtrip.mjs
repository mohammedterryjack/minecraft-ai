import { groupVaryingLines, recoverTemplatedLines } from '../src/agent/skill_graph.js';
const cases = {
    distinct: 'collect(oak_log) error: no path\ncollect(oak_log) error: creeper\ncollect(oak_log) error: inventory full',
    rets: 'mine() -> 0\nmine() -> 3\nmine() -> 0',
    gains: 'oak_log +0\ncobblestone +4\noak_log +0\noak_log +4\ncobblestone +0',
    prefix: 'Done with errors: creeper exploded\nstep 1 ok\nstep 2 ok\nDone with errors: creeper exploded',
    rawCount: 'stood at the chest (x2)\nnext line',
};
let bad = 0;
for (const [k, t] of Object.entries(cases)) {
    const g = groupVaryingLines(t);
    const r = recoverTemplatedLines(g).join('\n');
    console.log('==', k, r === t ? 'ROUNDTRIP OK' : 'MISMATCH');
    console.log(g);
    if (r !== t) bad++;
}
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const tpl = ['dig {} at {} {}', 'Error: blocked by {}', 'got {} oak_log', 'Done with errors: creeper exploded', 'free {}'];
for (let i = 0; i < 3000; i++) {
    const n = 1 + Math.floor(rnd() * 30);
    const L = [];
    for (let j = 0; j < n; j++) {
        let s = tpl[Math.floor(rnd() * tpl.length)];
        while (s.includes('{}')) s = s.replace('{}', String(Math.floor(rnd() * 5) - (rnd() < .2 ? 2 : 0) + (rnd() < .1 ? 0.5 : 0)));
        L.push(s);
    }
    const t = L.join('\n');
    try {
        const r = recoverTemplatedLines(groupVaryingLines(t)).join('\n');
        if (r !== t) {
            bad++;
            if (bad < 4) console.log('FUZZ MISMATCH\n' + t + '\n--\n' + groupVaryingLines(t));
        }
    } catch (e) {
        bad++;
        if (bad < 4) console.log('FUZZ THROW', e.message, '\n' + t);
    }
}
console.log('bad', bad);
if (bad !== 0) process.exit(1);
