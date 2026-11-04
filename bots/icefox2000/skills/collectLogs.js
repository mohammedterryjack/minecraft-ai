// Chop count logs of the nearest tree type (or logType if given) and pick up drops; returns logs gained.
// DESCRIPTION: Chop count logs of the nearest tree type (or logType if given) and pick up drops; returns logs gained.
async function collectLogs(bot, count = 4, logType = null) {
    let type = logType;
    if (!type) {
        const b = world.getNearestBlocksWhere(bot, b => b.name.endsWith('_log') && !b.name.startsWith('stripped'), 32, 1)[0];
        type = b ? b.name : 'birch_log';
    }
    await equipBestTool(bot, 'axe');
    if (bot.interrupt_code) return 0;
    return await mineBlocks(bot, type, count);
}
