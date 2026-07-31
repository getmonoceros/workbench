#!/usr/bin/env bash
# Monoceros devcontainer feature: opencode-roles.
#
# Deliberately installs nothing. The whole feature is a set of OpenCode
# agent and command files under `~/.config/opencode/`, and that directory is
# a persistent-home bind mount owned by the `opencode` feature: anything
# written into the image here would be shadowed by the host-side directory
# the moment the container starts.
#
# So Monoceros writes the files at APPLY time instead, host-side, into
# `<container-dir>/home/.config/opencode/{agents,commands}/` - the same
# reason `opencode.json` is written there and not baked into a layer (ADR
# 0018). This script exists so the feature is a real devcontainer feature
# with a version and an option surface, and so the presence of the feature
# in the yml is what switches the roles on.
#
# It does print what it is, because a silent no-op in a build log reads
# like a broken feature.

set -euo pipefail

echo "[opencode-roles] no build step: the agents and commands are written into ~/.config/opencode/ by \`monoceros apply\` (that path is a persistent bind mount, so a layer would be shadowed)"
