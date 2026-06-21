#!/usr/bin/env bash
#
# Create a per-artifact GitHub Release with notes generated from the
# conventional-commit history. Called by the release-* workflows after a
# successful publish, once per artifact (the features workflow calls it
# in its per-feature loop).
#
# The notes are the *technical* record (grouped feat/fix/… from the
# commits that touched this artifact's paths). The curated, user-facing
# changelog lives separately on the website — these two are deliberately
# different registers, not copies of each other.
#
# Design rules:
#   - idempotent: a tag that already has a release is left untouched, so
#     re-runs and workflow_dispatch are safe.
#   - non-fatal by intent: the caller runs this with continue-on-error,
#     because the publish to npm/GHCR has already happened — a hiccup in
#     release-note generation must never turn a shipped release red.
#
# Usage:
#   gh-release.sh <tag> <title> <tag-glob> <include-path> [latest]
#
#   tag           the new tag to create,         e.g. cli-v1.33.7
#   title         the GitHub Release title,      e.g. "CLI v1.33.7"
#   tag-glob      previous-tag match for the     e.g. "cli-v*"
#                 changelog range
#   include-path  git-cliff path filter scoping  e.g. "packages/cli/**"
#                 notes to this artifact
#   latest        "true" marks this the repo's   default: false
#                 "Latest" release (CLI only)
#
# Requires: gh (authenticated via GH_TOKEN), node/npx, a full-history
# checkout (fetch-depth: 0) so git-cliff and the tag lookup see history.
# Set DRY_RUN=1 to print what would happen without creating anything.
set -euo pipefail

tag="${1:?tag required}"
title="${2:?title required}"
glob="${3:?tag-glob required}"
include="${4:?include-path required}"
latest="${5:-false}"

CLIFF_VERSION="git-cliff@2.13.1"

if [[ -n "${DRY_RUN:-}" ]]; then
  echo "[dry-run] would release tag=$tag title=\"$title\" glob=$glob include=$include latest=$latest"
elif gh release view "$tag" >/dev/null 2>&1; then
  echo "release $tag already exists — nothing to do"
  exit 0
fi

git fetch --tags --force --quiet || true

# Previous release of THIS artifact, so the range covers only what
# changed since it. Empty on the first release → whole history.
prev=$(git tag --list "$glob" --sort=-version:refname | head -n1 || true)
range=""
if [[ -n "$prev" ]]; then
  range="${prev}..HEAD"
  echo "changelog range: $range (scoped to $include)"
else
  echo "no previous $glob tag — generating from full history (scoped to $include)"
fi

# shellcheck disable=SC2086  # $range must word-split (empty = whole history)
notes=$(npx -y "$CLIFF_VERSION" --config cliff.toml --include-path "$include" $range 2>/dev/null || true)
if [[ -z "${notes//[[:space:]]/}" ]]; then
  notes="_No notable changes in this artifact since the previous release._"
fi

latest_flag="--latest=false"
[[ "$latest" == "true" ]] && latest_flag="--latest"

if [[ -n "${DRY_RUN:-}" ]]; then
  echo "[dry-run] gh release create $tag --title \"$title\" $latest_flag --notes:"
  echo "----------------------------------------------------------------"
  printf '%s\n' "$notes"
  echo "----------------------------------------------------------------"
  exit 0
fi

printf '%s\n' "$notes" | gh release create "$tag" \
  --title "$title" \
  --notes-file - \
  --target "$GITHUB_SHA" \
  "$latest_flag"

echo "created release $tag"
