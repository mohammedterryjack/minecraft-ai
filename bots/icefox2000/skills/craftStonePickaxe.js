// Place a crafting table if none is nearby and craft 1 stone_pickaxe.
// DESCRIPTION: Place a crafting table if none is nearby and craft 1 stone_pickaxe.
async function craftStonePickaxe(bot) {
    let craftingTableBlock = bot.findBlock({
        matching: bot.registry.blocksByName.crafting_table.id,
        maxDistance: 16
    });

    if (!craftingTableBlock) {
        const pos = bot.entity.position.floored();
        // Place crafting table adjacent to bot
        let placed = await skills.placeBlock(bot, "crafting_table", pos.x + 1, pos.y, pos.z);
        if (!placed) {
            placed = await skills.placeBlock(bot, "crafting_table", pos.x, pos.y, pos.z + 1);
        }
        await skills.wait(bot, 500);
    }

    await skills.craftRecipe(bot, "stone_pickaxe");
}
