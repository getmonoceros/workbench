#!/usr/bin/env bash
set -euo pipefail

# Claude Code CLI is preinstalled in monoceros-runtime:dev. Only thing
# left for postCreate is bringing Node dependencies if the workspace
# has a package.json.
if [ -f package.json ]; then
  pnpm install
fi
