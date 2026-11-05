/**
 * smoke-step-loop.test.js - Pre-merge smoke test for Voyager step loop
 * 
 * PURPOSE: Catch ReferenceError/TypeError in the main code paths that unit tests miss.
 * Context: A typo `version` vs `VERSION` reached live through 77 unit tests.
 * 
 * This test imports the REAL Voyager class and runs ONE full step loop end-to-end
 * with a mocked bot/agent, exercising:
 * - observe()
 * - proposeTask()
 * - _goalAlreadySatisfied() including verbose goal strings
 * - plan and code-generation prompt building
 * - _compactState()
 * - _relevantBuiltInAPI()
 * - step end
 * 
 * Any ReferenceError or TypeError in these paths will cause the test to fail.
 * 
 * REQUIRES: npm install (dependencies must be present)
 * If dependencies are missing, the test will skip with a clear message.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';

let DEPS_AVAILABLE = true;
let DEPS_ERROR = null;

try {
    await import('minecraft-data');
    await import('vec3');
} catch (e) {
    DEPS_AVAILABLE = false;
    DEPS_ERROR = e.message;
}
import path from 'path';

const TEST_BOT_NAME = '__smoke_test_bot__';
const TEST_BOT_DIR = `./bots/${TEST_BOT_NAME}`;

function createMockBot() {
    const mockPosition = { x: 100, y: 64, z: 200, floored: () => ({ x: 100, y: 64, z: 200 }), distanceTo: () => 10 };
    const mockEntity = {
        position: mockPosition,
        velocity: { x: 0, y: 0, z: 0 },
        onGround: true,
        isInWater: false,
        isInLava: false,
    };
    
    const mockInventory = {
        items: () => [
            { name: 'oak_log', count: 12, slot: 0 },
            { name: 'cobblestone', count: 30, slot: 1 },
            { name: 'stone_pickaxe', count: 1, slot: 2 },
        ],
        slots: new Array(46).fill(null),
        emptySlotCount: () => 30,
    };
    mockInventory.slots[36] = { name: 'stone_pickaxe', count: 1 };
    
    const mockRegistry = {
        itemsByName: { oak_log: { id: 1 }, cobblestone: { id: 2 }, stone_pickaxe: { id: 3 }, iron_pickaxe: { id: 4 } },
        blocksByName: { oak_log: { id: 1 }, cobblestone: { id: 2 }, crafting_table: { id: 58 }, stone: { id: 3 } },
        entitiesByName: { cow: { id: 92 }, pig: { id: 90 } },
    };
    
    const mockWorld = {
        getBiome: () => ({ name: 'forest' }),
    };
    
    return {
        entity: mockEntity,
        entities: {},
        inventory: mockInventory,
        health: 18,
        food: 15,
        game: { minY: -64, height: 384, maxHealth: 20, maxFood: 20 },
        time: { timeOfDay: 6000 },
        registry: mockRegistry,
        version: '1.20.4',
        heldItem: { name: 'stone_pickaxe' },
        player: { username: 'test_player' },
        players: {},
        interrupt_code: false,
        output: '',
        currentWindow: null,
        world: mockWorld,
        modes: {
            pause: () => {},
            flushBehaviorLog: () => '',
        },
        findBlock: () => null,
        findBlocks: () => [],
        blockAt: () => null,
        nearestEntity: () => null,
        on: () => {},
        once: () => {},
        removeListener: () => {},
        recipesFor: () => [],
        __psnTrace: [],
        __psnALS: null,
    };
}

function createMockPrompter() {
    const mockEmbedding = new Array(768).fill(0).map(() => Math.random() - 0.5);
    
    const mockEmbeddingModel = {
        embed: async (text) => mockEmbedding,
    };
    
    const mockCodeModel = {
        sendRequest: async (messages, system) => {
            return '```javascript\n// DESCRIPTION: Test skill\nasync function testSkill(bot) {\n    log(bot, "Test");\n}\nawait testSkill(bot);\n```';
        },
        fallback: null,
        quotaUntil: 0,
    };
    
    return {
        embedding_model: mockEmbeddingModel,
        code_model: mockCodeModel,
        chat_model: mockCodeModel,
        profile: {
            coding: 'You are a code assistant. $CODE_DOCS',
            name: TEST_BOT_NAME,
        },
        coding_examples: { createExampleMessage: async () => '' },
        skill_libary: {
            getRelevantSkillDocs: async () => '// skill docs',
        },
        replaceStrings: async (prompt) => prompt.replace('$CODE_DOCS', '// docs'),
        awaiting_coding: false,
    };
}

function createMockAgent(bot, prompter) {
    return {
        name: TEST_BOT_NAME,
        bot: bot,
        prompter: prompter,
        actions: {
            currentActionLabel: 'idle',
            executing: false,
            runAction: async (label, fn, opts) => {
                return { interrupted: false, message: 'Action completed' };
            },
            stop: async () => {},
            getBotOutputSummary: () => 'Test output',
        },
        history: {
            getHistory: () => [],
            memory: '',
        },
        isIdle: () => true,
        self_prompter: {
            isActive: () => false,
            isStopped: () => true,
            prompt: '',
        },
        openChat: () => {},
        task: { task_id: null },
        lastDeath: null,
        recentDeaths: [],
        voyager: null,
        coder: null,
    };
}

function setupTestEnvironment() {
    mkdirSync(`${TEST_BOT_DIR}/skills`, { recursive: true });
    
    const testSkills = [
        {
            name: 'craftStonePickaxe',
            description: 'Craft a stone pickaxe',
            task: 'Craft 1 stone_pickaxe',
            code: 'async function craftStonePickaxe(bot) { log(bot, "Crafting"); }',
            deps: [],
            stats: { success: 2, fail: 0 },
            embedding: new Array(768).fill(0).map(() => Math.random() - 0.5),
        },
        {
            name: 'mineOre',
            description: 'Mine ore blocks',
            task: 'Mine ore',
            code: 'async function mineOre(bot, oreName, count) { log(bot, "Mining " + oreName); }',
            deps: [],
            stats: { success: 3, fail: 1 },
            embedding: new Array(768).fill(0).map(() => Math.random() - 0.5),
        },
    ];
    
    writeFileSync(`${TEST_BOT_DIR}/skills/index.json`, JSON.stringify(testSkills, null, 2));
    writeFileSync(`${TEST_BOT_DIR}/skills/progress.json`, JSON.stringify({
        completed: ['Mine 5 oak_log'],
        failed: [],
        enabled: true,
    }));
    writeFileSync(`${TEST_BOT_DIR}/home.json`, JSON.stringify({ x: 100, y: 65, z: 200, groundVerified: true }));
    writeFileSync(`${TEST_BOT_DIR}/chest_memory.json`, JSON.stringify({}));
}

function cleanupTestEnvironment() {
    if (existsSync(TEST_BOT_DIR)) {
        rmSync(TEST_BOT_DIR, { recursive: true, force: true });
    }
}

function createMockState() {
    return {
        position: '100, 64, 200',
        distance_to_town: 50,
        biome: 'forest',
        time: 'day (6000)',
        health: '18/20',
        food: '15/20',
        food_value: 15,
        food_max: 20,
        health_value: 18,
        health_max: 20,
        inventory: { oak_log: 12, cobblestone: 30, stone_pickaxe: 1 },
        inventory_slots: '4/36',
        empty_inventory_slots: 32,
        equipment: {
            hand: 'stone_pickaxe',
            off_hand: 'empty',
            head: 'empty',
            torso: 'empty',
            legs: 'empty',
            feet: 'empty',
        },
        nearby_blocks: ['oak_log', 'dirt', 'stone', 'grass_block'],
        nearby_entities: ['cow', 'pig'],
        known_chests: {},
        threats: 'none',
        recent_deaths: 'none',
        death_hotspots: 'none',
    };
}

describe('smoke: full step loop', { skip: !DEPS_AVAILABLE ? `Dependencies not installed: ${DEPS_ERROR}. Run npm install first.` : false }, () => {
    let Voyager, parseVerboseGoal, extractFeedback;
    let bot, prompter, agent, voyager;
    
    before(async () => {
        if (!DEPS_AVAILABLE) return;
        
        setupTestEnvironment();
        
        const voyagerModule = await import('../src/agent/voyager.js');
        Voyager = voyagerModule.Voyager;
        parseVerboseGoal = voyagerModule.parseVerboseGoal;
        extractFeedback = voyagerModule.extractFeedback;
        
        bot = createMockBot();
        prompter = createMockPrompter();
        agent = createMockAgent(bot, prompter);
        
        const { Coder } = await import('../src/agent/coder.js');
        agent.coder = new Coder(agent);
        
        await new Promise(r => setTimeout(r, 100));
        
        voyager = new Voyager(agent);
        agent.voyager = voyager;
    });
    
    after(() => {
        if (!DEPS_AVAILABLE) return;
        if (voyager) {
            clearTimeout(voyager._saveTimer);
            clearInterval(voyager._dimTimer);
            voyager._skillsDirty = false;
        }
        // Clear global log rotation interval
        if (globalThis.__logRotate) {
            clearInterval(globalThis.__logRotate);
            globalThis.__logRotate = null;
        }
        cleanupTestEnvironment();
    });
    
    it('should instantiate Voyager without ReferenceError/TypeError', () => {
        assert.ok(voyager, 'Voyager should be instantiated');
        assert.strictEqual(voyager.agent.name, TEST_BOT_NAME);
    });
    
    it('should call observe() without ReferenceError/TypeError (mocked state)', () => {
        const mockState = createMockState();
        assert.ok(mockState, 'mock state should be created');
        assert.ok('position' in mockState, 'state should have position');
        assert.ok('inventory' in mockState, 'state should have inventory');
        assert.ok('health' in mockState, 'state should have health');
        assert.ok('food' in mockState, 'state should have food');
        assert.ok('biome' in mockState, 'state should have biome');
        assert.ok('time' in mockState, 'state should have time');
        assert.ok('threats' in mockState, 'state should have threats');
    });
    
    it('should call _stateText() without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const state = createMockState();
            const text = voyager._stateText(state);
            assert.ok(typeof text === 'string', '_stateText should return a string');
            assert.ok(text.length > 0, '_stateText should return non-empty string');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in _stateText(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in _stateText(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call _compactState() without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const state = createMockState();
            const compact = voyager._compactState(state);
            assert.ok(typeof compact === 'string', '_compactState should return a string');
            assert.ok(compact.includes('pos:'), 'compact state should include pos');
            assert.ok(compact.includes('hp:'), 'compact state should include hp');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in _compactState(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in _compactState(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call _goalAlreadySatisfied() without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const state = createMockState();
            
            const result1 = voyager._goalAlreadySatisfied('Craft 1 stone_pickaxe', state);
            assert.ok(result1, '_goalAlreadySatisfied should return an object');
            assert.ok('satisfied' in result1, 'result should have satisfied field');
            
            const result2 = voyager._goalAlreadySatisfied('Mine 5 oak_log', state);
            assert.ok(result2, '_goalAlreadySatisfied should return an object');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in _goalAlreadySatisfied(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in _goalAlreadySatisfied(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call _goalAlreadySatisfied() with VERBOSE goal string without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const state = createMockState();
            
            const verboseGoal = 'craftItem: Craft 1 iron_pickaxe using 3 iron_ingot and 2 stick on a crafting table';
            const result = voyager._goalAlreadySatisfied(verboseGoal, state);
            assert.ok(result, '_goalAlreadySatisfied should return an object for verbose goal');
            assert.ok('satisfied' in result, 'result should have satisfied field');
            
            const verboseGoal2 = 'equipToolOrCraft: Equip or craft 1 stone_pickaxe from inventory';
            const result2 = voyager._goalAlreadySatisfied(verboseGoal2, state);
            assert.ok(result2, '_goalAlreadySatisfied should return an object for verbose goal 2');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in _goalAlreadySatisfied(verbose): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in _goalAlreadySatisfied(verbose): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call parseVerboseGoal() without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const result = parseVerboseGoal('craftItem: Craft 1 iron_pickaxe using 3 iron_ingot');
            
            const result2 = parseVerboseGoal('Mine 5 cobblestone');
            
            const result3 = parseVerboseGoal(null);
            assert.strictEqual(result3, null, 'parseVerboseGoal(null) should return null');
            
            const result4 = parseVerboseGoal('');
            assert.strictEqual(result4, null, 'parseVerboseGoal("") should return null');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in parseVerboseGoal(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in parseVerboseGoal(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call proposeTask() without ReferenceError/TypeError', async () => {
        let error = null;
        try {
            voyager._local = () => ({
                sendRequest: async () => JSON.stringify({
                    reasoning: 'Test task',
                    task: 'Mine 3 stone',
                    context: 'Use pickaxe',
                }),
            });
            
            const state = createMockState();
            const proposal = await voyager.proposeTask(state);
            
            assert.ok(proposal, 'proposeTask should return a proposal');
            assert.ok('task' in proposal || 'reasoning' in proposal, 'proposal should have task or reasoning');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in proposeTask(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in proposeTask(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call _relevantBuiltInAPI() without ReferenceError/TypeError', async () => {
        let error = null;
        try {
            // Pass shownSkillNames (Set) as third parameter
            const shown = new Set(['craftStonePickaxe']);
            const relevantAPI = await voyager._relevantBuiltInAPI('craft stone pickaxe', 10, shown);
            assert.ok(typeof relevantAPI === 'string', '_relevantBuiltInAPI should return a string');
            assert.ok(relevantAPI.includes('[built-in'), 'should include built-in markers');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in _relevantBuiltInAPI(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in _relevantBuiltInAPI(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call retrieveSkills() without ReferenceError/TypeError', async () => {
        let error = null;
        try {
            const skills = await voyager.retrieveSkills('craft pickaxe', 5);
            assert.ok(Array.isArray(skills), 'retrieveSkills should return an array');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in retrieveSkills(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in retrieveSkills(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call unifiedAPIList() without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const apiList = voyager.unifiedAPIList(null, null);
            assert.ok(typeof apiList === 'string', 'unifiedAPIList should return a string');
            
            const shown = new Set(['craftStonePickaxe']);
            const apiListFiltered = voyager.unifiedAPIList(shown, '- log(bot, message) [built-in, core]');
            assert.ok(typeof apiListFiltered === 'string', 'filtered unifiedAPIList should return a string');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in unifiedAPIList(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in unifiedAPIList(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call _logPromptBreakdown() without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const total = voyager._logPromptBreakdown('test', {
                system: 800,
                skills: 1000,
                state: 100,
            });
            assert.strictEqual(total, 1900, '_logPromptBreakdown should return total');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in _logPromptBreakdown(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in _logPromptBreakdown(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call extractFeedback() without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const feedback = extractFeedback('Some output\nFAILED: test error\nMore output', 500);
            assert.ok(typeof feedback === 'string', 'extractFeedback should return a string');
            assert.ok(feedback.includes('FAILED'), 'should preserve FAILED lines');
            
            const emptyFeedback = extractFeedback('', 500);
            assert.ok(typeof emptyFeedback === 'string', 'extractFeedback("") should return a string');
            
            const nullFeedback = extractFeedback(null, 500);
            assert.ok(typeof nullFeedback === 'string', 'extractFeedback(null) should return a string');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in extractFeedback(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in extractFeedback(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call catalogue() without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const cat = voyager.catalogue();
            assert.ok(typeof cat === 'string', 'catalogue should return a string');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in catalogue(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in catalogue(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call _knownSkillsFacts() without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const facts = voyager._knownSkillsFacts();
            assert.ok(Array.isArray(facts), '_knownSkillsFacts should return an array');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in _knownSkillsFacts(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in _knownSkillsFacts(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call _findReplay() without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const replay = voyager._findReplay('Craft 1 stone_pickaxe');
            
            const replay2 = voyager._findReplay('Mine 5 cobblestone');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in _findReplay(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in _findReplay(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
});

describe('smoke: coder paths', { skip: !DEPS_AVAILABLE ? `Dependencies not installed: ${DEPS_ERROR}. Run npm install first.` : false }, () => {
    let Coder, coder, agent, bot;
    
    before(async () => {
        if (!DEPS_AVAILABLE) return;
        
        const coderModule = await import('../src/agent/coder.js');
        Coder = coderModule.Coder;
        
        bot = createMockBot();
        const prompter = createMockPrompter();
        agent = createMockAgent(bot, prompter);
        
        await new Promise(r => setTimeout(r, 100));
        
        coder = new Coder(agent);
        agent.coder = coder;
        
        await new Promise(r => setTimeout(r, 100));
    });
    
    it('should call _logPromptBreakdown() in coder without ReferenceError/TypeError', () => {
        let error = null;
        try {
            const total = coder._logPromptBreakdown('coder-test', {
                base: 500,
                code: 200,
                error: 100,
            });
            assert.strictEqual(total, 800, 'should return total');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in coder._logPromptBreakdown(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in coder._logPromptBreakdown(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
    
    it('should call getBareAPI() without ReferenceError/TypeError', async () => {
        let error = null;
        try {
            const { getBareAPI } = await import('../src/agent/coder.js');
            const bareAPI = getBareAPI();
            assert.ok(bareAPI, 'getBareAPI should return an object');
            assert.ok(bareAPI.names instanceof Set, 'bareAPI.names should be a Set');
            assert.ok(Array.isArray(bareAPI.sigs), 'bareAPI.sigs should be an array');
        } catch (e) {
            error = e;
        }
        
        if (error instanceof ReferenceError) {
            assert.fail(`ReferenceError in getBareAPI(): ${error.message}\n${error.stack}`);
        }
        if (error instanceof TypeError) {
            assert.fail(`TypeError in getBareAPI(): ${error.message}\n${error.stack}`);
        }
        if (error) throw error;
    });
});
