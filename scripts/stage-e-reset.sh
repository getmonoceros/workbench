#!/usr/bin/env bash
#
# Rebuild the runtime image, tear down any previous stage-e-demo
# solution, scaffold a fresh one and bring up its devcontainer. Used
# during Stage-E walkthroughs of the Test-Plan when we need a clean
# slate without typing the same five commands every time.
#
# Idempotent: safe to re-run even if the previous solution is already
# torn down.
set -euo pipefail

WORKBENCH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX="$WORKBENCH_ROOT/node_modules/.bin/tsx"
CLI_BIN="$WORKBENCH_ROOT/packages/cli/src/bin.ts"
PLAY_DIR="$WORKBENCH_ROOT/.local/play"
SOLUTION_DIR="$PLAY_DIR/stage-e-demo"

monoceros() { "$TSX" "$CLI_BIN" "$@"; }

echo "→ Rebuilding monoceros-runtime:dev …"
docker build --no-cache -t monoceros-runtime:dev "$WORKBENCH_ROOT/images/runtime"

echo
echo "→ Tearing down previous stage-e-demo (if any) …"
mkdir -p "$PLAY_DIR"
if [ -d "$SOLUTION_DIR/.devcontainer" ]; then
  (cd "$SOLUTION_DIR" && monoceros down --volumes) || true
fi
rm -rf "$SOLUTION_DIR"

echo
echo "→ Creating fresh stage-e-demo solution …"
(cd "$PLAY_DIR" && monoceros create stage-e-demo --languages=node --services=postgres)

echo
echo "→ Starting devcontainer …"
(cd "$SOLUTION_DIR" && monoceros start)

echo
echo "✓ Stage-E reset done. Solution at: $SOLUTION_DIR"
echo "  Next: open VS Code at that path and 'Reopen in Container',"
echo "  then use /monoceros:iterate, /monoceros:findings, …"
