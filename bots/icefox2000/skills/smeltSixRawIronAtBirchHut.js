// Place furnace at the birch hut if none is nearby, then smelt 6 raw_iron into iron_ingot.
// DESCRIPTION: Place furnace at the birch hut if none is nearby, then smelt 6 raw_iron into iron_ingot.
async function smeltSixRawIronAtBirchHut(bot) {
    const countItem = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };

    if (countItem('raw_iron') < 6) {
        await bot.chat(`Need 6 raw_iron; have ${countItem('raw_iron')}.`);
        return;
    }
    if (countItem('coal') < 1) {
        await bot.chat(`Need coal fuel; have ${countItem('coal')}.`);
        return;
    }

    let furnace = world.getNearestBlock(bot, 'furnace', 16);
    if (furnace === null) {
        if (countItem('furnace') < 1) {
            await bot.chat('No furnace nearby and none in inventory.');
            return;
        }
        const p = world.getPosition(bot);
        const fx = Math.floor(p.x);
        const fy = Math.floor(p.y);
        const fz = Math.floor(p.z);
        let placed = await skills.placeBlock(bot, 'furnace', fx + 1, fy, fz, 'bottom');
        if (!placed) placed = await skills.placeBlock(bot, 'furnace', fx - 1, fy, fz, 'bottom');
        if (!placed) placed = await skills.placeBlock(bot, 'furnace', fx, fy, fz + 1, 'bottom');
        await skills.wait(bot, 400);
        furnace = world.getNearestBlock(bot, 'furnace', 16);
        if (furnace === null) {
            await bot.chat('Could not place furnace at hut.');
            return;
        }
    }

    await smeltSixIronIngots(bot);
}
