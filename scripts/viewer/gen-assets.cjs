// fix140: generate viewer static data for versions that prismarine-viewer's shipped
// public/ does not carry (we serve it from viewer-dist/, see build-viewer.sh and the
// prismarine-viewer+1.33.0.patch static-override in lib/mineflayer.js).
//
// Mirrors node_modules/prismarine-viewer/viewer/prerender.js — one version at a time,
// output into viewer-dist/ instead of the package's public/:
//   textures/<v>.png            block atlas (node-canvas)
//   blocksStates/<v>.json       per-state models + atlas UVs (modelsBuilder)
//   textures/<v>/**             raw per-block/item textures (dropped-item icons, entities)
//
// Source of data: minecraft-assets (node_modules/minecraft-assets/minecraft-assets/data/<v>).
// The version MUST also be in prismarine-viewer/viewer/lib/version.js supportedVersions,
// or the client's getVersion() will alert "not supported" — both lists moving together is
// the point; silently rendering 26.1 with 1.21.x ids would show wrong blocks.
//
// Usage: node scripts/viewer/gen-assets.js 26.1
'use strict'
const path = require('path')
const fs = require('fs')
const { makeTextureAtlas } = require('prismarine-viewer/viewer/lib/atlas')
const { prepareBlocksStates } = require('prismarine-viewer/viewer/lib/modelsBuilder')
const mcAssets = require('minecraft-assets')

const versions = process.argv.slice(2)
if (versions.length === 0) {
  console.error('usage: node scripts/viewer/gen-assets.js <version> [version...]')
  process.exit(1)
}

const root = path.resolve(__dirname, '..', '..')
const dist = path.join(root, 'viewer-dist')

// MC 26.1 model JSON allows object texture references, {"sprite": "minecraft:block/x",
// "force_translucent": true}; modelsBuilder (viewer 1.33) only understands the pre-1.21
// string form. minecraft-assets 1.19.0 ships 26.1 data verbatim, so normalize object
// refs to their sprite string before feeding modelsBuilder. force_translucent is
// dropped: the viewer handles translucency via blocksStates alpha, not this flag.
function normalizeSpriteRefs (node) {
  if (!node || typeof node !== 'object') return node
  if (!Array.isArray(node) && typeof node.sprite === 'string') return node.sprite
  for (const key of Object.keys(node)) node[key] = normalizeSpriteRefs(node[key])
  return node
}

for (const version of versions) {
  const assets = mcAssets(version)
  if (!assets) {
    console.error(`minecraft-assets has no data for ${version} — cannot generate viewer assets`)
    process.exit(1)
  }
  console.log(`${version}: assets from ${assets.directory}`)
  normalizeSpriteRefs(assets.blocksModels)
  normalizeSpriteRefs(assets.blocksStates)

  const atlas = makeTextureAtlas(assets)
  fs.mkdirSync(path.join(dist, 'textures'), { recursive: true })
  fs.mkdirSync(path.join(dist, 'blocksStates'), { recursive: true })

  fs.writeFileSync(path.join(dist, 'textures', version + '.png'), atlas.image)
  fs.writeFileSync(path.join(dist, 'blocksStates', version + '.json'), JSON.stringify(prepareBlocksStates(assets, atlas)))
  fs.cpSync(assets.directory, path.join(dist, 'textures', version), { recursive: true, force: true })

  console.log(`${version}: wrote textures/${version}.png, blocksStates/${version}.json, textures/${version}/`)
}
