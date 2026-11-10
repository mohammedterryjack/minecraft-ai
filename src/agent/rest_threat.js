// fix98: rest need and threat interrupt.
// The rest statistic is minecraft:time_since_rest on the statistics packet (wiki Statistics).
// The attacker is the entityHurt source (mineflayer damage_event). A health loss with no
// entityHurt throws. A delivered event whose source id is absent is non-entity damage:
// it is not an attacker and it is not invented from a nearby entity.
// Protocol action ids and packet names come from the minecraft-data schema. Statistic ids
// are the vanilla registry order (protocol id = index of the name). No tick count, no
// distance, no mob name, no bed colour.

export const REST_STATISTIC = 'minecraft:time_since_rest';
const CUSTOM_CATEGORY = 'minecraft:custom';

// StatType registration order for the live version (protocol category id = index).
const STAT_TYPES = [
    'minecraft:mined',
    'minecraft:crafted',
    'minecraft:used',
    'minecraft:broken',
    'minecraft:picked_up',
    'minecraft:dropped',
    'minecraft:killed',
    'minecraft:killed_by',
    'minecraft:custom',
];

// Custom stat registration order for the live version (protocol statistic id = index).
const CUSTOM_STATS = [
    'minecraft:leave_game',
    'minecraft:play_time',
    'minecraft:total_world_time',
    'minecraft:time_since_death',
    'minecraft:time_since_rest',
    'minecraft:sneak_time',
    'minecraft:walk_one_cm',
    'minecraft:crouch_one_cm',
    'minecraft:sprint_one_cm',
    'minecraft:walk_on_water_one_cm',
    'minecraft:fall_one_cm',
    'minecraft:climb_one_cm',
    'minecraft:fly_one_cm',
    'minecraft:walk_under_water_one_cm',
    'minecraft:minecart_one_cm',
    'minecraft:boat_one_cm',
    'minecraft:pig_one_cm',
    'minecraft:horse_one_cm',
    'minecraft:aviate_one_cm',
    'minecraft:swim_one_cm',
    'minecraft:strider_one_cm',
    'minecraft:jump',
    'minecraft:drop',
    'minecraft:damage_dealt',
    'minecraft:damage_dealt_absorbed',
    'minecraft:damage_dealt_resisted',
    'minecraft:damage_taken',
    'minecraft:damage_blocked_by_shield',
    'minecraft:damage_absorbed',
    'minecraft:damage_resisted',
    'minecraft:deaths',
    'minecraft:mob_kills',
    'minecraft:animals_bred',
    'minecraft:player_kills',
    'minecraft:fish_caught',
    'minecraft:talked_to_villager',
    'minecraft:traded_with_villager',
    'minecraft:eat_cake_slice',
    'minecraft:fill_cauldron',
    'minecraft:use_cauldron',
    'minecraft:clean_armor',
    'minecraft:clean_banner',
    'minecraft:clean_shulker_box',
    'minecraft:interact_with_brewingstand',
    'minecraft:interact_with_beacon',
    'minecraft:inspect_dropper',
    'minecraft:inspect_hopper',
    'minecraft:inspect_dispenser',
    'minecraft:play_noteblock',
    'minecraft:tune_noteblock',
    'minecraft:pot_flower',
    'minecraft:trigger_trapped_chest',
    'minecraft:open_enderchest',
    'minecraft:enchant_item',
    'minecraft:play_record',
    'minecraft:interact_with_furnace',
    'minecraft:interact_with_crafting_table',
    'minecraft:open_chest',
    'minecraft:sleep_in_bed',
    'minecraft:open_shulker_box',
    'minecraft:open_barrel',
    'minecraft:interact_with_blast_furnace',
    'minecraft:interact_with_smoker',
    'minecraft:interact_with_lectern',
    'minecraft:interact_with_campfire',
    'minecraft:interact_with_cartography_table',
    'minecraft:interact_with_loom',
    'minecraft:interact_with_stonecutter',
    'minecraft:bell_ring',
    'minecraft:raid_trigger',
    'minecraft:raid_win',
    'minecraft:interact_with_anvil',
    'minecraft:interact_with_grindstone',
    'minecraft:target_hit',
    'minecraft:interact_with_smithing_table',
];

function indexOfName(names, wanted) {
    const i = names.indexOf(wanted);
    if (i < 0) throw new Error(`[fix98] registry has no ${wanted}`);
    return i;
}

export function registryIds() {
    return {
        categoryId: indexOfName(STAT_TYPES, CUSTOM_CATEGORY),
        statisticId: indexOfName(CUSTOM_STATS, REST_STATISTIC),
    };
}

function categoryName(id) {
    if (!Number.isInteger(id)) throw new Error(`[fix98] statistics categoryId is not an integer: ${JSON.stringify(id)}`);
    if (id < 0 || id >= STAT_TYPES.length) return null;
    return STAT_TYPES[id];
}

function statName(id) {
    if (!Number.isInteger(id)) throw new Error(`[fix98] statistics statisticId is not an integer: ${JSON.stringify(id)}`);
    if (id < 0 || id >= CUSTOM_STATS.length) return null;
    return CUSTOM_STATS[id];
}

function describeEntry(entry) {
    const cat = categoryName(entry.categoryId);
    if (cat === null) return `category ${entry.categoryId}/stat ${entry.statisticId}`;
    if (cat !== CUSTOM_CATEGORY) return `${cat}#${entry.statisticId}`;
    const stat = statName(entry.statisticId);
    if (stat === null) return `${cat}#${entry.statisticId}`;
    return `${cat}/${stat}`;
}

export function readRestStatistic(packet) {
    if (!packet || !Array.isArray(packet.entries)) {
        throw new Error(`[fix98] statistics packet has no entries; ${REST_STATISTIC} was not delivered`);
    }
    const ids = registryIds();
    let found = null;
    const got = [];
    for (const entry of packet.entries) {
        if (!entry || typeof entry.categoryId !== 'number' || typeof entry.statisticId !== 'number' || typeof entry.value !== 'number') {
            throw new Error(`[fix98] statistics entry is not numeric: ${JSON.stringify(entry)}`);
        }
        got.push(describeEntry(entry));
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

function packetName(node, typeName) {
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

export function installProtocolFacts(bot, mcData) {
    if (!bot || typeof bot.on !== 'function') throw new Error('[fix98] bot.on is required to receive entityHurt');
    if (!bot._client || typeof bot._client.write !== 'function' || typeof bot._client.on !== 'function') {
        throw new Error('[fix98] bot._client is required to request the statistics packet');
    }
    if (bot.__fix98Facts === true) return;
    const spec = clientCommandSpec(mcData);
    bot.hurtBy = null;
    bot.__fix98Hurt = { seq: 0, events: [] };
    bot.on('entityHurt', (entity, source) => {
        if (entity !== bot.entity) return;
        const name = sourceName(source);
        bot.__fix98Hurt.seq += 1;
        bot.__fix98Hurt.events.push({ seq: bot.__fix98Hurt.seq, name });
        if (name !== null) bot.hurtBy = name;
    });
    bot._client.on(spec.reply, (packet) => {
        bot.restSince = readRestStatistic(packet);
    });
    bot._client.write(spec.write, { [spec.field]: spec.action });
    bot.__fix98Facts = true;
}

export function restFacts(bot) {
    if (!bot || !bot.time || typeof bot.time.isDay !== 'boolean') throw new Error('[fix98] bot.time.isDay was not delivered');
    if (typeof bot.isSleeping !== 'boolean') throw new Error('[fix98] bot.isSleeping was not delivered');
    if (typeof bot.restSince !== 'number') throw new Error(`[fix98] statistics packet missing; ${REST_STATISTIC} was not delivered`);
    if (typeof bot.blockAt !== 'function') throw new Error('[fix98] bot.blockAt was not delivered');
    if (!bot.entity || !bot.entity.position || typeof bot.entity.position.floored !== 'function') {
        throw new Error('[fix98] bot position was not delivered');
    }
    const head = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0));
    if (!head || typeof head.skyLight !== 'number') throw new Error('[fix98] sky light at the head was not delivered');
    return { is_day: bot.time.isDay, sleeping: bot.isSleeping, sky_light: head.skyLight, time_since_rest: bot.restSince };
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
    return { hurts: {}, runs: {}, harmFloor: null, pending: null, unhandled: { n: 0, sum: 0 } };
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
}

export class RestThreat {
    constructor(store) {
        assertStore(store);
        this.s = store;
        this.installed = false;
        this.lastHp = null;
        this.seenSeq = 0;
    }

    noteSourcedHurt(name, dmg, rest) {
        if (typeof name !== 'string' || name.length === 0) throw new Error('[fix98] entityHurt source name missing; refusing to invent an attacker');
        if (typeof dmg !== 'number' || !(dmg > 0)) throw new Error(`[fix98] hurt damage must be a positive number, got ${JSON.stringify(dmg)}`);
        if (typeof rest !== 'number') throw new Error(`[fix98] statistics packet missing; ${REST_STATISTIC} was not delivered`);
        const prev = this.s.hurts[name];
        if (!prev) this.s.hurts[name] = { n: 1, dmg };
        else {
            if (typeof prev.n !== 'number' || typeof prev.dmg !== 'number') throw new Error(`[fix98] hurt record for ${name} is malformed`);
            prev.n += 1;
            prev.dmg += dmg;
        }
        this.s.pending = { name, dmg };
        if (this.s.harmFloor === null || rest < this.s.harmFloor) this.s.harmFloor = rest;
        this.s.unhandled.n += 1;
        this.s.unhandled.sum += -dmg;
    }

    onSample(bot, hp) {
        if (this.installed !== true) return;
        if (typeof hp !== 'number') throw new Error(`[fix98] sample health must be a number, got ${JSON.stringify(hp)}`);
        const box = bot.__fix98Hurt;
        if (!box || typeof box.seq !== 'number' || !Array.isArray(box.events)) {
            throw new Error('[fix98] entityHurt listener was not installed');
        }
        const prev = this.lastHp;
        this.lastHp = hp;
        if (typeof prev !== 'number') {
            this.seenSeq = box.seq;
            bot.hurtBy = this.s.pending === null ? null : this.s.pending.name;
            return;
        }
        if (!(hp < prev)) {
            this.seenSeq = box.seq;
            bot.hurtBy = this.s.pending === null ? null : this.s.pending.name;
            return;
        }
        const fresh = box.events.filter(e => e.seq > this.seenSeq);
        this.seenSeq = box.seq;
        if (fresh.length === 0) throw new Error('[fix98] entityHurt was not delivered for a health loss; refusing to invent an attacker');
        const sourced = fresh.filter(e => e.name !== null);
        if (sourced.length > 0) {
            const name = sourced[sourced.length - 1].name;
            this.noteSourcedHurt(name, prev - hp, bot.restSince);
        }
        bot.hurtBy = this.s.pending === null ? null : this.s.pending.name;
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
        if (typeof posterior !== 'number') throw new Error(`[fix98] rest posterior must be a number, got ${JSON.stringify(posterior)}`);
        if (typeof draw !== 'number') throw new Error(`[fix98] rest draw must be a number, got ${JSON.stringify(draw)}`);
        if (typeof bot.restSince !== 'number') throw new Error(`[fix98] statistics packet missing; ${REST_STATISTIC} was not delivered`);
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
        return {
            id: 'rest',
            kind: 'need',
            value: draw * mean * posterior,
            by: `${REST_STATISTIC} ${bot.restSince} at or above the learned harm floor ${this.s.harmFloor}`,
        };
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
