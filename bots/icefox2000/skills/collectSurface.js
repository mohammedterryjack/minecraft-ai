// Collect count of a surface block (dirt, sand, gravel, clay, sugar_cane, cactus, bamboo, pumpkin, melon, flowers) with the right tool; returns items gained.
// DESCRIPTION: Collect count of a surface block (dirt, sand, gravel, clay, sugar_cane, cactus, bamboo, pumpkin, melon, flowers) with the right tool; returns items gained.
async function collectSurface(bot, blockName, count = 1) {
    const tool = /sand|dirt|gravel|clay|grass|snow/.test(blockName) ? 'shovel' : /pumpkin|melon|bamboo/.test(blockName) ? 'axe' : null;
    if (tool) await equipBestTool(bot, tool);
    if (bot.interrupt_code) return 0;
    return await mineBlocks(bot, blockName, count);
}
