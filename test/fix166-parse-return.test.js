/**
 * fix166 — collectBareApiUsedInSource must parse with allowReturnOutsideFunction like the
 * pipeline's other parser (coder.js:896). Generated code is injected into execTemplate.js,
 * `(async (bot) => { /* CODE HERE *\/ ... })`, so a top-level `return` in generated code is
 * legal; the check threw "'return' outside of function" and aborted the whole voyager step (22 Nov).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectBareApiUsedInSource } from '../src/agent/coder.js';

describe('fix166: top-level return parses in collectBareApiUsedInSource', () => {
    it('accepts a bare top-level return (legal inside execTemplate arrow wrapper)', () => {
        const r = collectBareApiUsedInSource('const a = 1;\nreturn;\n');
        assert.ok(r);
    });
    it('still collects bare API references around a top-level return', () => {
        const r = collectBareApiUsedInSource('const c = getInventoryCounts;\nreturn c;\n');
        assert.ok(r.skillNames.has('getInventoryCounts') || r.worldNames.has('getInventoryCounts'));
    });
    it('still throws on genuinely invalid syntax', () => {
        assert.throws(() => collectBareApiUsedInSource('const = ;(('), /parse failed/);
    });
});
