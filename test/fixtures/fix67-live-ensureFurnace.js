async function ensureFurnace(bot) {
    if (bot.interrupt_code) return false;
    if (getNearestBlock(bot, 'furnace', 16)) return true;

    const inv = () => getInventoryCounts(bot);
    if (!inv().furnace) {
        const need = 8 - (inv().cobblestone || 0);
        if (need > 0) await mineOre(bot, 'stone', need);
        if (bot.interrupt_code || (inv().cobblestone || 0) < 8) return false;
        if (!(await ensureCraftingTable(bot)) || bot.interrupt_code) return false;
        const table = getNearestBlock(bot, 'crafting_table', 16);
        if (table) {
            await goToNearestBlock(bot, 'crafting_table', 2, 16);
            if (bot.interrupt_code) return false;
        }
        if (!(await craftItem(bot, 'furnace', 1))) return false;
    }

    if (bot.interrupt_code) return false;
    if (getNearestBlock(bot, 'furnace', 16)) return true;

    await equip(bot, 'furnace');
    if (bot.interrupt_code) return false;

    const bad = new Set(['-72,78,52', '-73,78,53']);
    let spaces = getAllFreeSpaces(bot, 1, 12, 12);
    if (!spaces || spaces.length === 0) {
        const one = getNearestFreeSpace(bot, 1, 12);
        spaces = one ? [one] : [];
    }

    const standDirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = 0; i < Math.min(spaces.length, 10); i++) {
        if (bot.interrupt_code) return false;
        const s = spaces[i];
        const key = `${Math.floor(s.x)},${Math.floor(s.y)},${Math.floor(s.z)}`;
        if (bad.has(key)) continue;

        const botPos = getPosition(bot);
        const by = Math.floor(s.y) - 1;
        const below = getBlockAtPosition(
            bot,
            Math.floor(s.x) - Math.floor(botPos.x),
            by - Math.floor(botPos.y),
            Math.floor(s.z) - Math.floor(botPos.z)
        );
        if (!below || below.name === 'air' || below.name === 'water' || below.name === 'lava') continue;

        let placed = false;
        for (let d = 0; d < standDirs.length && !placed; d++) {
            if (bot.interrupt_code) return false;
            const [dx, dz] = standDirs[d];
            await goToPosition(bot, s.x + dx, s.y, s.z + dz, 1);
            if (bot.interrupt_code) return false;
            const at = getBlockAtPosition(
                bot,
                Math.floor(s.x) - Math.floor(getPosition(bot).x),
                Math.floor(s.y) - Math.floor(getPosition(bot).y),
                Math.floor(s.z) - Math.floor(getPosition(bot).z)
            );
            if (at && at.name !== 'air') continue;
            await placeBlock(bot, 'furnace', Math.floor(s.x), Math.floor(s.y), Math.floor(s.z), 'bottom');
            if (bot.interrupt_code) return false;
            if (getNearestBlock(bot, 'furnace', 16)) return true;
        }
    }

    return !!getNearestBlock(bot, 'furnace', 16);
}
