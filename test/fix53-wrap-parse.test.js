import test from 'node:test';
import assert from 'node:assert';
import * as acorn from 'acorn';
import { instrumentSrc } from '../src/agent/skill_graph.js';

test('fix53: instrumentSrc output parses (no raw newline inside string literal)', () => {
    const src = instrumentSrc(['collectBlock', 'craftRecipe']);
    assert.doesNotThrow(() => acorn.parse(`(async function(bot){${src}\n})`, { ecmaVersion: 'latest' }));
    assert.ok(src.includes("'\\nFAILED: '"));
});
