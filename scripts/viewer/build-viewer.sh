#!/bin/bash
# fix140: rebuild everything the OBS bot viewer serves from viewer-dist/.
#
# What this produces (commit the outputs — patch-package cannot carry the 63MB
# worker bundle in a diff):
#   viewer-dist/index.js          webpack bundle of the patched client (lib/index.js)
#   viewer-dist/worker.js         webpack bundle of the patched chunk mesher
#   viewer-dist/blocksStates/26.1.json, textures/26.1.png, textures/26.1/
#                                 generated 26.1 render data (gen-assets.cjs)
#
# The bundles pick up minecraft-data from this repo's node_modules, so the
# minecraft-data version in the lockfile decides which MC versions the browser
# bundles know. Bump minecraft-data + rerun when the bot moves to a new version
# (also add the version to prismarine-viewer/viewer/lib/version.js supportedVersions
# and regenerate patches: npx patch-package prismarine-viewer).
#
# Requires devDeps: webpack, webpack-cli, assert (+ buffer/process hoisted, as the
# webpack config's ProvidePlugin needs them): npm i -D webpack webpack-cli assert
#
# Note: to regenerate patches/prismarine-viewer+1.33.0.patch afterwards
# (npx patch-package prismarine-viewer), this machine's npm 12 disables remote
# tarball fetching, which patch-package uses — prefix with:
#   npm_config_allow_remote="https://registry.npmjs.org" npx patch-package prismarine-viewer
set -euo pipefail
cd "$(dirname "$0")/../.."   # mindcraft root

VERSIONS="${*:-26.1}"

node scripts/viewer/gen-assets.cjs $VERSIONS

# webpack: -o is resolved against THIS cwd (mindcraft root), which also resets the
# default context — pin --context to the package so the './lib/...' entries resolve.
npx webpack --config node_modules/prismarine-viewer/webpack.config.js \
  --context node_modules/prismarine-viewer -o viewer-dist

ls -la viewer-dist viewer-dist/blocksStates
echo "done: viewer-dist rebuilt for: $VERSIONS"
