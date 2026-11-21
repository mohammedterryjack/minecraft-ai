/**
 * fix159: generated code kept hallucinating legacy mineflayer names that 4.39 does not have —
 * lint rejections "API gate: bot.position does not exist on the live bot" and
 * "bot.control does not exist" in one window on 21 Nov. The live gate is right (mineflayer
 * 4.39: position lives on bot.entity; goto is bot.pathfinder.goto, mineflayer-pathfinder
 * index.js:163; physical input state is bot.controlState, docs/api.md:1161) — but every
 * rejection burns a generation cycle, so API_SHAPE_NOTES must name the trap up front.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { API_SHAPE_NOTES } from '../src/agent/prompt_cut.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('fix159: API_SHAPE_NOTES names the legacy-name trap', () => {
    it('rejects bot.position/bot.goto/bot.control and gives the real members', () => {
        assert.match(API_SHAPE_NOTES, /bot\.position, bot\.goto and bot\.control do NOT exist/);
        assert.match(API_SHAPE_NOTES, /bot\.entity\.position \(Vec3\)/);
        assert.match(API_SHAPE_NOTES, /bot\.pathfinder\.goto\(goal\)/);
        assert.match(API_SHAPE_NOTES, /bot\.controlState/);
    });
    it('the library itself follows the rule (no bot.position anywhere in src/agent/library)', () => {
        const dir = join(here, '..', 'src', 'agent', 'library');
        for (const f of readdirSync(dir)) {
            if (!f.endsWith('.js') || f.includes('bak')) continue;
            const src = readFileSync(join(dir, f), 'utf8');
            assert.ok(!/\bbot\.position\b/.test(src), `${f} uses bot.position which does not exist on mineflayer 4.39`);
            assert.ok(!/\bbot\.goto\b/.test(src), `${f} uses bot.goto which does not exist on mineflayer 4.39`);
        }
    });
});
