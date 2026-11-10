#!/usr/bin/env bash
# Monoceros devcontainer feature: agent-roles.
#
# Deliberately installs nothing. The whole feature is a set of role, skill and
# hook files in the coding agents' own config trees (~/.claude, ~/.config/opencode,
# ~/.copilot), plus a guard script and the plans folder in the workspace. Those
# config trees are persistent-home bind mounts owned by the agents' features,
# so anything written into the image here would be shadowed the moment the
# container starts.
#
# So Monoceros writes the files at APPLY time instead, host-side (ADR 0018,
# ADR 0067). This script exists so the feature is a real devcontainer feature
# with a version and an option surface, and so the presence of the feature in
# the yml is what switches the roles on.
#
# It does print what it is, because a silent no-op in a build log reads like a
# broken feature.

set -euo pipefail

echo "[agent-roles] no build step: the roles, skills and permission hooks are written into each coding agent's config by \`monoceros apply\` (those paths are persistent bind mounts, so a layer would be shadowed)"
