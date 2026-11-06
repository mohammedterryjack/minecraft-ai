// fix79: writeCode _apiGate rejects generated writes of the two runtime-owned keys
// (bot.__unmetPrecondition from fix76, bot.__prereqFail from fix51). Only those two —
// other bot.__* / bot.* assignments still pass (Server: block only the named keys).
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, readFileSync } from 'node:fs';
import { Coder, getBareAPI } from '../src/agent/coder.js';

const NAME = '__fix79_gate_keys__';
after(() => rmSync(`./bots/${NAME}`, { recursive: true, force: true }));

const stubBot = () => ({
    registry: { itemsByName: { oak_planks: { name: 'oak_planks' }, crafting_table: { name: 'crafting_table' } }, blocksByName: { crafting_table: { name: 'crafting_table' } }, entitiesByName: {} },
});

describe('fix79: _apiGate rejects writing the two runtime-owned bot keys', () => {
    it('rejects bot.__unmetPrecondition = ...', () => {
        const coder = new Coder({ name: NAME, bot: stubBot() });
        const r = coder.userGeneratedCodeLintBlockers(
            `async function eatSomething(bot) {\n    bot.__unmetPrecondition = { kind: 'precondition' };\n    return false;\n}\nawait eatSomething(bot);`,
            [],
        );
        assert.ok(r, 'gate should reject');
        assert.match(r, /__unmetPrecondition/);
        assert.match(r, /forbidden|runtime-owned/i);
    });
    it('rejects bot.__prereqFail = ...', () => {
        const coder = new Coder({ name: NAME, bot: stubBot() });
        const r = coder.userGeneratedCodeLintBlockers(
            `async function ensureCraftingTable(bot) {\n    bot.__prereqFail = { item: 'oak_planks', need: 4, have: 0 };\n    return false;\n}\nawait ensureCraftingTable(bot);`,
            [...getBareAPI().names],
        );
        assert.ok(r, 'gate should reject');
        assert.match(r, /__prereqFail/);
        assert.match(r, /forbidden|runtime-owned/i);
    });
    it('does not reject other bot.__* writes (only the two named keys)', () => {
        const coder = new Coder({ name: NAME, bot: stubBot() });
        const r = coder.userGeneratedCodeLintBlockers(
            `async function ensureCraftingTable(bot) {\n    bot.__triedCells = [];\n    bot.__triedCells.push('a');\n    return true;\n}\nawait ensureCraftingTable(bot);`,
            [...getBareAPI().names],
        );
        assert.strictEqual(r, null, `other bot.__* write should pass, got: ${r}`);
    });
    it('an ensureCraftingTable repair that writes other bot properties (not the two keys) still passes', () => {
        // Mirrors a repair of the seeded ensureCraftingTable that keeps place/craft flow but
        // records tried cells on the bot — must not be rejected just because it assigns bot.*.
        const coder = new Coder({ name: NAME, bot: stubBot() });
        const code = `async function ensureCraftingTable(bot) {
    bot.__triedCells = [];
    const spaces = getAllFreeSpaces(bot, 1, 6, 5);
    for (const pos of spaces) {
        bot.__triedCells.push(pos);
        const ok = await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
        if (ok) return true;
    }
    return false;
}
await ensureCraftingTable(bot);`;
        const r = coder.userGeneratedCodeLintBlockers(code, [...getBareAPI().names]);
        assert.strictEqual(r, null, `repair writing other bot props should pass, got: ${r}`);
    });
    it('source only names the two keys (no blanket bot.__* ban)', () => {
        const src = readFileSync(new URL('../src/agent/coder.js', import.meta.url), 'utf8');
        const i = src.indexOf('runtimeOwnedBotWrites');
        assert.ok(i > 0);
        const gate = src.slice(i, i + 600);
        assert.match(gate, /new Set\(\['__unmetPrecondition', '__prereqFail'\]\)/);
        assert.doesNotMatch(gate, /startsWith\(|\/\^__/);
    });

});
