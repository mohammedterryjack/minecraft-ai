// Walk to the nearest block of a type (chest, furnace, crafting_table, door) within range, opening doors on the way, and right-click/activate it; returns the block or null.
// DESCRIPTION: Walk to the nearest block of blockName within range and activate it; returns the block or null.
async function goToBlockAndInteract(bot, blockName, range = 32) {
    const ok = await skills.goToNearestBlock(bot, blockName, 2, range);
    const block = world.getNearestBlock(bot, blockName, 4);
    if (!ok || !block) return null;
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
    if (!blockName.includes('chest') && !blockName.includes('furnace')) await bot.activateBlock(block);
    return block;
}
