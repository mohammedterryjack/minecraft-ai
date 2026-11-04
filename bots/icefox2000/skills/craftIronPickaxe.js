// Craft an iron pickaxe using the 3 iron ingots and sticks in inventory at a nearby crafting table.
// DESCRIPTION: Craft an iron pickaxe using the 3 iron ingots and sticks in inventory at a nearby crafting table.
async function craftIronPickaxe(bot) {
    const success = await skills.craftRecipe(bot, "iron_pickaxe");
    if (success) {
        bot.chat("Successfully crafted an iron pickaxe.");
    } else {
        bot.chat("Failed to craft an iron pickaxe.");
    }
}
