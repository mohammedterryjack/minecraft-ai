// Mine 3 coal_ore blocks using the equipped iron_pickaxe for night survival light sources.
// DESCRIPTION: Mine 3 coal_ore blocks using the equipped iron_pickaxe for night survival light sources.
async function mineThreeCoalOre(bot) {
    // Verify we have the required tool and it is equipped
    const ironPickaxe = bot.inventory.items().find(item => item.name === 'iron_pickaxe');
    if (!ironPickaxe) {
        await bot.chat("Error: No iron_pickaxe found in inventory.");
        return;
    }
    
    // Ensure the iron_pickaxe is equipped
    await bot.equip(ironPickaxe, 'hand');

    // Find nearby coal_ore blocks within range
    const coalOreId = bot.registry.blocksByName['coal_ore'].id;
    const coalPositions = bot.findBlocks({
        matching: coalOreId,
        maxDistance: 16,
        count: 10
    });

    // Check if any coal ore was found
    if (coalPositions.length === 0) {
        await bot.chat("No nearby coal_ore blocks found.");
        return;
    }

    let minedCount = 0;
    for (const pos of coalPositions) {
        if (minedCount >= 3) break; // Stop after mining 3 blocks
        
        const success = await skills.breakBlockAt(bot, pos.x, pos.y, pos.z);
        
        if (success) {
            minedCount++;
            await skills.wait(bot, 200); // Small delay between breaks
        } else {
            await bot.chat(`Failed to break block at ${pos.x}, ${pos.y}, ${pos.z}`);
        }
    }

    // Pick up any dropped items (coal)
    await skills.pickupNearbyItems(bot);
    
    await bot.chat(`Successfully mined ${minedCount} coal_ore blocks.`);
}
