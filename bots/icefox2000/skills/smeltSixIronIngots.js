// Define missing smelt helper then craft one shield at the birch hut crafting table.
// DESCRIPTION: Define missing smelt helper then craft one shield at the birch hut crafting table.
async function smeltSixIronIngots(bot) {
    const countItem = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };
    if (countItem("raw_iron") < 6) return;
    await skills.smeltItem(bot, "raw_iron", 6);
    await skills.pickupNearbyItems(bot);
}

async function craftShield(bot) {
    const countItem = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };

    if (countItem("birch_planks") < 6) {
        await bot.chat(`Need 6 birch_planks; have ${countItem("birch_planks")}.`);
        return;
    }
    if (countItem("iron_ingot") < 1) {
        await bot.chat(`Need 1 iron_ingot; have ${countItem("iron_ingot")}.`);
        return;
    }

    const table = world.getNearestBlock(bot, "crafting_table", 16);
    if (table === null) {
        await bot.chat("No crafting_table within 16 blocks.");
        return;
    }

    const shieldsBefore = countItem("shield");
    const planksBefore = countItem("birch_planks");
    const crafted = await skills.craftRecipe(bot, "shield");
    if (!crafted) {
        await skills.activateNearestBlock(bot, "crafting_table");
        await skills.wait(bot, 500);
        await bot.chat("craftRecipe FAILED; opened crafting table — stand adjacent and retry.");
        return;
    }

    await skills.pickupNearbyItems(bot);
    await bot.chat(
        `Shield ${shieldsBefore} -> ${countItem("shield")}; birch_planks ${planksBefore} -> ${countItem("birch_planks")}.`
    );
}
