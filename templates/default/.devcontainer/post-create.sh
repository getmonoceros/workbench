#!/usr/bin/env bash
set -euo pipefail

# Install Claude Code CLI globally if not already on PATH.
if ! command -v claude >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code
fi

# Install Node dependencies if the workspace has a package.json.
if [ -f package.json ]; then
  pnpm install
fi
