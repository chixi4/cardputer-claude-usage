#!/bin/bash
# install.sh - Prepare the local Claude Usage Bridge.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Claude Usage Bridge setup ==="

cd "$SCRIPT_DIR"
npm install

echo ""
echo "Setup complete."
echo ""
echo "Before starting, make sure Claude Code is logged in at least once:"
echo "  claude"
echo ""
echo "Start the bridge:"
echo "  cd $SCRIPT_DIR && ./start.sh"
echo ""
echo "Check it:"
echo "  curl http://localhost:8787/api/status"
echo "  curl http://localhost:8787/api/usage"
