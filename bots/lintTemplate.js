import * as skills from '../../../src/agent/library/skills.js';
import * as world from '../../../src/agent/library/world.js';
import Vec3 from 'vec3';

// fix45: log binding moved to BARE API section to avoid triggering shadow warnings
// The prelude no longer shadows log - user code shadowing is still warned
const sleep = ms => new Promise(r => globalThis.setTimeout(r, ms));   // fix27: mirrors the sandbox endowment
const __mcLog__ = skills.log;  // fix44/45: collision-safe binding for interrupt guards (lint declaration; runtime is via endowment)
/* BARE API HERE */

export async function main(bot) {
    /* CODE HERE */
    log(bot, 'Code finished.');
}
