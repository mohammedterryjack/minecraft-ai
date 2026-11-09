#!/bin/sh
# Native (no Docker) launcher used on the iMac by launchd (com.mo.icefox). Secrets come from the gitignored .env.
cd "$(dirname "$0")" || exit 1
set -a; . ./.env; set +a
export MINECRAFT_HOST="${MINECRAFT_HOST:-127.0.0.1}" MINECRAFT_PORT="${MINECRAFT_PORT:-25568}"
export PATH="$HOME/MinecraftBot/node20/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p logs
# fix94: .env may set BACKEND_LOG_DIR (sourced above). No ${:-} default — settings.js holds
# the iMac path /Users/mohammedterry-jack/MinecraftServer/logs, and a missing setting throws.
if [ -n "$BACKEND_LOG_DIR" ]; then
  export BACKEND_LOG_DIR
fi
# fix94: exec keeps the node status. Exit 75 (EX_TEMPFAIL) is the one backend-ready respawn.
# Exit 0 stays a successful exit (KeepAlive SuccessfulExit false does not restart it).
# A crash stays nonzero. Do not remap statuses.
exec node --max-old-space-size=768 main.js >> logs/mindcraft.log 2>&1
