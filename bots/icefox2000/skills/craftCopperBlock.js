// Craft one copper_block at a nearby crafting table using nine copper_ingots in a 3x3 grid.
// DESCRIPTION: Craft one copper_block at a nearby crafting table using nine copper_ingots in a 3x3 grid.
async function craftCopperBlock(bot) {
    const countItem = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };

    if (countItem('copper_ingot') < 9) {
        await bot.chat(`Need 9 copper_ingot; have ${countItem('copper_ingot')}.`);
        return;
    }

    const table = world.getNearestBlock(bot, 'crafting_table', 16);
    if (table === null) {
        await bot.chat('No crafting_table within 16 blocks.');
        return;
    }

    const blocksBefore = countItem('copper_block');
    const ingotsBefore = countItem('copper_ingot');
    const crafted = await skills.craftRecipe(bot, 'copper_block');
    if (!crafted) {
        await skills.activateNearestBlock(bot, 'crafting_table');
        await skills.wait(bot, 500);
        await bot.chat('craftRecipe FAILED; opened crafting table — stand adjacent and retry.');
        return;
    }

    await skills.pickupNearbyItems(bot);
    await bot.chat(
        `copper_block ${blocksBefore} -> ${countItem('copper_block')}; copper_ingot ${ingotsBefore} -> ${countItem('copper_ingot')}.`
    );
}
