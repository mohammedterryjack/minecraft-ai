// Craft 4 sticks from birch_planks using the nearby crafting table.
// DESCRIPTION: Craft 4 sticks from birch_planks using the nearby crafting table.
async function craftFourSticks(bot) {
    // Check if a crafting table is within range
    const craftingTable = bot.findBlock({
        matching: bot.registry.blocksByName.crafting_table.id,
        maxDistance: 16
    });

    if (!craftingTable) {
        await bot.chat("No crafting table found nearby.");
        return;
    }

    // Ensure we have enough birch planks (need 2 to make 4 sticks)
    const birchPlanks = bot.inventory.items().find(item => item.name === 'birch_planks');
    if (!birchPlanks || birchPlanks.count < 2) {
        await bot.chat("Insufficient birch planks in inventory.");
        return;
    }

    // Craft the sticks
    const success = await skills.craftRecipe(bot, "stick");
    
    if (success) {
        await bot.chat("Successfully crafted sticks.");
    } else {
        await bot.chat("Failed to craft sticks.");
    }
}
