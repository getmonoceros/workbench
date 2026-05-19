#!/usr/bin/env bash
#
# Publish all features under images/features/ to GHCR under the
# `getmonoceros/monoceros-features` namespace. Same script for the
# first manual publish and for the GitHub Actions workflow (M4 Task 7).
#
# Local invocation:
#   docker login ghcr.io -u <github-username>   # once per shell
#   pnpm publish:features
#
# CI invocation (workflow sets these):
#   GHCR_TOKEN=<pat-with-write:packages> bash scripts/publish-features.sh
#
# Running this does NOT change what `monoceros apply` uses inside the
# workbench checkout — `resolveFeatures` keeps preferring the local
# images/features/<name>/ copy as long as it exists. GHCR is only the
# path for builders who installed via npm and have no checkout.
#
# First-run setup: GHCR packages start out private. Set each one to
# public exactly once via the package settings page (URL printed at
# the end of this script). All subsequent publishes inherit that
# visibility, so this is three clicks total, ever.
set -euo pipefail

NAMESPACE="getmonoceros/monoceros-features"
REGISTRY="ghcr.io"
ORG="getmonoceros"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
features_dir="$repo_root/images/features"

if [[ ! -d "$features_dir" ]]; then
  echo "fatal: $features_dir does not exist" >&2
  exit 1
fi

# CI path — log in via the workflow-provided token. Locally we trust
# that the operator already ran `docker login ghcr.io` and skip this.
if [[ -n "${GHCR_TOKEN:-}" ]]; then
  echo "→ docker login $REGISTRY (CI mode)"
  echo "$GHCR_TOKEN" | docker login "$REGISTRY" \
    -u "${GHCR_USER:-${GITHUB_ACTOR:-token}}" \
    --password-stdin
fi

published=()
for dir in "$features_dir"/*/; do
  [[ -f "$dir/devcontainer-feature.json" ]] || continue
  name="$(basename "$dir")"
  echo
  echo "==> publishing $name"
  npx -y @devcontainers/cli features publish \
    --namespace "$NAMESPACE" \
    "$dir"
  published+=("$name")
done

if [[ ${#published[@]} -eq 0 ]]; then
  echo "no features found under $features_dir" >&2
  exit 1
fi

echo
echo "Published: ${published[*]}"
cat <<EOF

First-run reminder (once per package, ever):
  GHCR-Pakete starten privat. Öffentlich schalten unter
    https://github.com/orgs/$ORG/packages
  pro Paket: Package settings → Change visibility → Public.
  Spätere Publishes erben diese Sichtbarkeit.
EOF
