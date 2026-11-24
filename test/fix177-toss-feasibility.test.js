// fix177: a toss goal is bounded by the held count. dropping removes stacks the bot already has
// (minecraft.wiki/w/Dropping), so "Toss 50 cobblestone" with 43 held can never be verified.
// Live 23 Nov the curriculum proposed it anyway; 4 attempts each burned and every failure minted
// a fresh gate-rejected candidate skill (toss50CobblestoneTask, toss192Cobblestones,
// tossCobblestoneBatch64) — library pollution from an impossible goal. Voyager's curriculum
// proposes only acquirable tasks given the current state (Wang et al. 2023, arXiv:2305.16291 §3.1).
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import minecraftData from 'minecraft-data';
import { _setVersionForTest } from '../src/utils/mcdata.js';
import { Voyager } from '../src/agent/voyager.js';
_setVersionForTest('26.1');

const registry = minecraftData('26.1');
const ROOT = process.cwd();
const names = [];
const booted = [];
after(() => {
    for (const v of booted) if (v._saveTimer) clearTimeout(v._saveTimer);
    for (const name of names) rmSync(join(ROOT, 'bots', name), { recursive: true, force: true });
});

function boot(name, held) {
    const dir = join(ROOT, 'bots', name, 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'progress.json'), JSON.stringify({ completedAt: {}, completed: [], failed: [], blockers: [] }));
    // held: array of stack counts for cobblestone/stick laid out one stack per slot, 64-cap
    const slots = new Array(46).fill(null);
    let next = 9;
    for (const [item, n] of Object.entries(held || {})) {
        let left = n;
        while (left > 0) { slots[next++] = { name: item, count: Math.min(left, 64) }; left -= Math.min(left, 64); }
    }
    const v = new Voyager({
        name,
        fatal() {},
        bot: {
            version: '26.1', registry, chat() {}, on() {}, off() {}, once() {}, removeListener() {},
            inventory: { slots, inventoryStart: 9, inventoryEnd: 45, emptySlotCount: () => 35 },
        },
    });
    booted.push(v);
    names.push(name);
    return v;
}

describe('fix177: toss-count feasibility at task intake', () => {
    it('rejects a toss above the held count with both counts named', () => {
        const v = boot('fix177-over', { cobblestone: 43 });
        const why = v._rejectTask('Toss 50 cobblestone to free up inventory space', false);
        assert.match(why, /cannot toss 50 cobblestone: holding 43/);
    });
    it('resolves plural item tokens (Toss 192 Cobblestones)', () => {
        const v = boot('fix177-plural', { cobblestone: 43 });
        const why = v._rejectTask('Toss 192 Cobblestones', false);
        assert.match(why, /cannot toss 192 cobblestone: holding 43/);
    });
    it('sums held counts across stacks', () => {
        const v = boot('fix177-stacks', { cobblestone: 64 + 64 + 30 });
        assert.equal(v._rejectTask('Toss 150 cobblestone', false), null);
        assert.match(v._rejectTask('Toss 160 cobblestone', false), /holding 158/);
    });
    it('toss at or below held passes', () => {
        const v = boot('fix177-fit', { cobblestone: 43 });
        assert.equal(v._rejectTask('Toss 43 cobblestone', false), null);
    });
    it('other toss-class verbs and number words gate the same', () => {
        const v = boot('fix177-verbs', { stick: 3 });
        assert.match(v._rejectTask('Throw away ten sticks', false), /cannot toss 10 stick: holding 3/);
        assert.match(v._rejectTask('discard 60 stick', false), /cannot toss 60 stick: holding 3/);
    });
    it('zero held rejects too (nothing to toss)', () => {
        const v = boot('fix177-zero', {});
        assert.match(v._rejectTask('Toss 5 cobblestone', false), /cannot toss 5 cobblestone: holding 0/);
    });
    it('non-toss verbs are untouched', () => {
        const v = boot('fix177-other', { cobblestone: 1 });
        assert.equal(v._rejectTask('Collect 5 cobblestone', false), null);
    });
    it('unknown item names skip the check (name rules own them)', () => {
        const v = boot('fix177-unknown', { cobblestone: 1 });
        assert.equal(v._rejectTask('Toss 5 wiffle_ball', false), null);
    });
    it('no inventory skips the check', () => {
        const dir = join(ROOT, 'bots', 'fix177-nobot', 'skills');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'progress.json'), JSON.stringify({ completedAt: {}, completed: [], failed: [], blockers: [] }));
        const v = new Voyager({ name: 'fix177-nobot', fatal() {}, bot: { version: '26.1', registry, chat() {}, on() {}, off() {}, once() {}, removeListener() {} } });
        booted.push(v); names.push('fix177-nobot');
        assert.equal(v._rejectTask('Toss 50 cobblestone', false), null);
    });
});
