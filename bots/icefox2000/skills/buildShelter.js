// Get safe for the night: sleep in a bed or wall in with blocks
// DESCRIPTION: Make the bot safe right now by sleeping in a nearby bed or walling itself in with blocks; returns true when sheltered.
async function buildShelter(bot) {
    return await skills.shelterNow(bot);
}
