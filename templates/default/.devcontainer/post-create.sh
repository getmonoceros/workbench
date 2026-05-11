#!/usr/bin/env bash
set -euo pipefail

# Claude Code CLI is preinstalled in monoceros-runtime:dev. Only thing
# left for postCreate is bringing Node dependencies if the workspace
# has a package.json.
if [ -f package.json ]; then
  pnpm install
fi

# Wire `monoceros-plugin` into PATH when the workbench is bind-mounted
# at /opt/monoceros-workbench. The workbench's pnpm install must have
# been run host-side first; the workspace symlinks under node_modules/
# come along via the bind mount. pnpm's supportedArchitectures config
# (in pnpm-workspace.yaml) pulls linux esbuild binaries host-side so
# tsx works in the container.
#
# Failing to wire here is non-fatal — the slash commands will surface
# a clear error message at first use.
WORKBENCH=/opt/monoceros-workbench
BIN_PATH=/usr/local/bin/monoceros-plugin
MAIN_TS=$WORKBENCH/packages/plugin/src/main.ts
TSX=$WORKBENCH/node_modules/.bin/tsx
if [ -f "$MAIN_TS" ] && [ -x "$TSX" ]; then
  sudo tee "$BIN_PATH" > /dev/null <<EOF
#!/usr/bin/env bash
exec "$TSX" "$MAIN_TS" "\$@"
EOF
  sudo chmod 0755 "$BIN_PATH"
elif [ -d "$WORKBENCH/packages/plugin" ]; then
  echo "warn: monoceros-plugin not wired into PATH." >&2
  echo "warn: run \`pnpm install\` in the workbench host-side, then restart the container." >&2
fi
