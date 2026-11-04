// Travel to coordinates over long distances (hundreds of blocks), e.g. back to the town or hut
// DESCRIPTION: Travel to x, y, z over any distance in short hops (loads chunks as it goes); returns true on arrival.
async function travelTo(bot, x, y, z) {
    return await skills.travelTo(bot, x, y, z);
}
