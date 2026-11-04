// Equip wooden_pickaxe and mine 3 stone blocks nearby to collect cobblestone.
// DESCRIPTION: Equip wooden_pickaxe and mine 3 stone blocks nearby to collect cobblestone.
async function mineThreeStone(bot) {
    const pickaxe = bot.inventory.items().find(item => item.name === 'wooden_pickaxe');
    if (pickaxe) {
        await bot.equip(pickaxe, 'hand');
    }

    const stoneId = bot.registry.blocksByName.stone.id;
    const stonePositions = bot.findBlocks({
        matching: stoneId,
        maxDistance: 16,
        count: 10
    });

    let count = 0;
    for (const pos of stonePositions) {
        if (count >= 3) break;
        const success = await skills.breakBlockAt(bot, pos.x, pos.y, pos.z);
        if (success) {
            count++;
            await skills.wait(bot, 300);
        }
    }

    await skills.pickupNearbyItems(bot);
}
