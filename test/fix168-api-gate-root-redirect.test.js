// fix168: the hunger serve died 4/4 attempts on
// "bot.entity.health does not exist (closest real members: bot.entity.height,
// bot.entity.width, bot.entity.yaw)" — vitals (health/food/saturation) live on the
// bot, not on bot.entity (mineflayer docs api.md: bot.health, bot.food,
// bot.saturation), and the near-miss suggestion list could never contain the right
// path, so the coder repeated the same mistake every retry. The gate now redirects
// exactly: a missing member that exists on the root bot names that path instead of
// near neighbours.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as acorn from 'acorn';
import { nestedBotMemberError, Coder } from '../src/agent/coder.js';

function mkBot() {
    // stand-in shaped like the live bot: vitals are bot-level, entity has only
    // position/height/width/yaw (mineflayer docs api.md)
    return {
        health: 20,
        food: 20,
        saturation: 5,
        inventory: { items: () => [] },
        entity: { position: { x: 0, y: 0, z: 0 }, height: 1.8, width: 0.6, yaw: 0 },
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

describe('fix168: API gate redirects root-level names read off the wrong object', () => {
    it('bot.entity.health names bot.health, not near neighbours', () => {
        const err = check(mkBot(), 'const h = bot.entity.health;');
        assert.match(err, /bot\.entity\.health does not exist, but bot\.health does/);
        assert.match(err, /replace bot\.entity\.health with bot\.health/);
        assert.ok(!err.includes('closest real members'), 'redirect replaces the useless near-miss list');
    });
    it('bot.entity.food names bot.food', () => {
        const err = check(mkBot(), 'if (bot.entity.food < 18) { await bot.consume(HUNGRY_STANDING_FOOD); }');
        assert.match(err, /bot\.entity\.food does not exist, but bot\.food does/);
    });
    it('a real member path still passes', () => {
        assert.strictEqual(check(mkBot(), 'const h = bot.health; const p = bot.entity.position.x;'), null);
    });
    it('a name missing everywhere keeps the near-miss suggestion', () => {
        const err = check(mkBot(), 'const h = bot.entity.hearts;');
        assert.match(err, /bot\.entity\.hearts does not exist/);
        assert.ok(!/but bot\.hearts does/.test(err), 'no redirect when the root has no such member either');
    });
    it('bot.Vec3 names the sandbox global instead of near-miss bot members', () => {
        // live 22 Nov: "bot.Vec3 does not exist on the live bot (closest real members:
        // bot.game, bot.teams, bot.time)" — Vec3 is endowed as a bare global (coder.js sandbox).
        const coder = new Coder({ name: 'icefox2000', bot: { registry: { itemsByName: {}, blocksByName: {}, entitiesByName: {} } } });
        const fb = coder.userGeneratedCodeLintBlockers('const p = new bot.Vec3(1, 2, 3);', []);
        assert.match(fb, /bot\.Vec3 does not exist, but Vec3 is a sandbox global: use Vec3 directly/);
    });
});
