#!/usr/bin/env bash
#
# Monoceros installer — macOS + Linux.
#
# What this does:
#   1. Verifies Docker is reachable (`docker info`).
#   2. Verifies Node >= 20 is on PATH (with npm).
#   3. Runs `npm install -g @getmonoceros/workbench`.
#
# What this does NOT do:
#   - Install Docker.
#   - Install Node.
#   - Touch any of your shells, package managers or version managers.
#
# If either prerequisite is missing the script prints an explanation
# and exits non-zero. Install the missing piece yourself (the script
# tells you which install paths are common), then re-run.
#
# Pinning to a version: this script always installs the latest npm
# release. To pin, skip the script and run
# `npm install -g @getmonoceros/workbench@<version>` directly.
set -euo pipefail

PACKAGE="@getmonoceros/workbench"
NODE_MIN_MAJOR=20

# ── Pretty printing ────────────────────────────────────────────────
if [[ -t 2 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BOLD=""; RESET=""
fi
say()  { printf '%s\n' "$*" >&2; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
fail() { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }

# ── 1. Docker ──────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker is not installed."
  cat >&2 <<EOF

Monoceros needs Docker. Install it before continuing:

  ${BOLD}macOS:${RESET}  Docker Desktop  →  https://docs.docker.com/desktop/install/mac-install/
          (or:  brew install --cask docker)
  ${BOLD}Linux:${RESET}  Docker Engine   →  https://docs.docker.com/engine/install/
          (or your distro's package: apt/dnf/pacman install docker.io / docker-ce)

Then re-run this installer.
EOF
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but the daemon isn't reachable."
  cat >&2 <<EOF

Start Docker Desktop (macOS) or the Docker service (Linux):

  ${BOLD}macOS:${RESET}  open -a Docker
  ${BOLD}Linux:${RESET}  sudo systemctl start docker
          (you may need to add your user to the 'docker' group:
           sudo usermod -aG docker \$USER ; log out and back in)

Then re-run this installer.
EOF
  exit 1
fi
ok "Docker daemon reachable."

# ── 2. Node + npm ──────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  fail "Node is not installed."
  cat >&2 <<EOF

Monoceros needs Node ${NODE_MIN_MAJOR} or newer. Pick whichever install style fits
your setup — Monoceros doesn't care, we just need \`node\` on PATH:

  ${BOLD}System-wide (admin / sudo):${RESET}
    macOS:   brew install node
    Linux:   sudo apt install nodejs npm     (Debian / Ubuntu)
             sudo dnf install nodejs npm     (Fedora)
             https://nodejs.org/en/download   (other distros)

  ${BOLD}Per-user (no admin required):${RESET}
    nvm:     https://github.com/nvm-sh/nvm
    fnm:     https://github.com/Schniz/fnm
    volta:   https://volta.sh

Then re-run this installer.
EOF
  exit 1
fi

node_version=$(node --version | sed 's/^v//')
node_major=${node_version%%.*}
if [[ -z "$node_major" || "$node_major" -lt $NODE_MIN_MAJOR ]]; then
  fail "Node $node_version is too old. Monoceros needs >= ${NODE_MIN_MAJOR}."
  cat >&2 <<EOF

Upgrade Node, then re-run this installer. See the install hints in
the previous error for the common upgrade paths.
EOF
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is not on PATH (unusual — npm normally ships with Node)."
  cat >&2 <<EOF

Reinstall Node from one of the sources above; npm should come along
automatically.
EOF
  exit 1
fi
ok "Node $node_version with npm."

# ── 3. Install ─────────────────────────────────────────────────────
say ""
say "Installing $PACKAGE globally…"
if ! npm install -g "$PACKAGE"; then
  fail "npm install failed."
  cat >&2 <<EOF

If this is a permissions issue, npm is configured to write to a
location requiring elevated privileges. Two ways out:

  - re-run with sudo (system install):  sudo npm install -g $PACKAGE
  - reconfigure npm's prefix to a user-owned directory and add it
    to PATH (search "npm config set prefix" for guidance).

Once installed, verify with:  monoceros --version
EOF
  exit 1
fi

say ""
ok "Monoceros installed."
say ""
say "Try:  ${BOLD}monoceros init hello --with=node,claude${RESET}"
say "      then edit ~/.monoceros/monoceros-config.yml and:"
say "      ${BOLD}monoceros apply hello${RESET}"
