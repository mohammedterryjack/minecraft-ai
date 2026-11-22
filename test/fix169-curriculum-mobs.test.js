// fix169: the curriculum proposed Hoglin locate/attack tasks with no Hoglin anywhere in range —
// the perceive snapshot carries nearby_entities but _compactState dropped it, so the proposal
// model never saw which mobs exist nearby (live 22 Nov: "Locate the nearest Hoglin..." failed
// 4/4, critic: "Hoglins only spawn in the Nether"; approach/attack husk tasks stall the same way).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Voyager } from '../src/agent/voyager.js';

const state = () => ({
    position: '0, 64, 0', biome: 'plains', time: 'day 1000',
    health_value: 20, health_max: 20, food_value: 20, food_max: 20,
    inventory_slots: '36', empty_inventory_slots: 30,
    equipment: { hand: 'empty' }, inventory: { dirt: 3 }, threats: 'none',
    nearby_entities: ['pig', 'cow'],
});

describe('fix169: curriculum state names the mobs actually present', () => {
    const v = Object.create(Voyager.prototype);
    it('_compactState includes the nearby mobs fact', () => {
        const line = v._compactState(state());
        assert.match(line, /mobs:pig,cow/);
    });
    it('empty or missing mob list reads as none, never omitted', () => {
        assert.match(v._compactState({ ...state(), nearby_entities: [] }), /mobs:none/);
        assert.match(v._compactState({ ...state(), nearby_entities: undefined }), /mobs:none/);
    });
    it('the curriculum contract ties mob tasks to the mobs fact', () => {
        const src = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.match(src, /propose mob tasks only for mobs in the list/);
    });
    it('the stall sentinel reports blocks over two seconds with the last line', () => {
        const src = readFileSync('./src/agent/voyager.js', 'utf8');
        assert.match(src, /\[loop-stall\] event loop blocked/);
        assert.match(src, /__stallSentinel/);
    });
});
