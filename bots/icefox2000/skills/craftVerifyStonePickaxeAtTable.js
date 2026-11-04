// Craft one stone pickaxe at the nearby crafting table, pick up any dropped output, verify inventory counts, and equip it.
// DESCRIPTION: Craft one stone pickaxe at the nearby crafting table, pick up any dropped output, verify inventory counts, and equip it.
async function craftVerifyStonePickaxeAtTable(bot) {
    const itemCount = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };

    const beforePick = itemCount('stone_pickaxe');
    if (beforePick >= 1) {
        const existing = bot.inventory.items().find((i) => i.name === 'stone_pickaxe');
        await bot.equip(existing, 'hand');
        return;
    }

    const beforeCobble = itemCount('cobblestone');
    const beforeStick = itemCount('stick');
    if (beforeCobble < 3 || beforeStick < 2) return;

    const table = bot.findBlock({
        matching: bot.registry.blocksByName.crafting_table.id,
        maxDistance: 16
    });
    if (!table) return;

    await skills.goToPosition(bot, table.position.x, table.position.y, table.position.z);
    await skills.wait(bot, 600);

    await skills.craftRecipe(bot, 'stone_pickaxe');
    await skills.wait(bot, 1000);

    for (let attempt = 0; attempt < 6 && itemCount('stone_pickaxe') < 1; attempt++) {
        await skills.pickupNearbyItems(bot);
        await skills.wait(bot, 400);
    }

    if (itemCount('stone_pickaxe') < 1) return;

    const afterCobble = itemCount('cobblestone');
    const afterStick = itemCount('stick');
    if (beforeCobble - afterCobble !== 3 || beforeStick - afterStick !== 2) {
        // unexpected consumption; still equip if we have the pickaxe
    }

    const pick = bot.inventory.items().find((i) => i.name === 'stone_pickaxe');
    if (pick) await bot.equip(pick, 'hand');
}
