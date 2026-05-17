#!/usr/bin/env bash
# Monoceros devcontainer feature: claude-code.
#
# Installs the Anthropic Claude Code CLI globally via the npm registry.
# Auth is not handled here — the `mounts` section of devcontainer-
# feature.json bind-mounts the host's ~/.claude into /home/node/.claude
# so the container picks up the builder's existing login state
# (subscription or API key) automatically.

set -euo pipefail

VERSION="${VERSION:-latest}"

echo "[claude-code] installing @anthropic-ai/claude-code@${VERSION}"

# Install as root (the feature install scripts always run as root). The
# binary lands in /usr/local/bin/claude and is callable by every user
# of the container.
npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${VERSION}"

claude --version >/dev/null 2>&1 || {
  echo "[claude-code] ERROR: install completed but \`claude\` is not on PATH" >&2
  exit 1
}

echo "[claude-code] done"
