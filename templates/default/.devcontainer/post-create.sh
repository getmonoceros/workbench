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
# come along via the bind mount. Failing to wire here is non-fatal —
# the slash commands will surface a clear error at first use.
WORKBENCH=/opt/monoceros-workbench
BIN_LINK=/usr/local/bin/monoceros-plugin
if [ -d "$WORKBENCH/packages/plugin" ]; then
  if [ -x "$WORKBENCH/node_modules/.bin/monoceros-plugin" ]; then
    sudo ln -sf "$WORKBENCH/node_modules/.bin/monoceros-plugin" "$BIN_LINK"
  else
    echo "warn: $WORKBENCH/node_modules/.bin/monoceros-plugin not found." >&2
    echo "warn: run \`pnpm install\` in the workbench host-side, then restart the container." >&2
  fi
fi
