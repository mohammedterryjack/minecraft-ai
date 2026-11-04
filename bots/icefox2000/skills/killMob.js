// Kill count mobs of mobType within 48 blocks (never near the players' village), equipping the best sword first, then pick up drops; returns how many were killed.
// DESCRIPTION: Kill count mobs of mobType within 48 blocks (never near the players' village), equipping the best sword first, then pick up drops; returns how many were killed.
async function killMob(bot, mobType, count = 1) {
    let killed = 0;
    for (let i = 0; i < count * 2 && killed < count; i++) {
        if (bot.interrupt_code) return killed;
        const e = bot.nearestEntity(en => en.name === mobType && en.position.distanceTo(bot.entity.position) <= 48);
        if (!e || !(await isSafeTarget(bot, e.position.x, e.position.z, 48))) break;
        if (!(await equipBestTool(bot, 'sword'))) await equipBestTool(bot, 'axe');
        if (bot.interrupt_code) return killed;
        if (await skills.attackEntity(bot, e, true)) killed++;
        await skills.pickupNearbyItems(bot);
    }
    return killed;
}
