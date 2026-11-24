// fix178: players are not targets. The curriculum proposed "Kill 1 player" 11 times; the
// generated code attacked Mo's player entity and the server disconnected the attacker
// ("multiplayer.disconnect.invalid_entity_attacked"), crashing the agent process
// (mindcraft.log 23 Nov, pid 85138, launchd last exit code 1). Players are not mobs in
// minecraft-data 26.1 (entitiesByName.player: type 'player', category UNKNOWN), so the fix172
// mob-category gate cannot cover them; Mo's standing rule agrees: leave player S4ku24_Moonglich
// alone. Layers: intake gate (validateTask), attack choke point (attackEntity), curriculum prompt.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { validateTask } from '../src/agent/voyager.js';
import { attackEntity } from '../src/agent/library/skills.js';
import { _setVersionForTest } from '../src/utils/mcdata.js';
_setVersionForTest('26.1');

describe('fix178: players are off-limits', () => {
    it('a task naming a player is rejected at intake', () => {
        assert.match(validateTask('Kill 1 player'), /players are not targets/);
        assert.match(validateTask('Follow the Players to their village'), /players are not targets/);
    });
    it('a bare skill name containing player is rejected too (killPlayer)', () => {
        assert.match(validateTask('killPlayer'), /players are not targets/);
    });
    it('mob tasks are unaffected', () => {
        assert.equal(validateTask('Kill 1 zombie'), null);
        assert.equal(validateTask('Collect 5 salmon'), null);
    });
    it('attackEntity throws on a player entity before any swing', async () => {
        let swung = false;
        const bot = {
            entity: { position: { distanceTo: () => 2 } },
            attack() { swung = true; },
            pvp: { attack() { swung = true; }, stop() {} },
        };
        await assert.rejects(
            () => attackEntity(bot, { type: 'player', name: 'S4ku24_Moonglich', position: {} }),
            /\[fix178\] attackEntity: player "S4ku24_Moonglich" is off-limits/
        );
        assert.equal(swung, false);
    });
});
