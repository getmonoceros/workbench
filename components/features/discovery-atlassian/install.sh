#!/usr/bin/env bash
# Monoceros devcontainer feature: discovery-atlassian.
#
# Deliberately installs nothing. The feature is seven skills in the coding
# agents' own config trees (~/.claude/skills, ~/.config/opencode/skills,
# ~/.copilot/skills). Those trees are persistent-home bind mounts owned by the
# agents' features, so anything written into the image here would be shadowed
# the moment the container starts.
#
# So Monoceros writes the skills at APPLY time instead, host-side (ADR 0018,
# ADR 0068). This script exists so the feature is a real devcontainer feature
# with a version, and so the presence of the feature in the yml is what
# switches the discovery on.
#
# It does print what it is, because a silent no-op in a build log reads like a
# broken feature.

set -euo pipefail

echo "[discovery-atlassian] no build step: the discovery skills are written into each coding agent's config by \`monoceros apply\` (those paths are persistent bind mounts, so a layer would be shadowed)"
