// Craft one chest from birch planks at the nearby crafting table and place it inside the birch hut.
// DESCRIPTION: Craft one chest from birch planks at the nearby crafting table and place it inside the birch hut.
async function craftAndPlaceChestInHut(bot) {
    const planks = bot.inventory.items().find((item) => item.name === "birch_planks");
    if (!planks || planks.count < 8) {
        await bot.chat("Need at least 8 birch_planks to craft a chest.");
        return;
    }

    const table = bot.findBlock({
        matching: bot.registry.blocksByName.crafting_table.id,
        maxDistance: 16,
    });
    if (!table) {
        await bot.chat("No crafting_table nearby.");
        return;
    }

    const crafted = await skills.craftRecipe(bot, "chest");
    if (!crafted) {
        await bot.chat("Failed to craft chest.");
        return;
    }

    await skills.pickupNearbyItems(bot);
    await skills.wait(bot, 300);

    const hutSpots = [
        { x: -1503, y: 63, z: 547 },
        { x: -1504, y: 63, z: 547 },
        { x: -1503, y: 63, z: 546 },
        { x: -1504, y: 63, z: 546 },
    ];

    for (const spot of hutSpots) {
        const floor = bot.blockAt(new Vec3(spot.x, spot.y - 1, spot.z));
        if (!floor || floor.name === "air" || floor.name === "water") continue;
        const here = bot.blockAt(new Vec3(spot.x, spot.y, spot.z));
        if (here && here.name !== "air") continue;
        const placed = await skills.placeBlock(bot, "chest", spot.x, spot.y, spot.z, "top");
        if (placed) {
            await bot.chat("Chest placed in birch hut.");
            return;
        }
    }
    await bot.chat("Could not place chest in hut; all spots failed.");
}
