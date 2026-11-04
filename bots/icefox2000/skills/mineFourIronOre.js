// Mine iron_ore until inventory gains 4 raw_iron, picking up drops after each break.
// DESCRIPTION: Mine iron_ore until inventory gains 4 raw_iron, picking up drops after each break.
async function mineFourIronOre(bot) {
    const ironPickaxe = bot.inventory.items().find(item => item.name === 'iron_pickaxe');
    if (!ironPickaxe) {
        await bot.chat('Error: No iron_pickaxe found in inventory.');
        return;
    }
    await bot.equip(ironPickaxe, 'hand');

    const countIronDrops = () =>
        bot.inventory.items()
            .filter(i => i.name === 'raw_iron' || i.name === 'iron_ore')
            .reduce((sum, i) => sum + i.count, 0);

    const startCount = countIronDrops();
    const needTotal = startCount + 4;
    const ironOreId = bot.registry.blocksByName.iron_ore.id;
    let breakAttempts = 0;
    const maxBreakAttempts = 24;

    while (countIronDrops() < needTotal && breakAttempts < maxBreakAttempts) {
        const orePositions = bot.findBlocks({
            matching: ironOreId,
            maxDistance: 16,
            count: 12
        });

        if (orePositions.length === 0) {
            await skills.pickupNearbyItems(bot);
            await skills.wait(bot, 400);
            if (countIronDrops() >= needTotal) break;
            await bot.chat('No nearby iron_ore left; waiting on drops.');
            break;
        }

        let progressed = false;
        for (const pos of orePositions) {
            if (countIronDrops() >= needTotal) break;
            breakAttempts++;
            const success = await skills.breakBlockAt(bot, pos.x, pos.y, pos.z);
            if (success) {
                progressed = true;
                await skills.wait(bot, 350);
                await skills.pickupNearbyItems(bot);
                await skills.wait(bot, 250);
                await skills.pickupNearbyItems(bot);
            }
            if (countIronDrops() >= needTotal) break;
        }

        if (!progressed) {
            await skills.pickupNearbyItems(bot);
            await skills.wait(bot, 500);
        }
    }

    await skills.pickupNearbyItems(bot);
    const gained = countIronDrops() - startCount;
    await bot.chat(`Iron drops: ${countIronDrops()} total (+${gained}); need +4.`);
}
