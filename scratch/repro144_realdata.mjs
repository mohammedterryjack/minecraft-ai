// fix144 real-data check: run _migrateToBarenames in-memory against a COPY of the live
// skill index with saves stubbed to no-ops. Must complete without throwing.
import { readFileSync, mkdirSync } from 'node:fs';
import { Voyager } from '../src/agent/voyager.js';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const skills = Array.isArray(data) ? data : data.skills;
const v = Object.create(Voyager.prototype);
v.dir = `/tmp/f144-real-${Date.now()}`; mkdirSync(v.dir, { recursive: true });
v.progress = { migratedToBarenames: process.argv[3] === 'full' ? false : true };
v._saveProgress = () => {}; v._saveSkills = () => {};
v.skills = skills;
try {
    v._migrateToBarenames();
    console.log(`OK: migration clean on ${skills.length} live entries (no throw, no rewrite needed)`);
} catch (e) {
    console.log(`THREW: ${e.message.split('\n').slice(0, 6).join(' | ')}`);
    process.exitCode = 1;
}
