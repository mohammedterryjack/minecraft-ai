// fix68: runs a PSN trace harness prelude (argv[2]: a file holding the live 14:02:30Z prelude, or "current" for
// skill_graph.instrumentSrc) with getInventoryCounts traced, as the live replay of mineOneIronOre did. Prints TURN if the
// event loop gets a turn while the traced root runs; a blocked harness never prints it.
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { instrumentSrc } from '../../src/agent/skill_graph.js';
const harness = process.argv[2] === 'current' ? instrumentSrc([]) : readFileSync(process.argv[2], 'utf8');
const bot = { output: '', interrupt_code: false, __psnALS: new AsyncLocalStorage(), inventory: { slots: Array(46).fill(null), emptySlotCount: () => 30 }, quickBarSlot: 0,
    entity: { position: { x: 0, y: 64, z: 0, floored() { return { offset: () => ({}) }; } } }, blockAt: () => null, health: 20, food: 20, waitForTicks: async () => {} };
const getInventoryCounts = () => ({ raw_iron: 1 });
const __mcLog__ = () => {};
const __loopTurn__ = () => new Promise(r => setImmediate(r));
setImmediate(() => process.stdout.write('TURN\n'));
const main = new Function('bot', 'getInventoryCounts', '__mcLog__', '__loopTurn__',
    'return (async () => {\nlet mineOneIronOre = async (b) => { const c = getInventoryCounts(b); return c.raw_iron; };\n' + harness + '\nmineOneIronOre = __wrap("mineOneIronOre", mineOneIronOre); getInventoryCounts = __wrap("getInventoryCounts", getInventoryCounts);\nreturn await mineOneIronOre(bot);\n})();');
const r = await main(bot, getInventoryCounts, __mcLog__, __loopTurn__);
process.stdout.write(`DONE ${JSON.stringify(r)} trace=${bot.__psnTrace.map(x => x.name).join(',')}\n`);
process.exit(0);
