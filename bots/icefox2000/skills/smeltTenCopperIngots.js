// Smelt 10 raw_copper into copper_ingot at the nearby hut furnace using coal fuel.
// DESCRIPTION: Smelt 10 raw_copper into copper_ingot at the nearby hut furnace using coal fuel.
async function smeltTenCopperIngots(bot) {
    const countItem = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };

    if (countItem('raw_copper') < 10) {
        await bot.chat(`Need 10 raw_copper; have ${countItem('raw_copper')}.`);
        return;
    }
    if (countItem('coal') < 1) {
        await bot.chat(`Need coal fuel; have ${countItem('coal')}.`);
        return;
    }

    const furnace = world.getNearestBlock(bot, 'furnace', 16);
    if (furnace === null) {
        await bot.chat('No furnace within 16 blocks.');
        return;
    }

    const ingotsBefore = countItem('copper_ingot');
    const success = await skills.smeltItem(bot, 'raw_copper', 10);
    if (!success) {
        await skills.activateNearestBlock(bot, 'furnace');
        await skills.wait(bot, 500);
        await bot.chat('smeltItem FAILED; opened nearest furnace — retry with furnace reachable.');
        return;
    }

    await skills.pickupNearbyItems(bot);
    const ingotsAfter = countItem('copper_ingot');
    await bot.chat(`Smelted raw_copper: copper_ingot ${ingotsBefore} -> ${ingotsAfter} (target 10 ingots).`);
}
