#!/usr/bin/env bash
#
# Runs installer/install.sh for real, in containers, across the Node
# setups builders actually have, and asserts that a fresh install
# leaves behind everything the installer promises.
#
# Why this exists: for 58 releases nothing in CI executed install.sh.
# e2e-smoke.yml deliberately bypasses it and runs `npm install -g`
# itself, so the whole class of "the installer aborted halfway and
# said nothing" stayed invisible until a builder hit it (#109).
#
# Most cases differ only in how npm's global prefix is set up, because
# that decides whether the freshly installed binary is resolvable
# during the run:
#
#   default-prefix       prefix writable and on PATH (the happy path)
#   prefix-not-on-path   prefix writable, its bin/ NOT on PATH - the
#                        `npm config set prefix ~/.npm-global` setup
#                        from #109; the installer must neither depend
#                        on resolving its own binary nor leave the
#                        builder without a `monoceros` command
#   unwritable-prefix    system-wide Node as an ordinary user, so the
#                        installer routes to a per-user prefix
#   completion-blocked   shell completion cannot be written; it is an
#                        OPTIONAL step, so the install must still
#                        finish green with the home seeded
#
# Docker is stubbed: the installer only probes `docker info` as a
# prerequisite, and this tests the installer, not Docker.
#
# Usage:  installer/test/install-matrix.sh [case …]     (default: all)
#
# Set MONOCEROS_TEST_PACKAGE to a tarball path inside the repo (CI
# packs the working tree) to test the artifact about to be published
# instead of whatever is currently on npm.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
image="node:20-bookworm-slim"
package="${MONOCEROS_TEST_PACKAGE:-@getmonoceros/workbench}"

CASES=(default-prefix prefix-not-on-path unwritable-prefix completion-blocked)

# Stub `docker` so the prerequisite section passes: `docker info`
# succeeds and the SecurityOptions probe reports a non-rootless daemon
# (the installer refuses rootless).
prelude() {
  cat <<'PRE'
set -eu
cat > /usr/local/bin/docker <<'STUB'
#!/bin/sh
case "$*" in
  "info --format {{json .SecurityOptions}}") echo '["name=seccomp,profile=builtin"]' ;;
  info*) echo "Server Version: stub" ;;
  *) exit 0 ;;
esac
STUB
chmod +x /usr/local/bin/docker
PRE
}

# Everything install.sh commits to leaving behind, checked one by one
# so a failure names the missing artifact. $1 is "yes" when the case
# expects a completion file.
assertions() {
  cat <<ASSERT
want_completion="$1"
ASSERT
  cat <<'ASSERT'
rc=0
check() {
  if [ -s "$2" ]; then
    echo "    ok   $1 -> $2"
  else
    echo "    MISS $1 -> $2"
    rc=1
  fi
}

# The installer exiting non-zero is a failure on its own: a builder
# who sees a red install has nothing, however many files landed.
installer_rc=$(cat /tmp/installer-rc)
if [ "$installer_rc" = "0" ]; then
  echo "    ok   installer exited 0"
else
  echo "    MISS installer exited $installer_rc"
  rc=1
fi

check "global config"  "$HOME/.monoceros/monoceros-config.yml"
check "global secrets" "$HOME/.monoceros/monoceros-config.env"

if [ "$want_completion" = "yes" ]; then
  case "${SHELL##*/}" in
    zsh) check "completion" "$HOME/.zsh/completions/_monoceros" ;;
    *)   check "completion" "$HOME/.bash_completion.d/monoceros" ;;
  esac
fi

# A new terminal is what the builder gets next, so read the rc file
# the installer may have appended to before judging reachability.
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null || true
if command -v monoceros >/dev/null 2>&1; then
  echo "    ok   monoceros -> $(command -v monoceros)"
else
  echo "    MISS monoceros is not a command after install"
  rc=1
fi
exit $rc
ASSERT
}

run_case() {
  local name="$1" setup="$2" as_user="$3" want_completion="$4"
  printf '\n▸ %s\n' "$name"

  local script
  script=$(
    prelude
    printf '%s\n' "$setup"
    # The installer comes from the mounted working tree, not from
    # GitHub, so this covers the branch being released.
    local run='SHELL=/bin/bash MONOCEROS_TEST_PACKAGE='"$(printf '%q' "$package")"' bash /workbench/installer/install.sh; echo $? > /tmp/installer-rc'
    if [ -n "$as_user" ]; then
      printf 'su - %s -c %q || true\n' "$as_user" "$run"
      printf 'chmod 666 /tmp/installer-rc\n'
      printf 'su - %s -c "SHELL=/bin/bash bash -s" <<'"'"'EOF_ASSERT'"'"'\n' "$as_user"
    else
      printf 'export SHELL=/bin/bash\n'
      printf '%s\n' "$run"
      printf 'bash -s <<'"'"'EOF_ASSERT'"'"'\n'
    fi
    assertions "$want_completion"
    printf 'EOF_ASSERT\n'
  )

  if docker run --rm -v "$repo_root:/workbench:ro" "$image" bash -c "$script"; then
    printf '  PASS %s\n' "$name"
    return 0
  fi
  printf '  FAIL %s\n' "$name"
  return 1
}

setup_for() {
  case "$1" in
    default-prefix)
      echo ':'
      ;;
    prefix-not-on-path)
      # Writable prefix whose bin/ nobody put on PATH - #109.
      cat <<'S'
mkdir -p /opt/npm-global
npm config set prefix /opt/npm-global --global
S
      ;;
    unwritable-prefix)
      # System-wide Node, ordinary user: npm's prefix is root-owned,
      # so the installer routes to a per-user prefix instead of sudo.
      cat <<'S'
useradd -m -s /bin/bash builder
chmod 755 /usr/local/lib/node_modules
S
      ;;
    completion-blocked)
      # A regular file where the completion directory belongs, so the
      # mkdir fails. Stands in for every way that step can break.
      cat <<'S'
touch /root/.bash_completion.d
S
      ;;
  esac
}

user_for() {
  case "$1" in
    unwritable-prefix) echo builder ;;
    *) echo '' ;;
  esac
}

completion_for() {
  case "$1" in
    completion-blocked) echo no ;;
    *) echo yes ;;
  esac
}

selected=("$@")
[ ${#selected[@]} -eq 0 ] && selected=("${CASES[@]}")

failed=()
for c in "${selected[@]}"; do
  run_case "$c" "$(setup_for "$c")" "$(user_for "$c")" "$(completion_for "$c")" \
    || failed+=("$c")
done

printf '\n'
if [ ${#failed[@]} -gt 0 ]; then
  printf '✗ failed: %s\n' "${failed[*]}"
  exit 1
fi
printf '✓ all installer cases passed\n'
