/**
 * fix131: fix127's habitat guidance never reaches the model. goToNearestEntity gates the
 * "goToMob to probe its habitat" hint on `bot.registry?.entitiesMap?.[entityType]`, but the
 * prismarine-registry has no `entitiesMap` — the name-keyed map is `entitiesByName` (verified:
 * Registry('1.20.4').entitiesMap === undefined while entitiesByName['sheep'] is the entity).
 * Live 16 Nov 2026 17:35 (after fix127 deployed): "no entity of type 'sheep' within 48 blocks …
 * DO NOT retry this same search" — the non-mob branch — so the model is told the opposite of
 * the truth for every mob and kills the hunt instead of searching habitat
 * (https://minecraft.wiki/w/Mob_spawning — mobs are not spread evenly).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import Registry from 'prismarine-registry';
import Vec3 from 'vec3';
import { goToNearestEntity } from '../src/agent/library/skills.js';

const registry = Registry('1.20.4');

function mkBot() {
    return Object.assign(new EventEmitter(), {
        registry,
        output: '',
        interrupt_code: false,
        entity: { position: new Vec3(0, 33, 0) },
        entities: {},
        players: {},
        setControlState() {},
        nearestEntity: () => null,
        async lookAt() {},
        pathfinder: { setMovements() {}, stop() {}, async goto() {}, setGoal() {} },
        async waitForTicks(n) { await new Promise((r) => setTimeout(r, n)); },
    });
}

describe('fix131 mob/not-mob branch of the no-entity hint', () => {
    it('a mob name gets the goToMob habitat guidance', async () => {
        const bot = mkBot();
        assert.strictEqual(await goToNearestEntity(bot, 'sheep', 48), false);
        assert.match(bot.output, /goToMob\(bot, 'sheep'\)/);
        assert.doesNotMatch(bot.output, /DO NOT retry/);
    });

    it('a non-mob name keeps the plain do-not-retry message', async () => {
        const bot = mkBot();
        assert.strictEqual(await goToNearestEntity(bot, 'minecart', 48), false);
        assert.match(bot.output, /DO NOT retry/);
        assert.doesNotMatch(bot.output, /goToMob/);
    });
});
