// Make sure a chest is within 32 blocks; otherwise craft one and place it on a valid spot (solid below, air at target and above, not where the bot stands), retrying up to 6 nearby spots; returns true if one is available.
// DESCRIPTION: Make sure a chest is within 32 blocks; otherwise craft one and place it on a valid spot (solid below, air at target and above, not where the bot stands), retrying up to 6 nearby spots; returns true if one is available.
async function ensureChest(bot) {
    if (world.getNearestBlock(bot, 'chest', 32)) return true;
    if (!world.getInventoryCounts(bot).chest) {
        if (!(await craftPlanks(bot, 8)) || bot.interrupt_code) return false;
        if (!(await ensureCraftingTable(bot)) || bot.interrupt_code) return false;
        if (!(await craftItem(bot, 'chest', 1))) return false;
    }
    const me = bot.entity.position.floored();
    const spots = [];
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 1; dy++) {
        const p = me.offset(dx, dy, dz);
        if (Math.abs(dx) + Math.abs(dz) < 2) continue;                       // not inside / right next to the bot
        const at = bot.blockAt(p), above = bot.blockAt(p.offset(0, 1, 0)), below = bot.blockAt(p.offset(0, -1, 0));
        if (!at || !above || !below) continue;
        if (at.name !== 'air' || above.name !== 'air' || below.boundingBox !== 'block') continue;
        spots.push(p);
    }
    spots.sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
    for (const p of spots.slice(0, 6)) {
        if (bot.interrupt_code) return false;
        await skills.placeBlock(bot, 'chest', p.x, p.y, p.z);
        if (bot.blockAt(p)?.name === 'chest') { console.log(`[chest] placed chest at ${p.x},${p.y},${p.z}`); return true; }
        console.log(`[chest] placing chest at ${p.x},${p.y},${p.z} failed; trying next spot`);
    }
    console.log(`[chest] FAILED to place a chest (${spots.length} candidate spots)`);
    return false;
}
