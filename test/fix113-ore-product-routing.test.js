/**
 * fix113: "Mine 10 raw_iron" routes to nothing (live: 2026-11-15, backchain step mineOre abandoned).
 * The backchain finds mineOre as the producer of raw_iron (learned effects) and _planStepCall rebuilds the
 * call from the step's task text through _structuredReplay; that router only accepted items ending in _ore
 * (or stone/cobblestone/deepslate), so a PRODUCT item (raw_iron, coal, diamond) routed nowhere. mineOre
 * takes the ore BLOCK name (it forwards to mineBlocks), so the router maps the product through
 * minecraft-data: item X -> block `${X}_ore` when blocksByName has it.
 * Also: _checkNullDeref must not flag truthy short-circuit guards (`existing && existing.name`, `existing ? existing.name : ...`).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

let Voyager, setVersion;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    setVersion = mod._setVersionForTest;
    setVersion('1.20.4');
});

function mk(skills) {
    const v = Object.create(Voyager.prototype);
    v.skills = skills.map(s => JSON.parse(JSON.stringify(s)));
    v.progress = { completedAt: {}, completed: [], failed: [], goalStats: {}, fix25: true, refactors: {} };
    v.npGraph = { consumesOf: () => ({}), getProducersOf: () => [], getRequirementsOf: () => [], recordDelta: () => {} };
    v._saveProgress = () => {};
    v._saveSkills = () => {};
    v._maturity = () => ({ V: 0.5 });
    return v;
}

const mineOre = {
    name: 'mineOre', task: 'Mine count of an ore or stone (coal_ore, iron_ore, diamond_ore, stone, deepslate variants...), first equipping or crafting a pickaxe good enough for it; returns items gained.',
    deps: [], effects: ['raw_iron', 'coal'], consumes: {},
    code: 'async function mineOre(bot, oreName, count = 1) { return true; }', stats: { success: 3, fail: 0, tasks: [] },
};

describe('fix113 mine routing: product items reach mineOre with the ore block', () => {
    it('"Mine 10 raw_iron" routes to mineOre(bot, "iron_ore", 10)', () => {
        const v = mk([mineOre]);
        const r = v._structuredReplay('Mine 10 raw_iron');
        assert.ok(r, '"Mine 10 raw_iron" must route');
        assert.strictEqual(r.name, 'mineOre');
        // iron_ore's blockLoot drops raw_iron; the plain ore sorts before deepslate_iron_ore.
        assert.strictEqual(r.call, 'await mineOre(bot, "iron_ore", 10);');
    });
    it('"Mine 5 coal" routes to the coal_ore block', () => {
        const v = mk([mineOre]);
        const r = v._structuredReplay('Mine 5 coal');
        assert.ok(r && r.name === 'mineOre', 'coal is a product of coal_ore');
        assert.strictEqual(r.call, 'await mineOre(bot, "coal_ore", 5);');
    });
    it('an ore block name still routes unchanged', () => {
        const v = mk([mineOre]);
        const r = v._structuredReplay('Mine 3 iron_ore');
        assert.strictEqual(r.name, 'mineOre');
        assert.strictEqual(r.call, 'await mineOre(bot, "iron_ore", 3);');
    });
    it('a non-ore block does not route to mineOre (dirt has no dirt_ore)', () => {
        const v = mk([mineOre]);
        const r = v._structuredReplay('Mine 4 dirt');
        assert.ok(!r || r.name !== 'mineOre', `dirt must not reach mineOre; got ${r && r.call}`);
    });
    it('a log goal still routes past mineOre to collectLogs', () => {
        const logs = { name: 'collectLogs', task: 'Collect N logs', deps: [], effects: ['birch_log'], consumes: {},
            code: 'async function collectLogs(bot, count, blockType) { return true; }', stats: { success: 1, fail: 0, tasks: [] } };
        const v = mk([mineOre, logs]);
        const r = v._structuredReplay('Collect 5 birch_log');
        assert.strictEqual(r.name, 'collectLogs');
    });
    it('_planStepCall backchains mineOre for a raw_iron step (the live regression)', () => {
        const v = mk([mineOre]);
        const call = v._planStepCall({ name: 'mineOre', item: 'raw_iron', need: 10 });
        assert.strictEqual(call, 'await mineOre(bot, "iron_ore", 10);');
    });
});

describe('fix113 _checkNullDeref: truthy guards are guards', () => {
    let coder;
    before(async () => {
        const { Coder } = await import('../src/agent/coder.js');
        coder = Object.create(Coder.prototype);
    });
    it('does not flag a same-line && short-circuit', () => {
        const code = [
            'async function f(bot) {',
            'const existing = getNearestBlock(bot, "chest", 16);',
            'if (existing && existing.name === "chest") return true;',
            '}',
        ].join('\n');
        const warns = coder._checkNullDeref(code, 0);
        assert.strictEqual(warns.length, 0, `guarded && access flagged: ${JSON.stringify(warns)}`);
    });
    it('does not flag a ternary guard', () => {
        const code = [
            'async function f(bot) {',
            'const existing = bot.blockAt(pos);',
            'const n = existing ? existing.name : "air";',
            '}',
        ].join('\n');
        const warns = coder._checkNullDeref(code, 0);
        assert.strictEqual(warns.length, 0, `ternary-guarded access flagged: ${JSON.stringify(warns)}`);
    });
    it('still flags the unguarded access', () => {
        const code = [
            'async function f(bot) {',
            'const existing = getNearestBlock(bot, "chest", 16);',
            'return existing.name;',
            '}',
        ].join('\n');
        const warns = coder._checkNullDeref(code, 0);
        assert.strictEqual(warns.length, 1);
    });
});
