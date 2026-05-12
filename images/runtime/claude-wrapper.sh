#!/usr/bin/env bash
# Monoceros wrapper around the Claude Code CLI.
#
# Auto-loads the Monoceros plugin from the bind-mounted workbench at
# /opt/monoceros-workbench, if present. Every workbench edit to the
# plugin source (slash-command markdowns, hooks, agents, etc.)
# becomes visible at the next `claude` invocation — no copying into
# the solution's `.claude/commands/` directory needed.
#
# When the bind-mount is absent (the runtime image is also usable
# outside Monoceros), the wrapper falls through to vanilla claude.
#
# When the Monoceros plugin is published to a marketplace (M4), the
# bind-mount branch becomes obsolete and this wrapper can be removed
# from the Dockerfile in one diff.
set -euo pipefail

PLUGIN_DIR="/opt/monoceros-workbench/packages/plugin"
REAL_CLAUDE="/usr/local/share/npm-global/bin/claude.real"

if [ -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ]; then
  exec "$REAL_CLAUDE" --plugin-dir "$PLUGIN_DIR" "$@"
fi
exec "$REAL_CLAUDE" "$@"
