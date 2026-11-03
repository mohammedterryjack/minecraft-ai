#!/bin/sh
# Native (no Docker) launcher used on the iMac by launchd (com.mo.icefox). Secrets come from the gitignored .env.
cd "$(dirname "$0")" || exit 1
set -a; . ./.env; set +a
export MINECRAFT_HOST="${MINECRAFT_HOST:-127.0.0.1}" MINECRAFT_PORT="${MINECRAFT_PORT:-25568}"
export PATH="$HOME/MinecraftBot/node20/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p logs
exec node --max-old-space-size=768 main.js >> logs/mindcraft.log 2>&1
