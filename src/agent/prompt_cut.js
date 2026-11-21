// fix93: the voyager code-model system prompt keeps the instruction prose and drops the
// placeholders the user message already carries (stats, inventory, docs, examples, memory, self-prompt).
// Those expansions were a second, stale copy of the same facts.

const REDUNDANT = ['$SELF_PROMPT', '$MEMORY', '$STATS', '$INVENTORY', '$CODE_DOCS', '$EXAMPLES'];

// fix155: the "shape notes" were hand-copied inline three times in voyager.js (repair,
// joint-repair, compose prompts), and none of them stated the thing the coder keeps getting wrong:
// `bot.entities` is an object map keyed by entity id (mineflayer docs api.md), not an array —
// generated code calls .filter on it and the lint gate "closest real member" advice made it worse.
// One constant, all three prompts, plus the map-vs-array and no-bot.leveldb notes.
export const API_SHAPE_NOTES = `findBlock/findBlocks/nearestEntity/bot.entities/blockAt results can be null or empty: always null-check them before reading .position/.x or calling methods on them. bot.findBlocks(options): matching is a block id, an array of block ids, or a function; maxDistance and count are finite numbers. bot.findBlock(options) returns one block and does not take count; pass matching and maxDistance. getNearestBlocks(bot, block_types, distance, count): block_types is a block name or an array of names (null lists every block id); distance and count are finite numbers and are required. A list of names is not a distance. getNearbyBlockTypes(bot) lists blocks the bot can see (loaded, inside the server view distance, a face open to air or another non-occluding block, confirmed by bot.world.raycast). It does not take a radius. bot.entities is a map of entityId to entity, NOT an array (mineflayer docs api.md): bot.entities.filter/map/find is not a function — iterate Object.values(bot.entities), or call the bare skills getNearbyEntities(bot, distance) / getNearestEntityWhere(...). bot.inventory is an Inventory object, NOT an array (mineflayer docs api.md: inventory): bot.inventory.find/filter/map is not a function — call bot.inventory.items() first, which returns an array of item stacks (then .find(stack => stack.name === 'x') on that array; other real members: bot.inventory.count(name), findInventoryItem(name), firstEmptySlotRange(start, end)). The bot object has only real mineflayer properties: there is no bot.leveldb, bot.db or bot.memory.`;

export function voyagerCodingInstructions(coding, name) {
    if (typeof coding !== 'string' || coding.length === 0) throw new Error('[fix93] profile.coding required');
    for (const marker of REDUNDANT) {
        if (!coding.includes(marker)) throw new Error(`[fix93] profile.coding has no ${marker}; the redundant expansion cannot be cut`);
    }
    let first = coding.length;
    for (const marker of REDUNDANT) {
        const at = coding.indexOf(marker);
        if (at < first) first = at;
    }
    let prose = coding.slice(0, first).trim();
    if (prose.length === 0) throw new Error('[fix93] profile.coding has no instruction prose before its placeholders');
    if (prose.includes('$NAME')) {
        if (typeof name !== 'string' || name.length === 0) throw new Error('[fix93] $NAME is in the coding instructions but the bot name is missing');
        prose = prose.replaceAll('$NAME', name);
    }
    for (const marker of REDUNDANT) {
        if (prose.includes(marker)) throw new Error(`[fix93] coding instructions still contain ${marker}`);
    }
    return prose;
}

// Ollama 400: {"error":"request (8243 tokens) exceeds the available context size (8192 tokens), try increasing it"}
export function parseContextOverflow(message) {
    if (typeof message !== 'string' || message.length === 0) return null;
    const match = message.match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/);
    if (!match) return null;
    return { requestTokens: Number(match[1]), contextTokens: Number(match[2]) };
}

// fix96: per-message sizes for the overflow error, so the log says what was in the prompt that did not fit.
export function chatSectionSizes(messages) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('[fix96] messages required');
    return messages.map((message) => {
        if (!message || typeof message.role !== 'string') throw new Error('[fix96] chat message role required');
        const content = message.content;
        const size = typeof content === 'string' ? content.length : JSON.stringify(content).length;
        return `${message.role}=${size}`;
    }).join(',');
}
