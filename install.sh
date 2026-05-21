#!/usr/bin/env bash
#
# Monoceros installer — macOS + Linux.
#
# What this does:
#   1. Verifies Docker is reachable (`docker info`).
#   2. Verifies Node >= 20 is on PATH (with npm).
#   3. Runs `npm install -g @getmonoceros/workbench`.
#   4. Drops a shell-completion file in the right place for your shell.
#
# What this does NOT do:
#   - Install Docker.
#   - Install Node.
#   - Touch your system beyond an `npm install -g` and one rc-file
#     append for shell-completion bootstrap (guarded; repeat runs
#     don't duplicate).
#
# If either prerequisite is missing the script prints an explanation
# and exits non-zero. Install the missing piece yourself, then re-run.
#
# Pinning to a version: this script always installs the latest npm
# release. To pin, skip the script and run
# `npm install -g @getmonoceros/workbench@<version>` directly.
set -euo pipefail

PACKAGE="@getmonoceros/workbench"
NODE_MIN_MAJOR=20

# ── Pretty printing ────────────────────────────────────────────────
# Colors are gated on stderr being a TTY (the script prints to
# stderr so `curl … | sh` still shows the output). Palette matches
# the help renderer in packages/cli/src/help.ts:
#   - cyan      = identifiers you type (commands, args)
#   - grey      = supplementary metadata (paths, version notes)
#   - bold+und. = structural section markers
#   - green/red/yellow = success/error/warn status semantics
if [[ -t 2 ]]; then
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  CYAN=$'\033[36m'
  GREY=$'\033[90m'
  BOLD=$'\033[1m'
  UNDERLINE=$'\033[4m'
  RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; CYAN=""; GREY=""
  BOLD=""; UNDERLINE=""; RESET=""
fi

say()     { printf '%s\n' "$*" >&2; }
ok()      { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*" >&2; }
warn()    { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
fail()    { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }
section() { printf '\n%s▸ %s%s\n' "$BOLD$UNDERLINE" "$*" "$RESET" >&2; }
cmd()     { printf '%s%s%s' "$CYAN" "$*" "$RESET"; }
dim()     { printf '%s%s%s' "$GREY" "$*" "$RESET"; }

# ── Header ─────────────────────────────────────────────────────────
say ""
say "${BOLD}Monoceros installer${RESET}"
say "$(dim "  local, reproducible dev containers with AI coding tooling")"

# ── 1. Prerequisites ───────────────────────────────────────────────
section "Prerequisites"

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
ok "Docker daemon reachable"

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
ok "Node $(dim "$node_version") with npm"

# ── 2. CLI install ─────────────────────────────────────────────────
section "Installing CLI"

# --silent suppresses npm's "changed N packages" / "looking for funding"
# narration. Errors still surface on stderr. We print our own confirmation
# line below with the installed version, sourced from the binary itself.
if ! npm install -g --silent "$PACKAGE" 2>/tmp/monoceros-install-err.$$; then
  fail "npm install failed."
  cat /tmp/monoceros-install-err.$$ >&2 || true
  rm -f /tmp/monoceros-install-err.$$
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
rm -f /tmp/monoceros-install-err.$$

# Resolve the just-installed binary path + version. Both are nice to
# show: builder sees what landed where and which version they're on.
cli_path=$(command -v monoceros 2>/dev/null || true)
cli_version=$("$cli_path" --version 2>/dev/null | head -1 || true)
if [[ -n "$cli_version" && -n "$cli_path" ]]; then
  ok "monoceros $(dim "$cli_version") $(dim "→") $(dim "$cli_path")"
else
  ok "Monoceros installed"
fi

# ── 3. Shell completion ────────────────────────────────────────────
section "Shell completion"

user_shell="${SHELL##*/}"

install_zsh_completion() {
  local target dir rc_file fpath_line autoload_line marker
  marker="# monoceros completion (managed by install.sh)"

  # Prefer Oh-My-Zsh's completions dir if it exists — that path is
  # already on the OMZ-managed $fpath, no rc-file change needed.
  if [[ -d "$HOME/.oh-my-zsh/completions" ]]; then
    dir="$HOME/.oh-my-zsh/completions"
    target="$dir/_monoceros"
    monoceros completion zsh > "$target"
    ok "zsh $(dim "→") $(dim "$target") $(dim "(Oh-My-Zsh)")"
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
    ok "zsh $(dim "→") $(dim "$target") $(dim "(.zshrc already wired)")"
  else
    {
      echo ""
      echo "$marker"
      echo "$fpath_line"
      echo "$autoload_line"
    } >> "$rc_file"
    ok "zsh $(dim "→") $(dim "$target")"
    ok "$(dim "appended fpath + compinit lines to $rc_file")"
  fi
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
    ok "bash $(dim "→") $(dim "$target") $(dim "(.bashrc already wired)")"
  else
    {
      echo ""
      echo "$marker"
      echo "$source_line"
    } >> "$rc_file"
    ok "bash $(dim "→") $(dim "$target")"
    ok "$(dim "appended source line to $rc_file")"
  fi
}

case "$user_shell" in
  zsh)  install_zsh_completion ;;
  bash) install_bash_completion ;;
  *)
    warn "shell '$user_shell' not auto-supported — install completion manually:"
    say "    $(cmd 'monoceros completion bash') > ~/.bash_completion.d/monoceros"
    say "    $(cmd 'monoceros completion zsh')  > ~/.zsh/completions/_monoceros"
    ;;
esac

# ── 4. Next steps ──────────────────────────────────────────────────
section "Next steps"

say ""
say "  Activate in this shell $(dim "(zsh/bash cache PATH-binaries at startup;")"
say "  $(dim "a freshly-installed monoceros is only visible after a hash rebuild)"):"
case "$user_shell" in
  zsh)
    say ""
    say "    $(cmd 'rehash && compinit')"
    ;;
  bash)
    say ""
    say "    $(cmd 'hash -r && source ~/.bashrc')"
    ;;
  *)
    say ""
    say "    $(dim '(open a new terminal)')"
    ;;
esac

say ""
say "  Try it out:"
say ""
say "    $(cmd 'monoceros init hello --with=node,claude')"
say "    $(dim "# edit ~/.monoceros/monoceros-config.yml (api keys etc)")"
say "    $(cmd 'monoceros apply hello')"
say "    $(cmd 'monoceros shell hello')"
say ""
