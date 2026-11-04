// Exit water via cobble footing and breaking ceiling stone, surface, then smelt 5 raw_iron at the nearest furnace with coal.
// DESCRIPTION: Exit water via cobble footing and breaking ceiling stone, surface, then smelt 5 raw_iron at the nearest furnace with coal.
async function smeltFiveRawIronAtHutFurnace(bot) {
    const countItem = (name) => {
        const stack = bot.inventory.items().find((i) => i.name === name);
        return stack ? stack.count : 0;
    };

    await skills.pickupNearbyItems(bot);
    await skills.wait(bot, 500);

    if (countItem('raw_iron') < 5) {
        await bot.chat(`Need 5 raw_iron; have ${countItem('raw_iron')}.`);
        return;
    }
    if (countItem('coal') < 1) {
        await bot.chat(`Need coal fuel; have ${countItem('coal')}.`);
        return;
    }

    await skills.equip(bot, 'stone_pickaxe');

    const stone = world.getNearestBlock(bot, 'stone', 6);
    if (stone !== null) {
        const sp = stone.position;
        await skills.placeBlock(bot, 'cobblestone', sp.x, sp.y + 1, sp.z, 'bottom');
        await skills.wait(bot, 400);
    }

    const p = world.getPosition(bot);
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    for (let dy = 1; dy <= 5; dy++) {
        const ty = by + dy;
        const broke = await skills.breakBlockAt(bot, bx, ty, bz);
        if (broke) await skills.wait(bot, 300);
    }
    await skills.pickupNearbyItems(bot);
    await skills.wait(bot, 400);

    const cobbleNear = world.getNearestBlock(bot, 'cobblestone', 6);
    if (cobbleNear !== null) {
        const cp = cobbleNear.position;
        await skills.placeBlock(bot, 'cobblestone', bx, by - 1, bz, 'top');
        await skills.wait(bot, 350);
    }

    let surfaced = await skills.goToSurface(bot);
    if (!surfaced) {
        for (let dy = 0; dy <= 8; dy++) {
            await skills.breakBlockAt(bot, bx, by + 6 + dy, bz);
            await skills.wait(bot, 250);
        }
        await skills.pickupNearbyItems(bot);
        surfaced = await skills.goToSurface(bot);
    }

    let furnace = world.getNearestBlock(bot, 'furnace', 24);
    if (furnace === null) {
        if (countItem('furnace') < 1) {
            if (countItem('cobblestone') >= 8) {
                const table = world.getNearestBlock(bot, 'crafting_table', 24);
                if (table !== null) {
                    let crafted = await skills.craftRecipe(bot, 'furnace');
                    if (!crafted) {
                        await skills.activateNearestBlock(bot, 'crafting_table');
                        await skills.wait(bot, 500);
                        crafted = await skills.craftRecipe(bot, 'furnace');
                    }
                    if (crafted) await skills.pickupNearbyItems(bot);
                }
            }
        }
        if (countItem('furnace') >= 1) {
            const fp = world.getPosition(bot);
            const fx = Math.floor(fp.x);
            const fy = Math.floor(fp.y);
            const fz = Math.floor(fp.z);
            let placed = await skills.placeBlock(bot, 'furnace', fx + 1, fy, fz, 'bottom');
            if (!placed) placed = await skills.placeBlock(bot, 'furnace', fx, fy, fz + 1, 'bottom');
            await skills.wait(bot, 500);
        }
        furnace = world.getNearestBlock(bot, 'furnace', 24);
    }

    if (furnace === null) {
        await bot.chat('No furnace reachable after surfacing.');
        return;
    }

    await skills.activateNearestBlock(bot, 'furnace');
    await skills.wait(bot, 800);

    const ingotsBefore = countItem('iron_ingot');
    const targetIngots = ingotsBefore + 5;

    let success = await skills.smeltItem(bot, 'raw_iron', 5);
    if (!success) {
        await skills.activateNearestBlock(bot, 'furnace');
        await skills.wait(bot, 1000);
        success = await skills.smeltItem(bot, 'raw_iron', 5);
    }
    if (!success) {
        await bot.chat('smeltItem FAILED after surfacing; stand by furnace.');
        return;
    }

    for (let i = 0; i < 30; i++) {
        await skills.wait(bot, 1000);
        await skills.pickupNearbyItems(bot);
        if (countItem('raw_iron') === 0 && countItem('iron_ingot') >= targetIngots) break;
        if (countItem('raw_iron') > 0) {
            await skills.activateNearestBlock(bot, 'furnace');
            await skills.wait(bot, 400);
        }
    }

    await skills.pickupNearbyItems(bot);
    await bot.chat(
        `Done: raw_iron=${countItem('raw_iron')} iron_ingot=${countItem('iron_ingot')} (want 0 and ${targetIngots}).`
    );
}
