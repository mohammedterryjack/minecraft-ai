// Mine and collect `count` blocks of a block type (e.g. iron_ore, coal_ore, stone, birch_log, copper_ore) near the bot, with pathfinding, tool choice, junk dropping when inventory is full and drop pickup; returns how many items were gained.
// DESCRIPTION: Mine and collect count blocks of blockName nearby (ores, stone, logs), picking up drops; returns items gained.
async function mineBlocks(bot, blockName, count = 1) {
    const total = () => bot.inventory.items().reduce((a, i) => a + i.count, 0);
    const start = total();
    await skills.collectBlock(bot, blockName, count);
    await skills.pickupNearbyItems(bot);
    const gained = total() - start;
    return gained;
}
