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

# Require bash. When piped through `| sh` on Linux, /bin/sh is dash —
# the shebang above is ignored and `set -o pipefail` below would error
# out with "Illegal option -o pipefail". macOS's /bin/sh happens to be
# bash-in-POSIX-mode so `| sh` works there by accident, but we
# normalise on `| bash` for both. The check below surfaces a clear
# message before hitting the pipefail line.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "✗ This installer requires bash. Re-run with:" >&2
  echo "    curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | bash" >&2
  exit 1
fi

set -euo pipefail

PACKAGE="@getmonoceros/workbench"
NODE_MIN_MAJOR=20

# Detect host OS once so prereq hints can show only the relevant
# commands. uname -s is POSIX-standard:
#   Darwin → macOS
#   Linux  → Linux (also WSL, which is fine — it IS a Linux env)
#   *      → unknown; fall back to generic doc links
case "$(uname -s)" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      PLATFORM="other" ;;
esac

# User's interactive shell — needed both for the completion install
# below and for the PATH-rc-append we do when falling back to a
# per-user npm prefix.
user_shell="${SHELL##*/}"

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
  case "$PLATFORM" in
    macos)
      cat >&2 <<EOF

Monoceros needs Docker. Install it before continuing:

  Docker Desktop  →  https://docs.docker.com/desktop/install/mac-install/
  or via Homebrew:   brew install --cask docker

Then re-run this installer.
EOF
      ;;
    linux)
      cat >&2 <<EOF

Monoceros needs Docker. Install it before continuing:

  curl -fsSL https://get.docker.com | sudo sh

Other paths (distro packages, rootless mode, etc.):

  https://docs.docker.com/engine/install/

Then re-run this installer.
EOF
      ;;
    *)
      cat >&2 <<EOF

Monoceros needs Docker. See https://docs.docker.com/engine/install/
for instructions for your platform.

Then re-run this installer.
EOF
      ;;
  esac
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but the daemon isn't reachable."
  case "$PLATFORM" in
    macos)
      cat >&2 <<EOF

Start Docker Desktop:

  open -a Docker

Wait until the whale icon stops animating, then re-run this installer.
EOF
      ;;
    linux)
      cat >&2 <<EOF

Start the Docker service:

  sudo systemctl start docker

If 'docker info' still fails after that, your user may not be in the
'docker' group:

  sudo usermod -aG docker \$USER     # then log out and back in

Then re-run this installer.
EOF
      ;;
    *)
      cat >&2 <<EOF

Start the Docker daemon for your platform, then re-run this
installer.
EOF
      ;;
  esac
  exit 1
fi
ok "Docker daemon reachable"

if ! command -v node >/dev/null 2>&1; then
  fail "Node is not installed."
  case "$PLATFORM" in
    macos)
      cat >&2 <<EOF

Monoceros needs Node ${NODE_MIN_MAJOR} or newer (npm is included).
The standard path on macOS is Homebrew:

  brew install node

Other paths (fnm, nvm, volta, manual download):

  https://nodejs.org/en/download

Then re-run this installer.
EOF
      ;;
    linux)
      cat >&2 <<EOF

Monoceros needs Node ${NODE_MIN_MAJOR} or newer (npm is included).
NodeSource adds an apt repo with current Node — run both commands:

  curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x | sudo bash -
  sudo apt install -y nodejs

Other paths (Fedora/RHEL, fnm, nvm, volta, manual download):

  https://nodejs.org/en/download

Then re-run this installer.
EOF
      ;;
    *)
      cat >&2 <<EOF

Monoceros needs Node ${NODE_MIN_MAJOR} or newer. See
https://nodejs.org/en/download for install options.

Then re-run this installer.
EOF
      ;;
  esac
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

# Where will 'npm install -g' land? If npm's global prefix isn't
# writable by the current user (typical when Node was installed
# system-wide — apt, dnf, NodeSource convenience script), npm would
# need sudo. Sudo-installing means the CLI ends up owned by root,
# future updates also need sudo, and the install.sh path stops
# being self-contained.
#
# Instead, when the prefix isn't writable, override to a per-user
# prefix at ~/.local FOR THIS INSTALL ONLY (via --prefix flag, NOT
# via 'npm config set prefix' which would persist in ~/.npmrc and
# silently redirect every future 'npm install -g' for this user).
# Per-user Node managers (fnm, nvm, volta, Homebrew) already give
# a writable prefix and don't go through this branch — no-op for
# them.
npm_prefix=$(npm config get prefix 2>/dev/null || echo "")
npm_install_args=()

if [ -n "$npm_prefix" ] && [ ! -w "$npm_prefix" ]; then
  user_prefix="$HOME/.local"
  ok "npm prefix $(dim "$npm_prefix") not writable — installing to $(dim "$user_prefix") (no sudo)"
  mkdir -p "$user_prefix/bin"
  npm_install_args+=( "--prefix" "$user_prefix" )

  # Ensure ~/.local/bin is on PATH for the current shell, so the
  # 'monoceros --version' verification below resolves the binary.
  case ":$PATH:" in
    *":$user_prefix/bin:"*) ;;
    *) export PATH="$user_prefix/bin:$PATH" ;;
  esac

  # Persist for future shells. ~/.local/bin is in PATH for login
  # shells via /etc/profile.d on modern Ubuntu, but interactive
  # non-login shells (typical terminal sessions) need the rc-file
  # append. Guarded by a marker so repeat installs don't duplicate.
  rc_file=""
  case "$user_shell" in
    bash) rc_file="$HOME/.bashrc" ;;
    zsh)  rc_file="$HOME/.zshrc" ;;
  esac
  path_marker="# monoceros: per-user npm prefix on PATH"
  if [ -n "$rc_file" ] && [ -f "$rc_file" ] && ! grep -qF "$path_marker" "$rc_file"; then
    {
      echo ""
      echo "$path_marker"
      echo 'export PATH="$HOME/.local/bin:$PATH"'
    } >> "$rc_file"
    ok "appended PATH line to $(dim "$rc_file")"
  fi
fi

# --silent suppresses npm's "changed N packages" / "looking for funding"
# narration. Errors still surface on stderr. We print our own confirmation
# line below with the installed version, sourced from the binary itself.
if ! npm install -g --silent "${npm_install_args[@]}" "$PACKAGE" 2>/tmp/monoceros-install-err.$$; then
  fail "npm install failed."
  cat /tmp/monoceros-install-err.$$ >&2 || true
  rm -f /tmp/monoceros-install-err.$$
  cat >&2 <<EOF

The npm output above is the most useful clue. Common causes:
  - Network: couldn't reach the registry
  - Disk:    out of space, or read-only filesystem
  - Cache:   corrupted npm cache (try: npm cache verify)

If you see 'EACCES' / 'permission denied' and no "npm prefix ... not
writable" line appeared above this, please open an issue — the
installer should have routed around it.

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

# user_shell was detected once at the top of the script (it's also
# used by the per-user-prefix branch above).

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

# ── 4. User home ───────────────────────────────────────────────────
# Ensure ~/.monoceros/ exists with an all-commented monoceros-config.yml
# template. The template ships as-is (no placeholder values active);
# the user uncomments the sections they need. No "copy the sample and
# rename it" ritual — the file is already in the right place under the
# right name, and being all-commented means it's a no-op until edited.
section "User home"

monoceros_home="$HOME/.monoceros"

# Where did our package land? If the CLI install routed to a per-user
# prefix above (the npm_install_args branch), npm root -g would point
# at the SYSTEM prefix where we did NOT install. Use the actual install
# location in that case.
if [ ${#npm_install_args[@]} -gt 0 ]; then
  npm_global_root="$user_prefix/lib/node_modules"
else
  npm_global_root=$(npm root -g 2>/dev/null || echo "")
fi
config_src="$npm_global_root/@getmonoceros/workbench/templates/monoceros-config.sample.yml"
config_dst="$monoceros_home/monoceros-config.yml"

mkdir -p "$monoceros_home"

if [[ -f "$config_src" ]]; then
  if [[ -f "$config_dst" ]]; then
    ok "config $(dim '→') $(dim "$config_dst") $(dim '(already present, left alone)')"
  else
    cp "$config_src" "$config_dst"
    ok "config $(dim '→') $(dim "$config_dst")"
    say "  $(dim "All entries are commented out — uncomment what you need")"
    say "  $(dim "(git identity, feature API keys, etc).")"
  fi
else
  warn "config template not found at $config_src — skipping"
fi

# ── 5. Next steps ──────────────────────────────────────────────────
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
say "    $(dim "# optional: edit ~/.monoceros/monoceros-config.yml for global defaults")"
say "    $(cmd 'monoceros apply hello')"
say "    $(cmd 'monoceros shell hello')"
say ""
