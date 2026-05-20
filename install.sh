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

ok "Monoceros installed."

# ── 4. Shell completion ────────────────────────────────────────────
# Detect the user's login shell and drop the matching completion
# script into a sensible userspace location. Idempotent: if the
# expected line is already in the rc file, we skip it.
say ""
say "Installing shell completion…"

user_shell="${SHELL##*/}"
completion_done=0

install_zsh_completion() {
  local target dir rc_file fpath_line autoload_line marker
  marker="# monoceros completion (managed by install.sh)"

  # Prefer Oh-My-Zsh's completions dir if it exists — that path is
  # already on the OMZ-managed $fpath, no rc-file change needed.
  if [[ -d "$HOME/.oh-my-zsh/completions" ]]; then
    dir="$HOME/.oh-my-zsh/completions"
    target="$dir/_monoceros"
    monoceros completion zsh > "$target"
    ok "  zsh completion → $target (Oh-My-Zsh)"
    completion_done=1
    return
  fi

  # Vanilla zsh: write to ~/.zsh/completions/ and ensure .zshrc has
  # the fpath + compinit lines (guarded by the marker so we don't
  # duplicate on repeat installs).
  dir="$HOME/.zsh/completions"
  mkdir -p "$dir"
  target="$dir/_monoceros"
  monoceros completion zsh > "$target"

  rc_file="$HOME/.zshrc"
  fpath_line="fpath=(~/.zsh/completions \$fpath)"
  autoload_line="autoload -Uz compinit && compinit"

  if [[ -f "$rc_file" ]] && grep -qF "$marker" "$rc_file"; then
    ok "  zsh completion → $target (.zshrc already wired up)"
  else
    {
      echo ""
      echo "$marker"
      echo "$fpath_line"
      echo "$autoload_line"
    } >> "$rc_file"
    ok "  zsh completion → $target"
    say "  appended fpath + compinit lines to $rc_file."
  fi
  completion_done=1
}

install_bash_completion() {
  local target dir rc_file source_line marker
  marker="# monoceros completion (managed by install.sh)"

  dir="$HOME/.bash_completion.d"
  mkdir -p "$dir"
  target="$dir/monoceros"
  monoceros completion bash > "$target"

  rc_file="$HOME/.bashrc"
  source_line="source $target"

  if [[ -f "$rc_file" ]] && grep -qF "$marker" "$rc_file"; then
    ok "  bash completion → $target (.bashrc already wired up)"
  else
    {
      echo ""
      echo "$marker"
      echo "$source_line"
    } >> "$rc_file"
    ok "  bash completion → $target"
    say "  appended source line to $rc_file."
  fi
  completion_done=1
}

case "$user_shell" in
  zsh)  install_zsh_completion ;;
  bash) install_bash_completion ;;
  *)
    warn "  shell '$user_shell' is not auto-supported. To install completion manually:"
    say "    monoceros completion bash > ~/.bash_completion.d/monoceros   # bash"
    say "    monoceros completion zsh  > ~/.zsh/completions/_monoceros    # zsh"
    ;;
esac

say ""
say "${BOLD}Activate in this shell${RESET} (zsh caches PATH-binaries at startup, so a"
say "freshly-installed \`monoceros\` is only visible after a hash rebuild):"
case "$user_shell" in
  zsh)
    say ""
    say "  ${BOLD}rehash && exec zsh${RESET}"
    say ""
    say "  (\`rehash\` makes \`monoceros\` visible on PATH; \`exec zsh\` reloads zsh"
    say "  so the new completion script is picked up.)"
    ;;
  bash)
    say ""
    say "  ${BOLD}hash -r && source ~/.bashrc${RESET}"
    say ""
    say "  (\`hash -r\` makes \`monoceros\` visible on PATH; \`source ~/.bashrc\`"
    say "  reloads the completion.)"
    ;;
  *)
    say "  open a new terminal."
    ;;
esac

say ""
say "${BOLD}First steps${RESET}:"
say ""
say "  monoceros init hello --with=node,claude"
say "  # edit ~/.monoceros/monoceros-config.yml (claude api key etc)"
say "  monoceros apply hello"
say "  monoceros shell hello"
