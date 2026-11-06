import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Voyager } from '../src/agent/voyager.js';

// fix54: live 10:43 — _subgoalToObtainItem recursed forever on a learned consumes cycle (RangeError: Maximum call stack size exceeded)
describe('fix54: subgoal search on a consumes cycle', () => {
    it('returns the producer task instead of overflowing the stack', () => {
        const v = Object.create(Voyager.prototype);
        const a = { name: 'makeA', task: 'Craft 1 a_item', consumes: { b_item: 1 } };
        const b = { name: 'makeB', task: 'Craft 1 b_item', consumes: { a_item: 1 } };
        v._producers = it => (it === 'a_item' ? [a] : it === 'b_item' ? [b] : []);
        v._boltzmann = list => ({ s: list[0] });
        assert.strictEqual(v._subgoalToObtainItem('a_item', 1, {}, new Set()), 'Craft 1 b_item');
    });
});
