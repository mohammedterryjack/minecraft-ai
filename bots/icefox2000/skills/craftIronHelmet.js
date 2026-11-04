// Craft one iron helmet at the nearby crafting table using 5 iron ingots.
// DESCRIPTION: Craft one iron helmet at the nearby crafting table using 5 iron ingots.
async function craftIronHelmet(bot) {
    const countItem = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };

    if (countItem("iron_ingot") < 5) {
        await bot.chat(`Need 5 iron_ingot; have ${countItem("iron_ingot")}.`);
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

    const crafted = await skills.craftRecipe(bot, "iron_helmet");
    if (!crafted) {
        await skills.activateNearestBlock(bot, "crafting_table");
        await skills.wait(bot, 500);
        await bot.chat("craftRecipe FAILED; opened crafting table.");
        return;
    }

    await skills.pickupNearbyItems(bot);
    await bot.chat(`Iron helmet crafted; iron_ingot left: ${countItem("iron_ingot")}.`);
}
