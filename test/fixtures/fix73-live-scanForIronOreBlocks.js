// When no ore is visible nearby, travel to an exploratory offset and pick up dropped items.
async function scanForIronOreBlocks(bot) {
    if (bot.interrupt_code) return [];
    const blocks = getNearestBlocks(bot, ['iron_ore', 'deepslate_iron_ore'], 128, 20);
    return blocks && blocks.length ? blocks : [];
}
