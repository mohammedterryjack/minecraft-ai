// Equip iron or stone pickaxe and mine nearby stone until inventory holds 8 cobblestone.
// DESCRIPTION: Equip iron or stone pickaxe and mine nearby stone until inventory holds 8 cobblestone.
async function mineEightCobblestone(bot) {
    const target = 8;
    const cobbleCount = () => {
        const stack = bot.inventory.items().find(i => i.name === 'cobblestone');
        return stack ? stack.count : 0;
    };

    let pickaxe = bot.inventory.items().find(i => i.name === 'iron_pickaxe');
    if (!pickaxe) pickaxe = bot.inventory.items().find(i => i.name === 'stone_pickaxe');
    if (pickaxe) await bot.equip(pickaxe, 'hand');

    const stoneId = bot.registry.blocksByName.stone.id;

    while (cobbleCount() < target) {
        const positions = bot.findBlocks({ matching: stoneId, maxDistance: 16, count: 20 });
        if (positions.length === 0) break;

        let broke = false;
        for (const pos of positions) {
            if (cobbleCount() >= target) break;
            if (await skills.breakBlockAt(bot, pos.x, pos.y, pos.z)) {
                broke = true;
                await skills.wait(bot, 300);
            }
        }
        await skills.pickupNearbyItems(bot);
        if (!broke) break;
    }
}
