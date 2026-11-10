// fix98: rest need and threat interrupt.
// The rest statistic is minecraft:time_since_rest on the statistics packet (wiki Statistics).
// Its protocol id is the minecraft:custom_stat protocol_id from the vanilla data generator
// report checked into data/vanilla-custom-stats.json (scripts/generate-custom-stats.js).
// The category id is minecraft:custom in that same report's minecraft:stat_type registry.
// The report version must equal bot.version. A mismatch, a missing entry, or a statistics
// reply that does not contain that id fails the rest need only: it is logged and rest is
// marked unavailable. It does not exit the process.
// A health loss with no entityHurt is non-entity damage. It is classified from the damage_event
// packet and the damage-type registry (minecraft-data login registry, or the registry the server
// sends on login), plus food and oxygen. It is recorded. It does not throw. A damage_event whose
// own fields or type id are missing or malformed throws. An entityHurt with no source is not an
// attacker and is not invented from a nearby entity.
// Protocol action ids and packet names come from the minecraft-data schema. No tick count, no
// distance, no mob name, no bed colour.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REST_STATISTIC = 'minecraft:time_since_rest';
const CUSTOM_STAT_REGISTRY = 'minecraft:custom_stat';
const STAT_TYPE_REGISTRY = 'minecraft:stat_type';
const CUSTOM_STAT_TYPE = 'minecraft:custom';
const DAMAGE_REGISTRY = 'minecraft:damage_type';

function unwrapNbt(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node;
    if (Object.hasOwn(node, 'value') && Object.hasOwn(node, 'type') && !Object.hasOwn(node, 'name') && !Object.hasOwn(node, 'id')) {
        return unwrapNbt(node.value);
    }
    return node;
}

function fieldString(node, key) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) return null;
    const v = unwrapNbt(node[key]);
    if (typeof v !== 'string' || v.length === 0) return null;
    return v;
}

function fieldInt(node, key) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) return null;
    const v = unwrapNbt(node[key]);
    if (typeof v !== 'number' || !Number.isInteger(v)) return null;
    return v;
}

function walkFind(node, visit, seen) {
    if (!node || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    const here = visit(node);
    if (here !== null && here !== undefined) return here;
    const kids = Array.isArray(node) ? node : Object.values(node);
    for (const kid of kids) {
        if (!kid || typeof kid !== 'object') continue;
        const found = walkFind(kid, visit, seen);
        if (found !== null && found !== undefined) return found;
    }
    return null;
}

export function customStatReportPath() {
    return join(dirname(fileURLToPath(import.meta.url)), '../../data/vanilla-custom-stats.json');
}

export function loadCustomStatReport() {
    const path = customStatReportPath();
    let text;
    try {
        text = readFileSync(path, 'utf8');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`[fix98] custom_stat report could not be read (${path}): ${message}`);
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`[fix98] custom_stat report is not JSON (${path}): ${message}`);
    }
}

function registryEntry(report, registryName, entryName) {
    if (!report || typeof report !== 'object') throw new Error('[fix98] custom_stat report is missing');
    const registries = report.registries;
    if (!registries || typeof registries !== 'object') throw new Error('[fix98] custom_stat report has no registries');
    const registry = registries[registryName];
    if (!registry || typeof registry !== 'object' || !registry.entries || typeof registry.entries !== 'object') {
        throw new Error(`[fix98] custom_stat report has no ${registryName} registry`);
    }
    const entry = registry.entries[entryName];
    if (!entry || !Number.isInteger(entry.protocol_id)) {
        throw new Error(`[fix98] custom_stat report has no ${entryName} in ${registryName}`);
    }
    return entry.protocol_id;
}

export function resolveRestStatIds(report, botVersion) {
    if (!report || typeof report !== 'object') throw new Error('[fix98] custom_stat report is missing');
    if (typeof botVersion !== 'string' || botVersion.length === 0) {
        throw new Error(`[fix98] bot.version was not delivered; custom_stat report is for ${JSON.stringify(report.minecraftVersion)}`);
    }
    if (report.minecraftVersion !== botVersion) {
        throw new Error(`[fix98] custom_stat report version ${JSON.stringify(report.minecraftVersion)} does not match bot.version ${JSON.stringify(botVersion)}`);
    }
    return {
        categoryId: registryEntry(report, STAT_TYPE_REGISTRY, CUSTOM_STAT_TYPE),
        statisticId: registryEntry(report, CUSTOM_STAT_REGISTRY, REST_STATISTIC),
    };
}

export function markRestUnavailable(model, bot, reason) {
    if (typeof reason !== 'string' || reason.length === 0) throw new Error('[fix98] rest unavailable needs a reason');
    if (model && model.restUnavailable === reason) return;
    if (model) model.restUnavailable = reason;
    if (bot) bot.restUnavailable = reason;
    console.error(`[fix98] rest unavailable: ${reason}`);
}

function assertStatEntry(entry) {
    if (!entry || typeof entry.categoryId !== 'number' || typeof entry.statisticId !== 'number' || typeof entry.value !== 'number') {
        throw new Error(`[fix98] statistics entry is not numeric: ${JSON.stringify(entry)}`);
    }
    if (!Number.isInteger(entry.categoryId) || !Number.isInteger(entry.statisticId)) {
        throw new Error(`[fix98] statistics entry is not numeric: ${JSON.stringify(entry)}`);
    }
}

function assertRestIds(ids) {
    if (!ids || !Number.isInteger(ids.categoryId) || !Number.isInteger(ids.statisticId)) {
        throw new Error(`[fix98] no id for ${REST_STATISTIC} in the custom_stat report`);
    }
}

export function readRestStatistic(packet, ids) {
    if (!packet || !Array.isArray(packet.entries)) {
        throw new Error(`[fix98] statistics packet has no entries; ${REST_STATISTIC} was not delivered`);
    }
    assertRestIds(ids);
    let found = null;
    const got = [];
    for (const entry of packet.entries) {
        assertStatEntry(entry);
        got.push(`category ${entry.categoryId}/stat ${entry.statisticId}`);
        if (entry.categoryId === ids.categoryId && entry.statisticId === ids.statisticId) {
            if (found !== null) throw new Error(`[fix98] statistics packet listed ${REST_STATISTIC} more than once`);
            found = entry.value;
        }
    }
    if (found === null) {
        const listed = got.length ? got.join(', ') : 'no entries';
        throw new Error(`[fix98] statistics packet did not include ${REST_STATISTIC} (got ${listed})`);
    }
    return found;
}

function damageTypeList(root) {
    const found = walkFind(root, node => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
        if (!Object.hasOwn(node, DAMAGE_REGISTRY)) return null;
        return node[DAMAGE_REGISTRY];
    }, new Set());
    if (found === null || found === undefined) return null;
    const list = unwrapNbt(found);
    if (!Array.isArray(list)) throw new Error(`[fix98] ${DAMAGE_REGISTRY} registry is malformed`);
    return list;
}

function damageTypeMap(list) {
    const out = {};
    for (const entry of list) {
        const name = fieldString(entry, 'name');
        const id = fieldInt(entry, 'id');
        if (name === null || id === null) throw new Error(`[fix98] ${DAMAGE_REGISTRY} entry is missing name or id: ${JSON.stringify(entry)}`);
        if (Object.hasOwn(out, String(id))) throw new Error(`[fix98] ${DAMAGE_REGISTRY} id ${id} is listed more than once`);
        const element = entry && entry.element ? unwrapNbt(entry.element) : null;
        out[id] = { name, messageId: element ? fieldString(element, 'message_id') : null };
    }
    if (Object.keys(out).length === 0) throw new Error(`[fix98] ${DAMAGE_REGISTRY} registry has no entries`);
    return out;
}

export function damageTypesFromData(mcData) {
    if (!mcData || !mcData.loginPacket) throw new Error('[fix98] minecraft-data login packet required for the damage-type registry');
    const list = damageTypeList(mcData.loginPacket);
    if (!list) throw new Error(`[fix98] minecraft-data login packet has no ${DAMAGE_REGISTRY} registry`);
    return damageTypeMap(list);
}

export function damageTypesFromCodec(codec) {
    if (codec === null || codec === undefined) return null;
    const list = damageTypeList(codec);
    if (!list) return null;
    return damageTypeMap(list);
}

function findPacketName(node, typeName) {
    let found = null;
    const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) {
            for (const x of n) walk(x);
            return;
        }
        for (const [k, v] of Object.entries(n)) {
            if (v === typeName && !k.startsWith('packet_')) {
                if (found !== null && found !== k) throw new Error(`[fix98] protocol names ${typeName} as both ${found} and ${k}`);
                found = k;
            } else {
                walk(v);
            }
        }
    };
    walk(node);
    return found;
}

function packetName(node, typeName) {
    const found = findPacketName(node, typeName);
    if (found === null) throw new Error(`[fix98] protocol has no packet name for ${typeName}`);
    return found;
}

function toClientPacketName(mcData, typeName) {
    if (!mcData || !mcData.protocol) throw new Error('[fix98] minecraft-data protocol required');
    let found = null;
    for (const state of ['play', 'configuration']) {
        const dir = mcData.protocol[state];
        if (!dir || !dir.toClient || !dir.toClient.types) continue;
        const name = findPacketName(dir.toClient.types, typeName);
        if (name === null) continue;
        if (found !== null && found !== name) throw new Error(`[fix98] protocol names ${typeName} as both ${found} and ${name}`);
        found = name;
    }
    if (found === null) throw new Error(`[fix98] protocol has no packet name for ${typeName}`);
    return found;
}

export function clientCommandSpec(mcData) {
    if (!mcData || !mcData.protocol || !mcData.protocol.play) throw new Error('[fix98] minecraft-data protocol required');
    const toServer = mcData.protocol.play.toServer.types;
    const toClient = mcData.protocol.play.toClient.types;
    const packet = toServer.packet_client_command;
    if (!packet) throw new Error('[fix98] protocol has no packet_client_command');
    const fields = packet[1];
    if (!Array.isArray(fields) || fields.length === 0) throw new Error('[fix98] packet_client_command has no fields');
    const field = fields[0];
    const type = field.type;
    if (!Array.isArray(type) || type[0] !== 'mapper' || !type[1] || !type[1].mappings) {
        throw new Error('[fix98] client_command action is not a protocol mapper');
    }
    let action = null;
    for (const [id, name] of Object.entries(type[1].mappings)) {
        if (name !== 'request_stats') continue;
        if (action !== null) throw new Error('[fix98] protocol maps request_stats more than once');
        const n = Number(id);
        if (!Number.isInteger(n)) throw new Error(`[fix98] request_stats action id is not an integer: ${JSON.stringify(id)}`);
        action = n;
    }
    if (action === null) throw new Error('[fix98] protocol has no client_command action request_stats');
    return {
        write: packetName(toServer, 'packet_client_command'),
        field: field.name,
        action,
        reply: packetName(toClient, 'packet_statistics'),
    };
}

function sourceName(source) {
    if (source === null || source === undefined) return null;
    if (typeof source !== 'object') throw new Error(`[fix98] entityHurt source is not an entity: ${JSON.stringify(source)}`);
    if (typeof source.name === 'string' && source.name.length > 0) return source.name;
    if (typeof source.username === 'string' && source.username.length > 0) return source.username;
    throw new Error('[fix98] entityHurt source entity has no name; refusing to invent an attacker');
}

function hungerAir(bot) {
    return {
        food: typeof bot.food === 'number' ? bot.food : null,
        oxygen: typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : null,
    };
}

function assertDamageEvent(packet) {
    if (!packet || typeof packet !== 'object') throw new Error('[fix98] damage_event packet is missing');
    for (const key of ['entityId', 'sourceTypeId', 'sourceCauseId', 'sourceDirectId']) {
        if (!Number.isInteger(packet[key])) {
            throw new Error(`[fix98] damage_event ${key} is missing or malformed: ${JSON.stringify(packet[key])}`);
        }
    }
}

export function classifyDamage(bot, packet) {
    assertDamageEvent(packet);
    const types = bot.__fix98DamageTypes;
    if (!types || typeof types !== 'object') throw new Error(`[fix98] ${DAMAGE_REGISTRY} registry was not delivered`);
    const type = types[packet.sourceTypeId];
    if (!type || typeof type.name !== 'string' || type.name.length === 0) {
        throw new Error(`[fix98] damage_event sourceTypeId ${packet.sourceTypeId} is not in the ${DAMAGE_REGISTRY} registry`);
    }
    const body = hungerAir(bot);
    return {
        entity: false,
        type: type.name,
        messageId: type.messageId,
        food: body.food,
        oxygen: body.oxygen,
        sourceCauseId: packet.sourceCauseId,
        sourceDirectId: packet.sourceDirectId,
    };
}

export function installProtocolFacts(bot, mcData, model) {
    if (!bot || typeof bot.on !== 'function') throw new Error('[fix98] bot.on is required to receive entityHurt');
    if (!bot._client || typeof bot._client.write !== 'function' || typeof bot._client.on !== 'function') {
        throw new Error('[fix98] bot._client is required to request the statistics packet');
    }
    if (bot.__fix98Facts === true) return;
    const spec = clientCommandSpec(mcData);
    const damagePacket = toClientPacketName(mcData, 'packet_damage_event');
    const registryPacket = toClientPacketName(mcData, 'packet_registry_data');
    bot.hurtBy = null;
    bot.__fix98Hurt = { seq: 0, events: [] };
    bot.__fix98Damage = { seq: 0, events: [] };
    bot.__fix98DamageTypes = damageTypesFromData(mcData);
    let ids = null;
    try {
        ids = resolveRestStatIds(loadCustomStatReport(), bot.version);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        markRestUnavailable(model, bot, reason);
    }
    bot.on('entityHurt', (entity, source) => {
        if (entity !== bot.entity) return;
        const name = sourceName(source);
        bot.__fix98Hurt.seq += 1;
        bot.__fix98Hurt.events.push({ seq: bot.__fix98Hurt.seq, name });
        if (name !== null) bot.hurtBy = name;
    });
    bot._client.on(damagePacket, (packet) => {
        assertDamageEvent(packet);
        if (!bot.entity || packet.entityId !== bot.entity.id) return;
        bot.__fix98Damage.seq += 1;
        bot.__fix98Damage.events.push({
            seq: bot.__fix98Damage.seq,
            entityId: packet.entityId,
            sourceTypeId: packet.sourceTypeId,
            sourceCauseId: packet.sourceCauseId,
            sourceDirectId: packet.sourceDirectId,
        });
    });
    bot._client.on(registryPacket, (packet) => {
        const codec = packet && packet.codec ? packet.codec : packet;
        const types = damageTypesFromCodec(codec);
        if (types) bot.__fix98DamageTypes = types;
    });
    bot._client.on(spec.reply, (packet) => {
        if (!ids) {
            if (!model || typeof model.restUnavailable !== 'string' || model.restUnavailable.length === 0) {
                markRestUnavailable(model, bot, `[fix98] ${REST_STATISTIC} id was not resolved from the custom_stat report`);
            }
            return;
        }
        try {
            bot.restSince = readRestStatistic(packet, ids);
            if (model) model.restUnavailable = null;
            bot.restUnavailable = null;
        } catch (err) {
            bot.restSince = undefined;
            const reason = err instanceof Error ? err.message : String(err);
            markRestUnavailable(model, bot, reason);
        }
    });
    bot._client.write(spec.write, { [spec.field]: spec.action });
    bot.__fix98Facts = true;
}

export function restFacts(bot) {
    if (!bot || !bot.time || typeof bot.time.isDay !== 'boolean') throw new Error('[fix98] bot.time.isDay was not delivered');
    if (typeof bot.isSleeping !== 'boolean') throw new Error('[fix98] bot.isSleeping was not delivered');
    if (typeof bot.blockAt !== 'function') throw new Error('[fix98] bot.blockAt was not delivered');
    if (!bot.entity || !bot.entity.position || typeof bot.entity.position.floored !== 'function') {
        throw new Error('[fix98] bot position was not delivered');
    }
    const head = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0));
    if (!head || typeof head.skyLight !== 'number') throw new Error('[fix98] sky light at the head was not delivered');
    const facts = { is_day: bot.time.isDay, sleeping: bot.isSleeping, sky_light: head.skyLight };
    if (typeof bot.restUnavailable === 'string' && bot.restUnavailable.length > 0) {
        return { ...facts, time_since_rest: null, rest_unavailable: bot.restUnavailable };
    }
    if (typeof bot.restSince !== 'number') return { ...facts, time_since_rest: null };
    return { ...facts, time_since_rest: bot.restSince };
}

export function bedItemNames(bot) {
    if (!bot || typeof bot.isABed !== 'function') throw new Error('[fix98] bot.isABed was not delivered');
    const reg = bot.registry;
    if (!reg || !reg.itemsByName || !reg.blocksByName) throw new Error('[fix98] bot.registry required to find a bed in game data');
    const names = [];
    for (const name of Object.keys(reg.itemsByName)) {
        if (!Object.hasOwn(reg.blocksByName, name)) continue;
        if (bot.isABed(reg.blocksByName[name]) === true) names.push(name);
    }
    if (names.length === 0) throw new Error('[fix98] game data has no block bot.isABed accepts');
    return names;
}

export function findBedBlock(bot) {
    if (!bot || typeof bot.findBlock !== 'function') throw new Error('[fix98] bot.findBlock was not delivered');
    if (typeof bot.isABed !== 'function') throw new Error('[fix98] bot.isABed was not delivered');
    return bot.findBlock({ matching: block => bot.isABed(block) === true });
}

export function emptyRestStore() {
    return {
        hurts: {}, runs: {}, harmFloor: null, pending: null, unhandled: { n: 0, sum: 0 },
        nonEntity: { n: 0, sum: 0, last: null },
    };
}

function assertStore(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`[fix98] restThreat store must be an object, got ${JSON.stringify(s)}`);
    if (!s.hurts || typeof s.hurts !== 'object' || Array.isArray(s.hurts)) throw new Error('[fix98] restThreat.hurts must be an object');
    if (!s.runs || typeof s.runs !== 'object' || Array.isArray(s.runs)) throw new Error('[fix98] restThreat.runs must be an object');
    if (s.harmFloor !== null && typeof s.harmFloor !== 'number') throw new Error(`[fix98] restThreat.harmFloor must be a number or null, got ${JSON.stringify(s.harmFloor)}`);
    if (s.pending !== null) {
        if (!s.pending || typeof s.pending.name !== 'string' || typeof s.pending.dmg !== 'number') {
            throw new Error(`[fix98] restThreat.pending must be {name, dmg} or null, got ${JSON.stringify(s.pending)}`);
        }
    }
    if (!s.unhandled || typeof s.unhandled.n !== 'number' || typeof s.unhandled.sum !== 'number') {
        throw new Error('[fix98] restThreat.unhandled must be {n, sum}');
    }
    if (!s.nonEntity || typeof s.nonEntity.n !== 'number' || typeof s.nonEntity.sum !== 'number') {
        throw new Error('[fix98] restThreat.nonEntity must be {n, sum, last}');
    }
}

export class RestThreat {
    constructor(store) {
        assertStore(store);
        this.s = store;
        this.installed = false;
        this.lastHp = null;
        this.seenSeq = 0;
        this.seenDamageSeq = 0;
        this.restUnavailable = null;
    }

    noteSourcedHurt(name, dmg, rest) {
        if (typeof name !== 'string' || name.length === 0) throw new Error('[fix98] entityHurt source name missing; refusing to invent an attacker');
        if (typeof dmg !== 'number' || !(dmg > 0)) throw new Error(`[fix98] hurt damage must be a positive number, got ${JSON.stringify(dmg)}`);
        const prev = this.s.hurts[name];
        if (!prev) this.s.hurts[name] = { n: 1, dmg };
        else {
            if (typeof prev.n !== 'number' || typeof prev.dmg !== 'number') throw new Error(`[fix98] hurt record for ${name} is malformed`);
            prev.n += 1;
            prev.dmg += dmg;
        }
        this.s.pending = { name, dmg };
        if (typeof rest === 'number' && (this.s.harmFloor === null || rest < this.s.harmFloor)) this.s.harmFloor = rest;
        this.s.unhandled.n += 1;
        this.s.unhandled.sum += -dmg;
    }

    onSample(bot, hp) {
        if (this.installed !== true) return;
        if (typeof hp !== 'number') throw new Error(`[fix98] sample health must be a number, got ${JSON.stringify(hp)}`);
        const box = bot.__fix98Hurt;
        const hurts = box && typeof box.seq === 'number' && Array.isArray(box.events) ? box : { seq: 0, events: [] };
        if (box && (typeof box.seq !== 'number' || !Array.isArray(box.events))) {
            throw new Error('[fix98] entityHurt record is malformed');
        }
        const damage = bot.__fix98Damage;
        const packets = damage && typeof damage.seq === 'number' && Array.isArray(damage.events) ? damage : { seq: 0, events: [] };
        if (damage && (typeof damage.seq !== 'number' || !Array.isArray(damage.events))) {
            throw new Error('[fix98] damage_event record is malformed');
        }
        const prev = this.lastHp;
        this.lastHp = hp;
        const freshHurt = hurts.events.filter(e => e.seq > this.seenSeq);
        const freshDamage = packets.events.filter(e => e.seq > this.seenDamageSeq);
        this.seenSeq = hurts.seq;
        this.seenDamageSeq = packets.seq;
        if (typeof prev !== 'number' || !(hp < prev)) {
            bot.hurtBy = this.s.pending === null ? null : this.s.pending.name;
            return;
        }
        const sourced = freshHurt.filter(e => e.name !== null);
        if (sourced.length > 0) {
            const name = sourced[sourced.length - 1].name;
            this.noteSourcedHurt(name, prev - hp, bot.restSince);
        } else {
            this.noteNonEntity(bot, prev - hp, freshDamage);
        }
        bot.hurtBy = this.s.pending === null ? null : this.s.pending.name;
    }

    noteNonEntity(bot, dmg, packets) {
        if (typeof dmg !== 'number' || !(dmg > 0)) throw new Error(`[fix98] hurt damage must be a positive number, got ${JSON.stringify(dmg)}`);
        let info;
        if (packets.length > 0) {
            info = classifyDamage(bot, packets[packets.length - 1]);
        } else {
            const body = hungerAir(bot);
            info = { entity: false, type: null, messageId: null, food: body.food, oxygen: body.oxygen, sourceCauseId: null, sourceDirectId: null };
        }
        this.s.nonEntity.n += 1;
        this.s.nonEntity.sum += dmg;
        this.s.nonEntity.last = { entity: false, type: info.type, messageId: info.messageId, food: info.food, oxygen: info.oxygen, dmg };
    }

    threatCandidate(posterior, draw) {
        if (typeof posterior !== 'number') throw new Error(`[fix98] threat posterior must be a number, got ${JSON.stringify(posterior)}`);
        if (typeof draw !== 'number') throw new Error(`[fix98] threat draw must be a number, got ${JSON.stringify(draw)}`);
        if (this.s.pending === null) return null;
        const h = this.s.hurts[this.s.pending.name];
        if (!h || typeof h.n !== 'number' || !(h.n > 0) || typeof h.dmg !== 'number') {
            throw new Error(`[fix98] no learned damage for entityHurt source ${JSON.stringify(this.s.pending.name)}`);
        }
        const mean = h.dmg / h.n;
        return {
            id: 'threat',
            kind: 'threat',
            value: draw * mean * posterior,
            by: `entityHurt from ${this.s.pending.name}; learned damage ${mean}`,
        };
    }

    restCandidate(bot, posterior, draw) {
        if (this.installed !== true) return null;
        if (typeof this.restUnavailable === 'string' && this.restUnavailable.length > 0) return null;
        if (typeof posterior !== 'number') throw new Error(`[fix98] rest posterior must be a number, got ${JSON.stringify(posterior)}`);
        if (typeof draw !== 'number') throw new Error(`[fix98] rest draw must be a number, got ${JSON.stringify(draw)}`);
        if (typeof bot.restSince !== 'number') return null;
        if (this.s.harmFloor === null) return null;
        if (!(bot.restSince >= this.s.harmFloor)) return null;
        let n = 0;
        let dmg = 0;
        for (const h of Object.values(this.s.hurts)) {
            if (!h || typeof h.n !== 'number' || typeof h.dmg !== 'number') throw new Error('[fix98] hurt record is malformed');
            n += h.n;
            dmg += h.dmg;
        }
        if (!(n > 0)) throw new Error('[fix98] rest floor without hurt evidence');
        const mean = dmg / n;
        // The first sourced hurt correlated with the rest statistic is the whole sample.
        // Later hurts keep the Thompson draw. One hit raises the need; more deaths are not required.
        const value = n === 1 ? mean * posterior : draw * mean * posterior;
        const by = n === 1
            ? `${REST_STATISTIC} ${bot.restSince} raised on the first sourced hurt (harm floor ${this.s.harmFloor})`
            : `${REST_STATISTIC} ${bot.restSince} at or above the learned harm floor ${this.s.harmFloor}`;
        return { id: 'rest', kind: 'need', value, by };
    }

    noteRun(name, s0, s1) {
        if (typeof name !== 'string' || name.length === 0) throw new Error('[fix98] noteRun needs a skill name');
        let rec = this.s.runs[name];
        if (!rec) {
            rec = { restN: 0, restDrop: 0, sleepN: 0, threatN: 0, threatHp: 0 };
            this.s.runs[name] = rec;
        }
        if (typeof s0.rest === 'number' && typeof s1.rest === 'number' && s1.rest < s0.rest) {
            rec.restN += 1;
            rec.restDrop += s0.rest - s1.rest;
        }
        if (s0.sleeping === false && s1.sleeping === true) rec.sleepN += 1;
        if (typeof s0.hurtBy === 'string' && s0.hurtBy.length > 0 && typeof s0.hp === 'number' && typeof s1.hp === 'number') {
            rec.threatN += 1;
            rec.threatHp += s1.hp - s0.hp;
        }
    }

    bestRestRaiser(playable) {
        let best = null;
        for (const [name, rec] of Object.entries(this.s.runs)) {
            if (!(rec.restN > 0) && !(rec.sleepN > 0)) continue;
            const entry = playable(name);
            if (!entry) continue;
            const score = rec.restN > 0 ? rec.restDrop / rec.restN : rec.sleepN;
            if (best === null || score > best.score) best = { name, entry, score };
        }
        return best;
    }

    bestThreatRaiser(playable) {
        const base = this.s.unhandled.n > 0 ? this.s.unhandled.sum / this.s.unhandled.n : null;
        let best = null;
        for (const [name, rec] of Object.entries(this.s.runs)) {
            if (!(rec.threatN > 0)) continue;
            const mean = rec.threatHp / rec.threatN;
            if (base === null) {
                if (!(mean > 0)) continue;
            } else if (!(mean > base)) continue;
            const entry = playable(name);
            if (!entry) continue;
            if (best === null || mean > best.mean) best = { name, entry, mean };
        }
        return best;
    }
}
