// Gather a material until the inventory holds at least `target` of it (logs, cobblestone, dirt, sand...), searching outward in rings; best for collecting/gathering materials.
// DESCRIPTION: Gather an item until the inventory holds at least target of it, searching outward; returns true on success.
async function gatherItem(bot, itemName, target) {
    return await skills.gatherUntil(bot, itemName, target);
}
