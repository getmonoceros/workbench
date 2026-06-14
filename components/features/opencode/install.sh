#!/usr/bin/env bash
# Monoceros devcontainer feature: opencode.
#
# Installs sst's OpenCode CLI globally via the npm registry (package
# `opencode-ai`). Model selection and the provider API key are NOT
# handled here — they are written to ~/.config/opencode/opencode.json
# at `monoceros apply` (see create/opencode-config.ts), so a change to
# the yml takes effect on the next apply instead of being frozen by the
# feature's cached image layer (ADR 0018). Auth/session state lives
# under ~/.config/opencode and ~/.local/share/opencode, both
# bind-mounted from the host so they survive apply rebuilds.

set -euo pipefail

VERSION="${VERSION:-latest}"

echo "[opencode] installing opencode-ai@${VERSION} (as node)"

# Install as the non-root `node` user, NOT root (this script runs as
# root). The base image's npm global prefix is owned by `node`, so
# installing as node leaves the package files node-owned — which is what
# lets OpenCode's runtime self-updater keep itself current between
# Monoceros `upgrade`s. Installing as root would freeze the version at
# build time with no-write-permission errors. Same rationale as the
# claude-code feature (ADR 0018).
runuser -u node -- bash -lc \
  "npm install -g --no-audit --no-fund 'opencode-ai@${VERSION}'"

runuser -u node -- bash -lc 'opencode --version' >/dev/null 2>&1 || {
  echo "[opencode] ERROR: install completed but \`opencode\` is not on PATH" >&2
  exit 1
}

echo "[opencode] installed — model + provider key (if set in the yml) are written to ~/.config/opencode/opencode.json by \`monoceros apply\`; otherwise run \`opencode auth login\` once in the container"
echo "[opencode] done"
