// fix144 repro: does a surviving self-call leftover throw?
import { Voyager } from '../src/agent/voyager.js';
import { mkdirSync } from 'node:fs';
const v = Object.create(Voyager.prototype);
v.dir = '/tmp/f144'; mkdirSync('/tmp/f144', { recursive: true }); v._saveProgress = () => {}; v._saveSkills = () => {};
v.progress = { migratedToBarenames: true };
v.skills = [{ name: 'killMob', code: 'async function killMob(bot, name, health) {\n    await skills.killMob(bot, name, health);\n    return true;\n}' }];
try { v._migrateToBarenames(); console.log('NO THROW; code now:', JSON.stringify(v.skills[0].code)); }
catch (e) { console.log('THREW:', e.message.split('\n')[0]); }
