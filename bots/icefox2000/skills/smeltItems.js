// Smelt N raw items (raw_iron, raw_copper, beef...) in the nearest furnace, walking to it first
// DESCRIPTION: Walk to the nearest furnace (within 48 blocks) if any, then smelt count of inputName using coal or other fuel; returns true on success.
async function smeltItems(bot, inputName, count = 1) {
    if (!world.getNearestBlock(bot, 'furnace', 6) && world.getNearestBlock(bot, 'furnace', 48))
        await skills.goToNearestBlock(bot, 'furnace', 2, 48);
    if (bot.interrupt_code) return false;
    return await skills.smeltItem(bot, inputName, count);
}
