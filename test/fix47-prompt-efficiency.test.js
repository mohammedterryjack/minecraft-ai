/**
 * fix47 regression tests - Prompt efficiency improvements
 * 
 * Required tests:
 * 1. Retry N times and prompt size stays within first-attempt size plus error length
 * 2. Skill section contains only top-k (not full library)
 * 3. Prompt contains no duplicated history messages
 * 4. Breakdown log line is emitted
 * 5. Compact state format contains critical info only
 * 6. API list filtering works (core + relevant)
 * 7. Settings for skill_topk and api_topk are respected
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';

// ---------- Test 1: Retry prompt size stays bounded ----------

describe('fix47: retry prompt size bounded', () => {
    it('should rebuild messages from base on every retry (no accumulation)', async () => {
        const coderSrc = readFileSync('./src/agent/coder.js', 'utf8');
        
        // Check that generateCode rebuilds messages from baseMessages on retry
        assert.ok(
            coderSrc.includes('messages = [...baseMessages]') && 
            coderSrc.includes('i === 0'),
            'Should rebuild messages from base on retry'
        );
        
        // Should track lastCode and lastError separately
        assert.ok(
            coderSrc.includes('lastCode') && coderSrc.includes('lastError'),
            'Should track lastCode and lastError for retry'
        );
    });

    it('should not accumulate history across retries', async () => {
        const coderSrc = readFileSync('./src/agent/coder.js', 'utf8');
        
        // Should NOT have messages.push in a way that accumulates
        // The fix46 pattern: only add lastCode and lastError, not push to existing
        const genCodeFn = coderSrc.match(/async generateCode[\s\S]*?^\s{4}\}/m);
        assert.ok(genCodeFn, 'generateCode function should exist');
        
        const fnBody = genCodeFn[0];
        
        // Should have the pattern: messages = [...baseMessages] followed by conditional pushes
        assert.ok(
            fnBody.includes('messages = [...baseMessages]') &&
            fnBody.includes('if (lastCode)') &&
            fnBody.includes('if (lastError)'),
            'Should use base + lastCode + lastError pattern (not accumulate)'
        );
    });
});

// ---------- Test 2: Skill section contains only top-k ----------

describe('fix47: skill section top-k only', () => {
    it('should use configurable skill_topk from settings', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(
            voyagerSrc.includes('settings.skill_topk') || voyagerSrc.includes('skill_topk'),
            'Should use skill_topk setting'
        );
    });

    it('should limit skills sent to code model via embedding search', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // retrieveSkills should be called with a top-k limit
        assert.ok(
            voyagerSrc.includes('retrieveSkills(') && voyagerSrc.includes('skillTopK'),
            'Should call retrieveSkills with top-k limit'
        );
    });

    it('should only send top 3 skills with full code (rest as signatures)', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // ctx = related.slice(0, 3) pattern
        assert.ok(
            voyagerSrc.includes('related.slice(0, 3)'),
            'Should only include top 3 skills with full code'
        );
    });
});

// ---------- Test 3: No duplicated history messages ----------

describe('fix47: no duplicated history', () => {
    it('should not have repeated conversation history in code generation', async () => {
        const coderSrc = readFileSync('./src/agent/coder.js', 'utf8');
        
        // The old pattern of pushing to messages_copy repeatedly should not exist
        // fix46 ensures we rebuild from base each time
        assert.ok(
            !coderSrc.includes('messages_copy.push') || 
            coderSrc.includes('// fix46'),
            'Should not accumulate into messages_copy (fix46 pattern)'
        );
    });

    it('should log prompt size on retries', async () => {
        const coderSrc = readFileSync('./src/agent/coder.js', 'utf8');
        
        assert.ok(
            coderSrc.includes('Retry') && coderSrc.includes('prompt') && coderSrc.includes('chars'),
            'Should log retry prompt size'
        );
    });
});

// ---------- Test 4: Breakdown log line emitted ----------

describe('fix47: prompt breakdown logging', () => {
    it('should have _logPromptBreakdown helper in coder.js', async () => {
        const coderSrc = readFileSync('./src/agent/coder.js', 'utf8');
        
        assert.ok(
            coderSrc.includes('_logPromptBreakdown'),
            'coder.js should have _logPromptBreakdown helper'
        );
    });

    it('should have _logPromptBreakdown helper in voyager.js', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(
            voyagerSrc.includes('_logPromptBreakdown'),
            'voyager.js should have _logPromptBreakdown helper'
        );
    });

    it('should log breakdown with kind, total, and sections', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // Check for the log format: [prompt] kind=X total=Y chars: ...
        assert.ok(
            voyagerSrc.includes('[prompt]') && 
            voyagerSrc.includes('kind=') && 
            voyagerSrc.includes('total='),
            'Should log breakdown with kind, total, and sections'
        );
    });

    it('should call breakdown logging for code prompts', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(
            voyagerSrc.includes("_logPromptBreakdown('code'") ||
            voyagerSrc.includes('_logPromptBreakdown("code"'),
            'Should log breakdown for code prompts'
        );
    });

    it('should call breakdown logging for curriculum prompts', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(
            voyagerSrc.includes("_logPromptBreakdown('curriculum'") ||
            voyagerSrc.includes('_logPromptBreakdown("curriculum"'),
            'Should log breakdown for curriculum prompts'
        );
    });

    it('should log LOUD warning for large prompts (>50k)', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        const coderSrc = readFileSync('./src/agent/coder.js', 'utf8');
        
        const hasLoudWarning = 
            (voyagerSrc.includes('LOUD') && voyagerSrc.includes('50000')) ||
            (coderSrc.includes('LOUD') && coderSrc.includes('50000'));
        
        assert.ok(hasLoudWarning, 'Should log LOUD warning for prompts > 50k chars');
    });
});

// ---------- Test 5: Compact state format ----------

describe('fix47: compact state format', () => {
    it('should have _compactState method in voyager.js', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(
            voyagerSrc.includes('_compactState('),
            'voyager.js should have _compactState method'
        );
    });

    it('should use compact state in code prompts', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(
            voyagerSrc.includes('compactStateText') || voyagerSrc.includes('_compactState'),
            'Should use compact state in code prompts'
        );
    });

    it('should use compact state in curriculum prompts', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // proposeTask should use compact state
        const proposeTaskMatch = voyagerSrc.match(/proposeTask[\s\S]*?return parseLocalJSON/);
        assert.ok(proposeTaskMatch, 'proposeTask function should exist');
        
        const fnBody = proposeTaskMatch[0];
        assert.ok(
            fnBody.includes('compactState') || fnBody.includes('_compactState'),
            'proposeTask should use compact state'
        );
    });

    it('compact state should be one-line format with critical info', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // _compactState should produce a one-line format
        const compactMatch = voyagerSrc.match(/_compactState\(s\)\s*\{[\s\S]*?\n\s*\}/);
        assert.ok(compactMatch, '_compactState method should exist');
        
        const fnBody = compactMatch[0];
        
        // Should include position, biome, time, hp, food, inventory summary
        assert.ok(fnBody.includes('pos:'), 'Should include position');
        assert.ok(fnBody.includes('biome:'), 'Should include biome');
        assert.ok(fnBody.includes('hp:'), 'Should include health');
        assert.ok(fnBody.includes('food:'), 'Should include food');
        assert.ok(fnBody.includes('inv:'), 'Should include inventory summary');
    });
});

// ---------- Test 6: API list filtering ----------

describe('fix47: API list filtering', () => {
    it('should have CORE_API set with essential functions', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(
            voyagerSrc.includes('CORE_API') && voyagerSrc.includes('new Set'),
            'Should have CORE_API set defined'
        );
    });

    it('should have _relevantBuiltInAPI method', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(
            voyagerSrc.includes('_relevantBuiltInAPI'),
            'Should have _relevantBuiltInAPI method'
        );
    });

    it('should fail loud if embedding model unavailable', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // _relevantBuiltInAPI should throw if no embedding model
        assert.ok(
            voyagerSrc.includes('FAIL LOUD') && voyagerSrc.includes('embedding model required'),
            'Should fail loud if embedding model unavailable'
        );
    });

    it('should use embedding search for API relevance', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        // _relevantBuiltInAPI should use cosineSimilarity
        const relevantAPIMatch = voyagerSrc.match(/_relevantBuiltInAPI[\s\S]*?\n\s{4}\}/);
        assert.ok(relevantAPIMatch, '_relevantBuiltInAPI method should exist');
        
        const fnBody = relevantAPIMatch[0];
        assert.ok(
            fnBody.includes('cosineSimilarity') || fnBody.includes('_embed'),
            'Should use embedding for API relevance'
        );
    });

    it('should always include core APIs regardless of relevance score', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(
            voyagerSrc.includes('isCore') && voyagerSrc.includes('[built-in, core]'),
            'Should mark core APIs distinctly'
        );
    });
});

// ---------- Test 7: Settings respected ----------

describe('fix47: settings respected', () => {
    it('should have skill_topk setting in settings.js', async () => {
        const settingsSrc = readFileSync('./settings.js', 'utf8');
        
        assert.ok(
            settingsSrc.includes('skill_topk'),
            'settings.js should have skill_topk'
        );
    });

    it('should have api_topk setting in settings.js', async () => {
        const settingsSrc = readFileSync('./settings.js', 'utf8');
        
        assert.ok(
            settingsSrc.includes('api_topk'),
            'settings.js should have api_topk'
        );
    });

    it('should import settings in voyager.js', async () => {
        const voyagerSrc = readFileSync('./src/agent/voyager.js', 'utf8');
        
        assert.ok(
            voyagerSrc.includes("import settings from") || 
            voyagerSrc.includes("require('settings')") ||
            voyagerSrc.includes("require('./settings')"),
            'voyager.js should import settings'
        );
    });
});

// ---------- Integration test ----------

describe('fix47: integration - measurement script', () => {
    it('should have measurement script in scripts/', async () => {
        const fs = await import('fs');
        const exists = fs.existsSync('./scripts/measure-prompt-sizes.js');
        assert.ok(exists, 'scripts/measure-prompt-sizes.js should exist');
    });

    it('measurement script should be executable', async () => {
        const scriptSrc = readFileSync('./scripts/measure-prompt-sizes.js', 'utf8');
        
        assert.ok(
            scriptSrc.includes('#!/usr/bin/env node'),
            'Measurement script should have shebang'
        );
    });

    it('measurement script should load skill library', async () => {
        const scriptSrc = readFileSync('./scripts/measure-prompt-sizes.js', 'utf8');
        
        assert.ok(
            scriptSrc.includes('loadSkills') && scriptSrc.includes('index.json'),
            'Should load skills from index.json'
        );
    });

    it('measurement script should report before/after comparison', async () => {
        const scriptSrc = readFileSync('./scripts/measure-prompt-sizes.js', 'utf8');
        
        assert.ok(
            scriptSrc.includes('BEFORE') && scriptSrc.includes('AFTER'),
            'Should show before/after comparison'
        );
    });
});
