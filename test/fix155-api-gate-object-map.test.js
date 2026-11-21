// fix155: the lint API gate hallucinated its own advice. bot.entities.filter(...) was rejected
// with "closest real members: bot.entities.12, bot.entities.34" (the map's entity-id DATA keys,
// presented as members — mineflayer docs api.md: bot.entities is a map of entityId to entity),
// and with an empty map nearestBotMember threw, the exception escaped
// userGeneratedCodeLintBlockers and the coder received no feedback at all.
// Now: array-vs-map confusion gets the correct form stated, data keys are never suggested,
// and the gate returns no suggestions instead of crashing.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as acorn from 'acorn';
import { nestedBotMemberError, nearestBotMember } from '../src/agent/coder.js';

function mkBot(entities) {
    // minimal live-bot stand-in: real object with members, plus the entities map (ids -> entities)
    return {
        entities,
        inventory: { items: () => [] },
        nearestEntity: () => null,
        blockAt: () => null,
        position: { x: 0, y: 0, z: 0 },
    };
}

function check(bot, code) {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
    const nodes = [];
    const walk = (n) => {
        if (!n || typeof n.type !== 'string') return;
        nodes.push(n);
        for (const [k, v] of Object.entries(n)) {
            if (k === 'loc' || k === 'start' || k === 'end') continue;
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v.type === 'string') walk(v);
        }
    };
    walk(ast);
    for (const n of nodes) {
        if (n.type !== 'MemberExpression') continue;
        const err = nestedBotMemberError(bot, n, new Set(), nodes);
        if (err) return err;
    }
    return null;
}

describe('fix155 API gate: object-map methods get corrective advice, never data-key garbage', () => {
    it('bot.entities.filter names the map-vs-array confusion and the correct form', () => {
        const bot = mkBot({ 12: { position: { x: 1, y: 2, z: 3 } }, 34: { position: { x: 4, y: 5, z: 6 } } });
        const err = check(bot, "const mobs = bot.entities.filter(e => e.type === 'mob');");
        assert.ok(err, 'gate must reject bot.entities.filter');
        assert.match(err, /is a plain object map \(id -> value\), not an array/);
        assert.match(err, /Object\.values\(bot\.entities\)\.filter\(\.\.\.\)/);
        assert.ok(!/bot\.entities\.\d+/.test(err.replace('Object.values(bot.entities).filter(...)', '')),
            `must not suggest data keys: ${err}`);
    });

    it('empty entities map still produces a message (gate must not throw)', () => {
        const bot = mkBot({});
        const err = check(bot, "const mobs = bot.entities.filter(e => e);");
        assert.ok(err, 'gate must still reject');
        assert.match(err, /plain object map/);
    });

    it('nearestBotMember filters non-identifier data keys and returns none instead of throwing', () => {
        assert.deepStrictEqual(nearestBotMember({ 12: {}, 34: {} }, 'filter', true), []);
        const withReal = nearestBotMember(mkBot({}), 'nearest', true);
        assert.ok(withReal.includes('nearestEntity'), `expected nearestEntity among ${withReal.join(',')}`);
    });

    it('missing member on an id-keyed map gets no parenthesised garbage suggestions', () => {
        const bot = mkBot({ 12: { position: { x: 1, y: 2, z: 3 } } });
        // "foo" is not an Array.prototype method, so this falls to the generic nearest-member path;
        // with data keys filtered out there are no candidates — the message must not end in "()" .
        const err = check(bot, "const v = bot.entities.foo('x');");
        assert.ok(err, 'gate must reject bot.entities.foo');
        assert.match(err, /bot\.entities\.foo does not exist/);
        assert.ok(!/\(closest real members: \)/.test(err), `no empty suggestion list: ${err}`);
    });

    it('correct usage passes: Object.values(bot.entities).filter and bot.nearestEntity', () => {
        const bot = mkBot({ 12: { position: { x: 1, y: 2, z: 3 } } });
        assert.strictEqual(check(bot, "const mobs = Object.values(bot.entities).filter(e => e.position);"), null);
        assert.strictEqual(check(bot, "const m = bot.nearestEntity(() => true);"), null);
    });
});
