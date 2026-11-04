// Craft one iron chestplate at the nearby hut crafting table using 8 iron ingots.
// DESCRIPTION: Craft one iron chestplate at the nearby hut crafting table using 8 iron ingots.
async function craftIronChestplate(bot) {
    const countItem = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };

    if (countItem("iron_ingot") < 8) {
        await bot.chat(`Need 8 iron_ingot; have ${countItem("iron_ingot")}.`);
        return;
    }

    const table = bot.findBlock({
        matching: bot.registry.blocksByName.crafting_table.id,
        maxDistance: 16,
    });
    if (!table) {
        await bot.chat("No crafting_table nearby.");
        return;
    }

    const crafted = await skills.craftRecipe(bot, "iron_chestplate");
    if (!crafted) {
        await skills.activateNearestBlock(bot, "crafting_table");
        await skills.wait(bot, 500);
        await bot.chat("craftRecipe FAILED; opened crafting table.");
        return;
    }

    await skills.pickupNearbyItems(bot);
    await bot.chat(`Iron chestplate crafted; iron_ingot left: ${countItem("iron_ingot")}.`);
}
