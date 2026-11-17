import test from 'node:test';
import assert from 'node:assert/strict';
import { missingReturnFeedback } from '../src/agent/skill_graph.js';

// fix138: callers of learned skills check the returned value (the seeded primitives return true/false: tossItem,
// depositToChest). A generated skill whose function has no `return <value>` is invisible to those checks: the live
// tossCobblestoneBatch stub tossed cobblestone, returned undefined, and every generated caller failed it with
// "returned false or undefined" forever — its own effect contract held, so the blame machinery never repaired it.

test('void function gets return-contract feedback', () => {
    const fb = missingReturnFeedback('tossCobblestoneBatch', 'async function tossCobblestoneBatch(bot, amount) {\n  await tossItem(bot, "cobblestone", amount);\n}');
    assert.equal(typeof fb, 'string');
    assert.match(fb, /return/);
    assert.match(fb, /tossCobblestoneBatch/);
});

test('bare return only is still feedback', () => {
    const fb = missingReturnFeedback('f', 'async function f(bot) {\n  if (bot.x) return;\n  await doIt(bot);\n}');
    assert.equal(typeof fb, 'string');
});

test('return only inside a nested callback is feedback', () => {
    const fb = missingReturnFeedback('f', 'async function f(bot) {\n  const xs = arr.map(x => x + 1);\n  await useIt(bot, xs);\n}');
    assert.equal(typeof fb, 'string');
    const fb2 = missingReturnFeedback('f', 'async function f(bot) {\n  const xs = arr.filter(function (x) { return x > 0; });\n  await useIt(bot, xs);\n}');
    assert.equal(typeof fb2, 'string');
});

test('function with return true passes', () => {
    assert.equal(missingReturnFeedback('f', 'async function f(bot) {\n  await tossItem(bot, "cobblestone", 10);\n  return true;\n}'), null);
});

test('conditional returns pass (return false on failure paths, true on success)', () => {
    assert.equal(missingReturnFeedback('f', 'async function f(bot) {\n  if (!bot.ready) return false;\n  await work(bot);\n  return true;\n}'), null);
});

test('return of an expression passes', () => {
    assert.equal(missingReturnFeedback('f', 'async function f(bot) {\n  return await work(bot);\n}'), null);
});

test('missingReturnFeedback validates arguments', () => {
    assert.throws(() => missingReturnFeedback('', 'x'), /own function name required/);
    assert.throws(() => missingReturnFeedback('f', ''), /source required/);
});
