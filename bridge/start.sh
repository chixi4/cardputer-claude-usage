#!/bin/bash
# start.sh - Start the Claude Usage Bridge server
# Usage: ./start.sh [port]
# Default port: 8787

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8787}"
export PORT

cd "$SCRIPT_DIR"

# Ensure dependencies
if [ ! -d "node_modules" ]; then
  echo "[start] Installing dependencies..."
  npm install
fi

echo "[start] Starting Claude Usage Bridge on port $PORT..."
echo "[start] Dashboard: http://localhost:$PORT/"
echo "[start] API:       http://localhost:$PORT/api/usage"
echo ""

exec node index.js
