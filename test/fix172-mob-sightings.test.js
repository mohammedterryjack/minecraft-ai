// fix172: mob sighting evidence at task intake. Voyager's curriculum proposes only what the agent
// can experience (Wang et al. 2023, arXiv:2305.16291 §3.1). fix141 made "approach <mob>" a FINDING
// goal (no game-data location), but with zero sighting memory the proposals burned 9 full tasks
// hunting hoglins in the overworld (live 22 Nov, critic: "hoglins do not spawn here"). A task
// naming a mob is proposable once the mob has been observed anywhere; sightings persist across
// restarts in bots/<name>/mob_sightings.json, fed by observe().
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

function boot(name) {
    const dir = join(ROOT, 'bots', name, 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'progress.json'), JSON.stringify({ completedAt: {}, completed: [], failed: [], blockers: [] }));
    const v = new Voyager({
        name,
        fatal() {},
        bot: { version: '26.1', chat() {}, on() {}, off() {}, once() {}, removeListener() {}, inventory: { emptySlotCount: () => 36 }, registry },
    });
    booted.push(v);
    names.push(name);
    return v;
}

describe('fix172: mob sighting gate', () => {
    it('a task naming a never-sighted mob is rejected with the sighting list', () => {
        const v = boot('fix172-unsighted');
        const why = v._rejectTask('Navigate to the nearest hoglin while avoiding high-death hotspots', false);
        assert.match(why, /hoglin has never been sighted/);
        assert.match(why, /sighted mobs: no mob sighted yet/);
    });
    it('plurals resolve to the mob name (Kill 3 zombies)', () => {
        const v = boot('fix172-plural');
        const why = v._rejectTask('Kill 3 zombies for rotten_flesh', false);
        assert.match(why, /zombie has never been sighted/);
    });
    it('a sighted mob passes the gate', () => {
        const v = boot('fix172-sighted');
        v._recordSightings(['hoglin']);
        assert.equal(v._rejectTask('Navigate to the nearest hoglin', false), null);
    });
    it('state.nearby_entities bypasses an empty store', () => {
        const v = boot('fix172-state');
        assert.equal(v._rejectTask('Navigate to the nearest hoglin', true, { nearby_entities: ['hoglin'] }), null);
    });
    it('mob words inside item names (porkchop, blaze_powder) are not mob mentions', () => {
        const v = boot('fix172-compound');
        assert.equal(v._rejectTask('Smelt 3 porkchop', false), null);
        assert.equal(v._rejectTask('Craft a blaze_rod from blaze_powder', false), null);
        assert.equal(v._rejectTask('Craft an ender_pearl from an ender_eye', false), null);
    });
    it('sightings persist across restarts and re-observing does not rewrite the file', () => {
        const v = boot('fix172-persist');
        v._recordSightings(['pig', 'cow']);
        assert.ok(existsSync(v.mobSightingsFile));
        const mtime = statSync(v.mobSightingsFile).mtimeMs;
        v._recordSightings(['pig', 'cow']);
        assert.equal(statSync(v.mobSightingsFile).mtimeMs, mtime, 'no rewrite without new names');
        assert.deepEqual(JSON.parse(readFileSync(v.mobSightingsFile, 'utf8')).sighted, ['cow', 'pig']);
        const v2 = boot('fix172-persist');
        assert.ok(v2.mobSightings.has('pig') && v2.mobSightings.has('cow'));
    });
    it('a non-array entity list is a LOUD contract violation', () => {
        const v = boot('fix172-loud');
        assert.throws(() => v._recordSightings(undefined), /\[fix172\] entities array required/);
    });
    it('mob-free tasks are untouched by the gate', () => {
        const v = boot('fix172-other');
        assert.equal(v._rejectTask('Craft 4 oak_planks', false), null);
    });
});
