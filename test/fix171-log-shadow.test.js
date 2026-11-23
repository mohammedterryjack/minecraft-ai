// fix171: generated code like `const log = (msg) => log(bot, ...)` shadows the log helper and
// resolves to itself — guaranteed Maximum call stack size exceeded at runtime (31 occurrences in
// the live log on 22 Nov, each burning a full task attempt). The shadow check must now REJECT
// self-referential shadows (blocking error, coder retries) while plain shadows stay warnings.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Coder } from '../src/agent/coder.js';

const coder = new Coder({ name: 'fix171', bot: { registry: { itemsByName: {}, blocksByName: {}, entitiesByName: {} } } });

describe('fix171: self-recursive log shadow is a blocking lint error', () => {
    it('rejects an arrow shadow that calls log inside its own initializer', async () => {
        const out = await coder._lintCode('export async function main(bot) {\n    const log = (msg) => log(bot, `[x] ${msg}`);\n    log("hi");\n}\n', 0);
        assert.match(out, /ERROR: a local named `log` references `log` inside its own definition/);
        assert.match(out, /rejected before execution/);
    });
    it('rejects a function shadow that recurses through the helper name', async () => {
        const out = await coder._lintCode('export async function main(bot) {\n    function log(bot2, m) { return log(bot2, m); }\n}\n', 0);
        assert.match(out, /ERROR: a local named `log` references `log`/);
    });
    it('a non-self shadow is not blocked (warnings go to console, return stays clean)', async () => {
        const out = String(await coder._lintCode('export async function main(bot) {\n    const log = bot.food;\n    return log;\n}\n', 0) ?? '');
        assert.doesNotMatch(out, /ERROR/);
        assert.doesNotMatch(out, /rejected before execution/);
    });
    it('member uses of .log (skills.log, console.log) inside a shadow are not self-reference', async () => {
        const out = String(await coder._lintCode('export async function main(bot) {\n    const log = (m) => console.log(m);\n    log("x");\n}\n', 0) ?? '');
        assert.doesNotMatch(out, /rejected before execution/);
    });
});
