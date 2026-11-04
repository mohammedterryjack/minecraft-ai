// Return true if x,z is within maxRange (default 48) of the bot and far (>200) from the players' village at -800,500.
// DESCRIPTION: Return true if x,z is within maxRange (default 48) of the bot and far (>200) from the players' village at -800,500.
function isSafeTarget(bot, x, z, maxRange = 48) {
    const p = bot.entity.position;
    if (Math.hypot(x - p.x, z - p.z) > maxRange) return false;
    return Math.hypot(x - (-800), z - 500) > 200;
}
