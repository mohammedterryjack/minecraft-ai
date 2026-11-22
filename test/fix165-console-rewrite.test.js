/**
 * fix165 — the SES sandbox exposes no `console`, only log(bot, ...). The model writes
 * console.warn/console.error as naturally as console.log; only console.log was rewritten,
 * so console.warn(...) threw "Cannot read properties of undefined (reading 'warn')"
 * (craft4OakPlanks, 22 Nov). _stageCode must map every console output method onto log(bot, ...).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

// the exact rewrite from coder.js _stageCode
function rewrite(code) {
    code = code.replace(/\bconsole\.(?:log|warn|error|info|debug)\s*\(\s*/g, 'log(bot, ');
    code = code.replaceAll('log("', 'log(bot,"');
    return code;
}

describe('fix165: console.* output methods all rewrite to log(bot, ...)', () => {
    it('rewrites warn/error/info/debug/log including spaced call parens', () => {
        for (const m of ['log', 'warn', 'error', 'info', 'debug']) {
            assert.ok(!rewrite(`console.${m}("hi");`).includes('console'), m);
            assert.ok(rewrite(`console.${m} ("hi");`).includes('log(bot,'), m + ' spaced');
        }
    });
    it('preserves the message arguments', () => {
        const out = rewrite('console.warn("no plank " + n, extra);');
        assert.match(out, /^log\(bot, "no plank " \+ n, extra\);$/);
    });
    it('handles zero-arg calls', () => {
        assert.ok(rewrite('console.error();').includes('log(bot, );'));
    });
    it('does not rewrite identifiers merely containing console (myconsole, my_console.x)', () => {
        assert.ok(rewrite('myconsole.warn("x");').includes('myconsole.warn'));
    });
    it('coder.js source carries the rewrite', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(import.meta.dirname, '..', 'src', 'agent', 'coder.js'), 'utf8');
        assert.match(src, /console\\\.\(\?:log\|warn\|error\|info\|debug\)\\s\*\\\(/);
    });
});
