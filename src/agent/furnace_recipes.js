// fix97: Java PC minecraft-data recipes are crafting only (inShape / ingredients, no furnace type).
// The same package ships furnace recipes on the bedrock recipe tables, keyed by item name
// (mutton -> cooked_mutton, sand -> glass). Names that exist in the caller's registry are the smelt edges.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
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
    loaded = { version, byOutput, recipes: data.recipes };
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

// fix97: coal, charcoal, and the pre-flattening plank item are fuels. Logs and wood arrive as the
// charcoal furnace recipe's inputs (log, log2, wood, and the Java names the recipe already uses).
// https://minecraft.wiki/w/Smelting#Fuel — coal, charcoal, logs, wood, and planks.
const FUEL_CATEGORIES = ['coal', 'charcoal', 'planks'];

let legacyIds = null;
let legacyTables = null;
let bedrockByOutput = null;

function pcDataRoot() {
    return path.join(path.dirname(require.resolve('minecraft-data/package.json')), 'minecraft-data', 'data', 'pc');
}

function compareVersions(a, b) {
    const pa = a.split('.').map(n => Number(n));
    const pb = b.split('.').map(n => Number(n));
    const n = pa.length > pb.length ? pa.length : pb.length;
    for (let i = 0; i < n; i++) {
        const da = i < pa.length ? pa[i] : 0;
        const db = i < pb.length ? pb[i] : 0;
        if (da !== db) return da - db;
    }
    return 0;
}

// The numeric id from the newest PC items.json that still has this name (log is 17 until 1.13 drops it).
function legacyItemId(name) {
    if (!legacyIds) {
        const root = pcDataRoot();
        const versions = readdirSync(root).filter(dir => /^\d+\.\d+/.test(dir)).sort(compareVersions);
        const current = new Map();
        const frozen = new Map();
        for (const ver of versions) {
            const file = path.join(root, ver, 'items.json');
            if (!existsSync(file)) continue;
            const items = JSON.parse(readFileSync(file, 'utf8'));
            if (!Array.isArray(items)) throw new Error(`[fix97] ${file} is not an item array`);
            const names = new Set();
            for (const it of items) {
                if (!it || typeof it.name !== 'string' || typeof it.id !== 'number') continue;
                names.add(it.name);
                current.set(it.name, it.id);
            }
            for (const held of [...current.keys()]) {
                if (!names.has(held)) {
                    frozen.set(held, current.get(held));
                    current.delete(held);
                }
            }
        }
        legacyIds = frozen;
    }
    return legacyIds.has(name) ? legacyIds.get(name) : null;
}

function modernNamesForId(id) {
    if (!legacyTables) {
        const file = path.join(pcDataRoot(), 'common', 'legacy.json');
        const legacy = JSON.parse(readFileSync(file, 'utf8'));
        if (!legacy.items || typeof legacy.items !== 'object' || !legacy.blocks || typeof legacy.blocks !== 'object') {
            throw new Error('[fix97] LOUD: minecraft-data pc/common/legacy.json has no items and blocks maps');
        }
        legacyTables = [legacy.items, legacy.blocks];
    }
    const prefix = `${id}:`;
    const out = new Set();
    for (const table of legacyTables) {
        for (const [key, value] of Object.entries(table)) {
            if (!key.startsWith(prefix)) continue;
            const meta = key.slice(prefix.length);
            if (!/^\d+$/.test(meta)) continue;
            if (typeof value !== 'string' || value.length === 0) throw new Error(`[fix97] legacy.json ${key} is not an item name`);
            const bare = value.replace(/^minecraft:/, '').replace(/\[.*\]$/, '');
            if (bare.length === 0) throw new Error(`[fix97] legacy.json ${key} flattened to an empty name (${value})`);
            out.add(bare);
        }
    }
    return [...out];
}

// A bedrock recipe keeps the legacy output name and puts the Java name on recipe.name
// (output "wood" / name "minecraft:oak_wood"). Names absent from the Java registry are dropped by the caller.
function bedrockJavaNames(legacyName) {
    if (!bedrockByOutput) {
        const map = new Map();
        for (const recipe of Object.values(loadFurnaceRecipes().recipes)) {
            if (!recipe || typeof recipe.name !== 'string' || !Array.isArray(recipe.output)) continue;
            const bare = recipe.name.replace(/^minecraft:/, '');
            for (const output of recipe.output) {
                if (!output || typeof output.name !== 'string' || output.name.length === 0) continue;
                if (bare.length === 0 || bare === output.name) continue;
                if (!map.has(output.name)) map.set(output.name, new Set());
                map.get(output.name).add(bare);
            }
        }
        bedrockByOutput = map;
    }
    return bedrockByOutput.has(legacyName) ? [...bedrockByOutput.get(legacyName)] : [];
}

function javaNamesFor(name, registry) {
    if (Object.hasOwn(registry.itemsByName, name)) return [name];
    const id = legacyItemId(name);
    if (id !== null) return modernNamesForId(id).filter(n => Object.hasOwn(registry.itemsByName, n));
    return bedrockJavaNames(name).filter(n => Object.hasOwn(registry.itemsByName, n));
}

// Java item names that can fuel a furnace: charcoal-recipe inputs (logs and wood, legacy names
// mapped through minecraft-data) plus coal, charcoal, and planks.
export function fuelItemNames(registry) {
    if (!registry || !registry.itemsByName) throw new Error('[fix97] fuelItemNames: registry required');
    const seeds = new Set(furnaceInputsOf('charcoal'));
    for (const category of FUEL_CATEGORIES) seeds.add(category);
    const names = new Set();
    for (const seed of seeds) {
        for (const javaName of javaNamesFor(seed, registry)) names.add(javaName);
    }
    const out = [...names].filter(n => Object.hasOwn(registry.itemsByName, n));
    out.sort();
    return out;
}
