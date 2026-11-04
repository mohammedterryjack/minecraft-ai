// Walk to and pick up nearby dropped items (raw_iron, logs, cobblestone) after mining, breaking or killing something.
// DESCRIPTION: Walk to and pick up all nearby dropped items.
async function collectDrops(bot) {
    await skills.pickupNearbyItems(bot);
}
