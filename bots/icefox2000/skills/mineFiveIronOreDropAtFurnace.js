// Mine iron_ore until inventory gains 5 raw iron, then toss raw iron at the hut furnace.
// DESCRIPTION: Mine iron_ore until inventory gains 5 raw iron, then toss raw iron at the hut furnace.
async function mineFiveIronOreDropAtFurnace(bot) {
    await skills.equip(bot, 'iron_pickaxe');

    const countIronDrops = () =>
        bot.inventory.items()
            .filter(i => i.name === 'raw_iron' || i.name === 'iron_ore')
            .reduce((sum, i) => sum + i.count, 0);

    const startCount = countIronDrops();
    const needTotal = startCount + 5;
    const ironOreId = bot.registry.blocksByName.iron_ore.id;
    let breakAttempts = 0;
    const maxBreakAttempts = 28;

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
            await bot.chat('No nearby iron_ore; partial drop at furnace.');
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
    await bot.chat(`Iron drops: ${countIronDrops()} total (+${gained}); target +5.`);

    const furnace = world.getNearestBlock(bot, 'furnace', 16);
    if (furnace === null) {
        await bot.chat('No furnace within 16 blocks; keeping raw iron in inventory.');
        return;
    }

    await skills.activateNearestBlock(bot, 'furnace');
    await skills.wait(bot, 300);

    const ironStacks = bot.inventory.items().filter(
        i => i.name === 'raw_iron' || i.name === 'iron_ore'
    );
    for (const stack of ironStacks) {
        await bot.tossStack(stack);
        await skills.wait(bot, 200);
    }

    await bot.chat('Dropped raw iron at hut furnace for smelting.');
}
