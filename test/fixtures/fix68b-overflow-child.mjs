// fix68b: staged-bundle async stack overflow under the PSN harness, in a child process.
// node --test enables async_hooks; on Node 20.19 that makes ANY async stack overflow fatal (CVE-2025-59466),
// which would kill the runner even after the harness stopped using ALS.run around user code. Production icefox
// does not enable those hooks, so the child is the faithful (and safe) place to assert the overflow rejects.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Vec3 } from 'vec3';
import { Coder } from '../../src/agent/coder.js';
import { instrumentSrc } from '../../src/agent/skill_graph.js';

const coder = new Coder({ name: '__fix68b_overflow_child__' });
while (!coder.code_lint_template || !coder.code_template) await new Promise(r => setImmediate(r));
const code = 'async function deep(bot, n) {\n    return await deep(bot, n + 1);\n}\nasync function outer(bot) {\n    const r = await deep(bot, 0);\n    bot.reached = true;\n    return r;\n}\n'
    + instrumentSrc(['outer', 'deep']) + '\nawait outer(bot);';
const staged = await coder._stageCode(code, { lintOnly: false });
const bot = {
    output: '', interrupt_code: false, __psnALS: new AsyncLocalStorage(),
    inventory: { slots: Array(46).fill(null), emptySlotCount: () => 36 },
    waitForTicks: async () => {},
    entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null,
    health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, quickBarSlot: 0,
};
try {
    await staged.func.main(bot);
    process.stdout.write('RETURNED\n');
    process.exit(2);
} catch (e) {
    const failed = bot.output.split('\n').filter(l => l.startsWith('FAILED:'));
    process.stdout.write(JSON.stringify({
        name: e && e.constructor && e.constructor.name,
        message: e && e.message,
        reached: bot.reached,
        failed,
        outerFail: !!(bot.__psnTrace || []).find(r => r.name === 'outer' && r.fail),
    }) + '\n');
    process.exit(0);
}
