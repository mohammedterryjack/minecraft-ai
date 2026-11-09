// fix97: Java PC minecraft-data recipes are crafting only (inShape / ingredients, no furnace type).
// The same package ships furnace recipes on the bedrock recipe tables, keyed by item name
// (mutton -> cooked_mutton, sand -> glass). Names that exist in the caller's registry are the smelt edges.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcData = require('minecraft-data');

let loaded = null;

function loadFurnaceRecipes() {
    if (loaded) return loaded;
    const versions = mcData.versions.bedrock.map(v => v.minecraftVersion);
    let data = null;
    let version = null;
    for (const minecraftVersion of versions) {
        const candidate = mcData(`bedrock_${minecraftVersion}`);
        if (!candidate || !candidate.recipes) continue;
        const recipes = Object.values(candidate.recipes);
        if (!recipes.some(r => r && r.type === 'furnace')) continue;
        data = candidate;
        version = minecraftVersion;
        break;
    }
    if (!data) throw new Error('[fix97] LOUD: minecraft-data has no furnace recipes (PC recipes.json has no furnace type, and no bedrock recipes.json with type furnace was found)');
    const byOutput = new Map();
    for (const recipe of Object.values(data.recipes)) {
        if (!recipe || recipe.type !== 'furnace') continue;
        if (!Array.isArray(recipe.output) || recipe.output.length === 0 || typeof recipe.output[0].name !== 'string' || recipe.output[0].name.length === 0) {
            throw new Error(`[fix97] furnace recipe has no output name: ${JSON.stringify(recipe)}`);
        }
        if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0 || typeof recipe.ingredients[0].name !== 'string' || recipe.ingredients[0].name.length === 0) {
            throw new Error(`[fix97] furnace recipe has no ingredient name: ${JSON.stringify(recipe)}`);
        }
        const output = recipe.output[0].name;
        const input = recipe.ingredients[0].name;
        if (!byOutput.has(output)) byOutput.set(output, []);
        const inputs = byOutput.get(output);
        if (!inputs.includes(input)) inputs.push(input);
    }
    if (byOutput.size === 0) throw new Error('[fix97] LOUD: furnace recipes were found but none had an output');
    loaded = { version, byOutput };
    return loaded;
}

// Inputs of the furnace recipe for `output`, in the order the game data lists them. Empty when the data has no furnace recipe.
export function furnaceInputsOf(output) {
    if (typeof output !== 'string' || output.length === 0) throw new Error('[fix97] furnaceInputsOf: item name required');
    const { byOutput } = loadFurnaceRecipes();
    if (!byOutput.has(output)) return [];
    return [...byOutput.get(output)];
}

export function furnaceRecipeVersion() {
    return loadFurnaceRecipes().version;
}
