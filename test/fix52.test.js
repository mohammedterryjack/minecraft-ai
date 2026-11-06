import { describe, it } from 'node:test';
import assert from 'node:assert';
import settings from '../settings.js';
import { Voyager } from '../src/agent/voyager.js';

// fix52: live crash 10:07 — Voyager constructor -> _polyMerge -> _findReplay -> countGoal threw "VERSION is null" before spawn.
// This file never calls _setVersionForTest: VERSION must come from settings.minecraft_version at module load.
describe('fix52: registry version available before spawn', () => {
    it('_polyMerge parses count goals before the bot exists', () => {
        const v = Object.create(Voyager.prototype);
        v.skills = [
            { name: 'collectBlock', primitive: true, code: '' },
            { name: 'mineThreeIronOre', task: 'Mine 3 iron ore', code: 'async function mineThreeIronOre(bot) {}' },
        ];
        v._saveSkills = () => {};
        assert.doesNotThrow(() => v._polyMerge());
    });
    it('settings.minecraft_version is the module registry version', async () => {
        assert.strictEqual(typeof settings.minecraft_version, 'string');
        const src = (await import('fs')).readFileSync('./src/agent/voyager.js', 'utf8');
        assert.ok(src.includes('let VERSION = registryVersion(settings.minecraft_version);'));
        assert.ok(!src.includes("if (e.message?.includes('VERSION is null')) continue;"), 'no catch-and-continue on VERSION');
    });
});
