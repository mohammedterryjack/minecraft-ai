/**
 * fix98: rest need and threat interrupt. Hunger and threat share the Thompson slot.
 * minecraft:time_since_rest's id comes from the vanilla custom_stat report. A version
 * mismatch, a missing entry, or a statistics packet without that id fails only rest.
 * A bed the game data accepts is obtained by the recipe chain, not a free-text sleep task.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { VitalsModel } from '../src/agent/vitals_model.js';
import { CONTEXT_FULL } from '../src/models/ollama.js';
import {
    RestThreat, emptyRestStore, readRestStatistic, resolveRestStatIds, loadCustomStatReport,
    clientCommandSpec, installProtocolFacts, restFacts, bedItemNames, findBedBlock, damageTypesFromData,
    markRestUnavailable, REST_STATISTIC,
} from '../src/agent/rest_threat.js';
import minecraftData from 'minecraft-data';
import { _setVersionForTest as loadMcData } from '../src/utils/mcdata.js';

const require = createRequire(import.meta.url);
const VER = '1.20.4';
const registry = require('prismarine-registry')(VER);

let Voyager;
before(async () => {
    const mod = await import('../src/agent/voyager.js');
    Voyager = mod.Voyager;
    mod._setVersionForTest(VER);
    loadMcData(VER);
});

function liveRegen() {
    return new VitalsModel({
        regen: {
            18: { n: 14, up: 4 }, 19: { n: 10, up: 3 }, 20: { n: 14, up: 9 },
        },
        runs: {},
        foodSamples: { drop: { n: 0, sum: 0 }, rise: { n: 0, sum: 0 } },
    });
}

function mkV() {
    const v = Object.create(Voyager.prototype);
    v.vitals = liveRegen();
    v.skills = [];
    v.progress = {
        subgoals: [], decomposed: {}, failed: [], completedAt: {}, completed: [], blockers: [],
        recipeEdges: {}, goalStats: {}, goalFailStates: [], deathSpots: {},
    };
    Object.defineProperty(v, '_decomposeQueue', { get() { return null; }, configurable: true });
    v._urgentRng = () => 0.5;
    v.restThreat = new RestThreat(emptyRestStore());
    v.agent = {
        name: 'icefox2000',
        bot: { health: 20, food: 10, game: { maxHealth: 20, maxFood: 20, gameMode: 'survival' }, interrupt_code: false, entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 } },
        requestInterrupt(source) { v.agent.bot.interrupt_code = true; v.interrupted = source; },
        recentDeaths: [],
    };
    v._saveProgress = () => {};
    v._curSub = null;
    v.currentTask = null;
    v.observe = () => ({
        inventory: {}, nearby_blocks: [], position: '0, 64, 0',
        time: 'night (18000, hostiles spawn outdoors)',
        is_day: false, sleeping: false, sky_light: 0, time_since_rest: 3,
        health_value: 20, health_max: 20, food_value: 10, food_max: 20,
        inventory_slots: '0/36', empty_inventory_slots: 36, threats: 'none',
        equipment: { hand: 'empty' },
    });
    return v;
}

function wireServe(v) {
    v.served = [];
    v.proposeTask = async () => ({ task: 'Eat cooked beef', reasoning: 'food is low' });
    v._acceptPlannerTask = async (proposal) => ({ task: proposal.task, proposal });
    v._pursueProposedTask = async () => { v.served.push(v.currentTask); return true; };
    v._afterSuccess = () => {};
    v._replay = async () => ({ ok: true });
    v._goalBackoffMultiplier = () => 1;
}

async function assertHungerAndThreatStillServe(v) {
    v.restThreat.installed = true;
    v.agent.bot.food = 10;
    v.agent.bot.health = 20;
    v.restThreat.noteSourcedHurt('from-the-event', 1, v.agent.bot.restSince);
    const both = v._urgentCandidates(v._hungerServeState());
    assert.ok(both.find(c => c.id === 'hunger'), 'hunger still a candidate');
    assert.ok(both.find(c => c.id === 'threat'), 'threat still a candidate');
    assert.strictEqual(both.find(c => c.id === 'rest'), undefined);
    wireServe(v);
    assert.strictEqual(await v._serveUrgent(), true);
    assert.strictEqual(v.served[0], 'need:hunger');
    v.currentTask = null;
    v.agent.bot.food = 20;
    v.agent.bot.health = 20;
    v.restThreat.s.pending = null;
    v.restThreat.s.hurts = {};
    v.restThreat.noteSourcedHurt('from-the-event', 1000, v.agent.bot.restSince);
    const threatSide = v._urgentCandidates(v._hungerServeState());
    assert.strictEqual(threatSide.find(c => c.id === 'hunger'), undefined);
    assert.ok(threatSide.find(c => c.id === 'threat'));
    assert.strictEqual(threatSide.find(c => c.id === 'rest'), undefined);
    assert.strictEqual(await v._serveUrgent(), true);
    assert.strictEqual(v.served[1], 'need:threat');
}

describe('fix98: hunger and threat share one slot', () => {
    it('the higher HP value wins, either way', () => {
        const v = mkV();
        v.restThreat.installed = true;
        v.agent.bot.restSince = 5;
        const hungerWins = v._urgentCandidates(v._hungerServeState());
        const hunger = hungerWins.find(c => c.id === 'hunger');
        assert.ok(hunger, 'hunger is a candidate when food is below the learned floor');
        v.restThreat.noteSourcedHurt('from-the-event', 1, 5);
        const low = v._urgentCandidates(v._hungerServeState());
        assert.strictEqual(low.find(c => c.id === 'threat') ? 'threat-present' : 'absent', 'threat-present');
        assert.ok(low.find(c => c.id === 'hunger').value > low.find(c => c.id === 'threat').value);
        v.restThreat.s.pending = null;
        v.restThreat.s.hurts = {};
        v.restThreat.s.harmFloor = null;
        v.agent.bot.restSince = 1;
        v.restThreat.noteSourcedHurt('from-the-event', 1000, 5);
        const high = v._urgentCandidates(v._hungerServeState());
        const winner = high.reduce((a, b) => b.value > a.value ? b : a);
        assert.strictEqual(winner.id, 'threat');
        assert.ok(high.find(c => c.id === 'threat').value > high.find(c => c.id === 'hunger').value);
    });
});

describe('fix98: the first sourced hurt raises rest', () => {
    it('one hurt correlated with time_since_rest raises rest to that damage', () => {
        const v = mkV();
        v.restThreat.installed = true;
        v.agent.bot.food = 20;
        v.agent.bot.health = 20;
        v.agent.bot.restSince = 40;
        v.agent.bot.oxygenLevel = 300;
        v.agent.bot.__fix98Hurt = { seq: 0, events: [] };
        v.agent.bot.__fix98Damage = { seq: 0, events: [] };
        assert.strictEqual(v.restThreat.restCandidate(v.agent.bot, 1, 0.01), null);
        v.restThreat.lastHp = 20;
        v.restThreat.seenSeq = 0;
        v.agent.bot.__fix98Hurt = { seq: 1, events: [{ seq: 1, name: 'from-the-event' }] };
        v.restThreat.onSample(v.agent.bot, 16);
        v.agent.bot.health = 16;
        const rest = v.restThreat.restCandidate(v.agent.bot, 1, 0.01);
        assert.ok(rest);
        assert.strictEqual(rest.value, 4);
        assert.match(rest.by, /first sourced hurt/);
        assert.strictEqual(v.restThreat.s.harmFloor, 40);
        const candidates = v._urgentCandidates(v._hungerServeState());
        assert.strictEqual(candidates.some(c => c.id === 'hunger'), false);
        const winner = candidates.reduce((a, b) => b.value > a.value ? b : a);
        assert.strictEqual(winner.id, 'rest');
    });
});

describe('fix98: a threat interrupt is not blamed', () => {
    it('records kind threat and does not touch the skill or the goal backoff', () => {
        const v = mkV();
        v.skills = [{ name: 'mineOre', stats: { success: 2, fail: 0 }, demoted: false }];
        v._diedInRun = () => null;
        v._stalledInRun = () => null;
        v._surfaceY = () => null;
        const before = JSON.stringify(v.progress.goalStats);
        const fails = v.skills[0].stats.fail;
        const reason = v._interruptReason({ message: 'ok', interruptedBy: { kind: 'threat', by: 'entityHurt from from-the-event; learned damage 4' } });
        assert.match(reason, /threat/);
        assert.strictEqual(v._lastCutKind, 'threat');
        assert.strictEqual(JSON.stringify(v.progress.goalStats), before);
        assert.strictEqual(v.skills[0].stats.fail, fails);
    });

    it('a running step is cut when the learned damage exceeds the task stake', () => {
        const v = mkV();
        v.running = true;
        v.currentTask = 'Mine 1 stone';
        v.restThreat.installed = true;
        v.agent.bot.health = 14;
        v.agent.bot.restSince = 9;
        v.agent.bot.__fix98Hurt = { seq: 1, events: [{ seq: 1, name: 'from-the-event' }] };
        v.restThreat.lastHp = 20;
        v.restThreat.seenSeq = 0;
        v._threatDuringStep(14);
        assert.strictEqual(v.interrupted.kind, 'threat');
        assert.match(v.interrupted.by, /from-the-event/);
    });
});

describe('fix98: statistics packet', () => {
    it('resolves minecraft:time_since_rest from the vanilla custom_stat report', () => {
        const report = loadCustomStatReport();
        assert.strictEqual(report.minecraftVersion, VER);
        assert.strictEqual(report.jarSha1, '8dd1a28015f51b1803213892b50b7b4fc76e594d');
        assert.match(report.generatedBy, /net\.minecraft\.data\.Main/);
        const ids = resolveRestStatIds(report, VER);
        const stat = report.registries['minecraft:custom_stat'].entries[REST_STATISTIC].protocol_id;
        const category = report.registries['minecraft:stat_type'].entries['minecraft:custom'].protocol_id;
        assert.deepStrictEqual(ids, { categoryId: category, statisticId: stat });
        const model = new RestThreat(emptyRestStore());
        assert.strictEqual(Object.hasOwn(model, 'ticks'), false);
        assert.strictEqual(model.s.harmFloor, null);
        assert.strictEqual(readRestStatistic({ entries: [{ categoryId: ids.categoryId, statisticId: ids.statisticId, value: 11 }] }, ids), 11);
        assert.throws(
            () => readRestStatistic({ entries: [{ categoryId: ids.categoryId, statisticId: ids.statisticId + 1, value: 11 }] }, ids),
            new RegExp(REST_STATISTIC),
        );
    });

    it('the request_stats action and the statistics packet name come from the protocol schema', () => {
        const spec = clientCommandSpec(minecraftData(VER));
        assert.strictEqual(spec.write, 'client_command');
        assert.strictEqual(spec.field, 'actionId');
        assert.strictEqual(spec.reply, 'statistics');
        const mappings = minecraftData(VER).protocol.play.toServer.types.packet_client_command[1][0].type[1].mappings;
        assert.strictEqual(mappings[String(spec.action)], 'request_stats');
    });

    it('a statistics listener stores the value from the report id', () => {
        const ids = resolveRestStatIds(loadCustomStatReport(), VER);
        const packets = [];
        const handlers = {};
        const bot = {
            version: VER,
            entity: {},
            on() {},
            _client: {
                write(name, body) { packets.push({ name, body }); },
                on(name, fn) { handlers[name] = fn; },
            },
        };
        const model = new RestThreat(emptyRestStore());
        installProtocolFacts(bot, minecraftData(VER), model);
        assert.strictEqual(packets.length, 1);
        assert.strictEqual(packets[0].name, 'client_command');
        handlers.statistics({ entries: [{ categoryId: ids.categoryId, statisticId: ids.statisticId, value: 42 }] });
        assert.strictEqual(bot.restSince, 42);
        assert.strictEqual(model.restUnavailable, null);
    });

    it('a missing or unmapped time_since_rest fails only the rest need, loudly, and the bot keeps running', async () => {
        const v = mkV();
        v.agent.bot.version = VER;
        const handlers = {};
        v.agent.bot.on = () => {};
        v.agent.bot._client = { write() {}, on(name, fn) { handlers[name] = fn; } };
        assert.doesNotThrow(() => installProtocolFacts(v.agent.bot, minecraftData(VER), v.restThreat));
        const ids = resolveRestStatIds(loadCustomStatReport(), VER);
        const logs = [];
        const orig = console.error;
        console.error = (...args) => { logs.push(args.join(' ')); };
        try {
            assert.doesNotThrow(() => handlers.statistics({ entries: [] }));
            assert.doesNotThrow(() => handlers.statistics({
                entries: [{ categoryId: ids.categoryId, statisticId: ids.statisticId + 1, value: 9 }],
            }));
        } finally {
            console.error = orig;
        }
        const logged = logs.join('\n');
        assert.match(logged, /rest unavailable/);
        assert.match(logged, /did not include/);
        assert.match(v.restThreat.restUnavailable, new RegExp(REST_STATISTIC));
        assert.strictEqual(v.restThreat.restCandidate(v.agent.bot, 1, 1), null);
        assert.strictEqual(typeof v.agent.bot.restSince, 'undefined');
        await assertHungerAndThreatStillServe(v);
        assert.match(v.restThreat.restUnavailable, new RegExp(REST_STATISTIC));
    });

    it('a version mismatch fails only rest', async () => {
        const report = loadCustomStatReport();
        const wrong = { ...report, minecraftVersion: '26.3' };
        assert.throws(() => resolveRestStatIds(wrong, VER), /does not match bot\.version/);
        const v = mkV();
        v.agent.bot.version = VER;
        v.agent.bot.restSince = 40;
        v.restThreat.installed = true;
        let reason;
        try {
            resolveRestStatIds(wrong, v.agent.bot.version);
        } catch (err) {
            reason = err.message;
            markRestUnavailable(v.restThreat, v.agent.bot, reason);
        }
        assert.match(reason, /26\.3/);
        assert.strictEqual(v.restThreat.restCandidate(v.agent.bot, 1, 1), null);
        await assertHungerAndThreatStillServe(v);
    });

    it('a missing custom_stat entry fails only rest', async () => {
        const report = loadCustomStatReport();
        const missing = structuredClone(report);
        delete missing.registries['minecraft:custom_stat'].entries[REST_STATISTIC];
        assert.throws(() => resolveRestStatIds(missing, VER), new RegExp(REST_STATISTIC));
        const v = mkV();
        v.agent.bot.version = VER;
        v.agent.bot.restSince = 40;
        v.restThreat.installed = true;
        try {
            resolveRestStatIds(missing, v.agent.bot.version);
            assert.fail('missing entry should throw');
        } catch (err) {
            markRestUnavailable(v.restThreat, v.agent.bot, err.message);
        }
        assert.match(v.restThreat.restUnavailable, new RegExp(REST_STATISTIC));
        assert.strictEqual(v.restThreat.restCandidate(v.agent.bot, 1, 1), null);
        await assertHungerAndThreatStillServe(v);
    });

    it('starvation at food 0 with no entityHurt is non-entity damage and is recorded', () => {
        const model = new RestThreat(emptyRestStore());
        model.installed = true;
        model.lastHp = 20;
        const types = damageTypesFromData(minecraftData(VER));
        const starve = Object.values(types).find(t => t.name.endsWith('starve'));
        assert.ok(starve, 'damage-type registry names starvation');
        const bot = {
            food: 0,
            oxygenLevel: 300,
            restSince: 9,
            entity: { id: 7 },
            __fix98Hurt: { seq: 0, events: [] },
            __fix98Damage: { seq: 0, events: [] },
            __fix98DamageTypes: types,
            hurtBy: 'must-not-stick',
        };
        assert.doesNotThrow(() => model.onSample(bot, 19));
        assert.strictEqual(model.s.nonEntity.n, 1);
        assert.strictEqual(model.s.nonEntity.sum, 1);
        assert.strictEqual(model.s.nonEntity.last.entity, false);
        assert.strictEqual(model.s.nonEntity.last.food, 0);
        assert.strictEqual(model.s.nonEntity.last.oxygen, 300);
        assert.strictEqual(model.s.nonEntity.last.type, null);
        assert.strictEqual(model.s.pending, null);
        assert.strictEqual(bot.hurtBy, null);
        const starveId = Number(Object.entries(types).find(([, t]) => t === starve)[0]);
        model.seenDamageSeq = 0;
        bot.__fix98Damage = { seq: 1, events: [{ seq: 1, entityId: 7, sourceTypeId: starveId, sourceCauseId: 0, sourceDirectId: 0 }] };
        assert.doesNotThrow(() => model.onSample(bot, 18));
        assert.strictEqual(model.s.nonEntity.n, 2);
        assert.strictEqual(model.s.nonEntity.last.type, starve.name);
        assert.strictEqual(model.s.nonEntity.last.food, 0);
        assert.strictEqual(model.s.nonEntity.last.entity, false);
        bot.__fix98Damage = { seq: 2, events: [{ seq: 2, entityId: 7, sourceTypeId: -1, sourceCauseId: 0, sourceDirectId: 0 }] };
        assert.throws(() => model.onSample(bot, 17), /damage_type registry/);
    });
});

describe('fix98: rest serve chains a bed from game data', () => {
    it('no placed bed queues the recipe chain and does not propose a free-text sleep task', async () => {
        const v = mkV();
        const bed = Object.values(registry.blocksByName).find(b => typeof b.name === 'string' && b.name.endsWith('_bed'));
        assert.ok(bed, 'game data has a bed block');
        const cobble = registry.itemsByName.cobblestone;
        let asked = null;
        const bot = v.agent.bot;
        bot.registry = registry;
        bot.isABed = block => block && block.name === bed.name;
        bot.findBlock = () => null;
        bot.recipesAll = (id) => {
            asked = id;
            if (id !== bed.id && id !== registry.itemsByName[bed.name].id) return [];
            return [{ result: { id: registry.itemsByName[bed.name].id, count: 1 }, delta: [{ id: cobble.id, count: -1 }, { id: registry.itemsByName[bed.name].id, count: 1 }] }];
        };
        bot.sleep = () => { throw new Error('sleep should not run before a bed is placed'); };
        bot.defendSelf = () => { throw new Error('defendSelf called'); };
        bot.shelterNow = () => { throw new Error('shelterNow called'); };
        v.skills = [];
        v.npGraph = null;
        v.observe = () => ({
            inventory: { cobblestone: 8 },
            nearby_blocks: ['cobblestone'],
            is_day: false,
            time: 'night (18000, hostiles spawn outdoors)',
            health_value: 20, health_max: 20, food_value: 10, food_max: 20,
            inventory_slots: '1/36', empty_inventory_slots: 35, threats: 'none',
            equipment: { hand: 'empty' }, sleeping: false, sky_light: 0, time_since_rest: 8,
        });
        v.proposeTask = async () => { throw new Error('cold-start sleep task'); };
        v.restThreat.installed = true;
        bot.restSince = 8;
        v.restThreat.noteSourcedHurt('from-the-event', 6, 4);
        const winner = v._urgentCandidates(v._hungerServeState()).find(c => c.id === 'rest');
        assert.ok(winner, 'rest is servable once a hurt has taught a floor');
        const ok = await v._serveRest(winner);
        assert.strictEqual(ok, true);
        assert.ok(asked !== null, 'recipesAll was asked');
        const tasks = v.progress.subgoals.map(s => s.task);
        assert.ok(tasks.some(t => t.includes(bed.name)), tasks.join(' | '));
        assert.ok(!tasks.some(t => /sleep/i.test(t)), tasks.join(' | '));
    });

    it('a bed outside the interaction range is not a bed to sleep in', () => {
        const bot = {
            entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 },
            game: { gameMode: 'survival' },
            isABed: () => true,
            findBlock: () => ({ name: 'bed', position: new Vec3(0, 64, 30) }),
        };
        assert.strictEqual(findBedBlock(bot), null);
        const near = { name: 'bed', position: new Vec3(1, 64, 0) };
        bot.findBlock = () => near;
        assert.strictEqual(findBedBlock(bot), near);
    });

    it('bot.sleep rejection is rethrown', async () => {
        const v = mkV();
        const bed = { name: 'placed', position: new Vec3(1, 64, 0) };
        v.agent.bot.isABed = () => true;
        v.agent.bot.findBlock = () => bed;
        v.agent.bot.registry = { itemsByName: { placed: { name: 'placed' } }, blocksByName: { placed: { name: 'placed' } } };
        v.agent.bot.sleep = async () => { throw new Error('monsters nearby'); };
        v.restThreat.installed = true;
        v.agent.bot.restSince = 3;
        await assert.rejects(() => v._serveRest({ by: 'floor' }), /bot\.sleep rejected: monsters nearby/);
    });
});

describe('fix98: prompt facts', () => {
    it('observe carries is_day, sleeping, sky light, and the rest statistic', () => {
        const pos = new Vec3(0, 64, 0);
        const stoneStateId = 1;
        const minY = -64;
        const sectionCount = 24;
        const view = 1;
        const eyeSection = (pos.y - minY) >> 4;
        const stoneSection = { palette: [stoneStateId], data: { value: stoneStateId } };
        const airSection = { palette: [0], data: { value: 0 } };
        const columns = [];
        for (let dz = -view; dz <= view; dz++) {
            for (let dx = -view; dx <= view; dx++) {
                columns.push({
                    chunkX: dx,
                    chunkZ: dz,
                    column: { minY, sections: Array.from({ length: sectionCount }, (_, si) => (si < eyeSection ? stoneSection : airSection)) },
                });
            }
        }
        const bot = {
            entity: { position: pos, eyeHeight: 1.62 },
            time: { timeOfDay: 18000, isDay: false },
            isSleeping: true,
            restSince: 77,
            health: 4,
            food: 0,
            oxygenLevel: 300,
            game: { dimension: 'overworld', serverViewDistance: view, gameMode: 'survival' },
            heldItem: null,
            inventory: { items: () => [], emptySlotCount: () => 36, slots: Array(46).fill(null) },
            entities: {},
            registry: { blocksByStateId: { [stoneStateId]: { name: 'stone', metadata: 0, boundingBox: 'block', transparent: false } } },
            world: {
                getBiome: () => 1,
                getColumns: () => columns,
                raycast: () => null,
            },
            findBlocks: () => [],
            blockAt: () => ({ skyLight: 0 }),
        };
        const facts = restFacts(bot);
        assert.strictEqual(facts.is_day, false);
        assert.strictEqual(facts.sleeping, true);
        assert.strictEqual(facts.sky_light, 0);
        assert.strictEqual(facts.time_since_rest, 77);
        const v = Object.create(Voyager.prototype);
        v.agent = { bot, recentDeaths: [] };
        v.vitals = liveRegen();
        v._threats = () => 'none';
        v._deathHotspots = () => 'none';
        v._getChestFacts = () => ({});
        const state = v.observe();
        assert.strictEqual(state.is_day, false);
        assert.strictEqual(state.sleeping, true);
        assert.strictEqual(state.sky_light, 0);
        assert.strictEqual(state.time_since_rest, 77);
        assert.match(state.time, /night \(18000, hostiles spawn outdoors\)/);
    });

    it('the curriculum user text keeps the full time sentence', async () => {
        const v = mkV();
        v.repairMemory = { getWorkflowsForTask: () => [], formatWorkflowHints: () => '' };
        v._hutBuilt = () => false;
        v._cursorLimited = () => false;
        v._logPromptBreakdown = () => {};
        let user = null;
        v._askLocal = async (_sys, u) => { user = u; return '{"reasoning":"r","task":"Look around","context":""}'; };
        const sentence = 'night (18000, hostiles spawn outdoors)';
        await v.proposeTask(v.observe());
        assert.ok(user.includes(sentence), user);
        assert.ok(user.includes('is_day:false'), user);
        assert.ok(user.includes('time_since_rest:3'), user);
    });

    it('the goal-state key changes with is_day and not with the inventory held equal', () => {
        const v = mkV();
        const day = v._goalStateKey({ inventory: { dirt: 2 }, nearby_blocks: ['stone'], is_day: true });
        const night = v._goalStateKey({ inventory: { dirt: 2 }, nearby_blocks: ['stone'], is_day: false });
        const same = v._goalStateKey({ inventory: { dirt: 2 }, nearby_blocks: ['stone'], is_day: true });
        assert.notStrictEqual(day, night);
        assert.strictEqual(day, same);
        assert.throws(() => v._goalStateKey({ inventory: {}, nearby_blocks: [] }), /is_day/);
    });

    it('a prompt that does not fit still throws when it cannot be decomposed', async () => {
        const v = mkV();
        v._overflowTask = () => null;
        const err = new Error('context full');
        err.code = CONTEXT_FULL;
        await assert.rejects(() => v._onStepError(err), /context full/);
    });
});

describe('fix98: the new source has no mob, bed colour, tick count, or distance', () => {
    it('rest_threat.js does not name a mob, a bed colour, a tick count, or call the old reflexes', () => {
        const src = readFileSync(new URL('../src/agent/rest_threat.js', import.meta.url), 'utf8');
        const banned = ['phantom', 'creeper', 'zombie', 'skeleton', 'spider', 'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed', '72000', '24000', '13000', '23000', '12541', '23458', '6000', '12000', '18000', 'defendSelf', 'shelterNow', '??'];
        for (const w of banned) assert.ok(!src.includes(w), w);
        for (const n of [4, 8, 16, 24, 32, 64, 128]) {
            assert.ok(!new RegExp(`\\b${n}\\b`).test(src), `distance ${n}`);
        }
        assert.deepStrictEqual(bedItemNames({
            isABed: block => block.name === 'from-registry',
            registry: { itemsByName: { 'from-registry': { name: 'from-registry' } }, blocksByName: { 'from-registry': { name: 'from-registry' } } },
        }), ['from-registry']);
    });
});
