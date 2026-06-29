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

# ── cwd into $HOME ────────────────────────────────────────────────
#
# Common WSL footgun: opening WSL from PowerShell (or VS Code's "WSL
# Terminal" button) inherits the Windows-side cwd, so the user lands
# in something like /mnt/c/Users/<name>. Running `curl … | bash` from
# there means the installer's cwd is on Windows' filesystem, accessed
# via 9P/gRPC-FUSE — which has subtly broken POSIX semantics. `npm
# install -g` and various spawn calls then fail in odd ways (silent
# aborts, EACCES on tmp files, locked .npm-cache directories).
#
# Switching to $HOME up front sidesteps all of it. The installer itself
# doesn't depend on cwd for anything (all paths are absolute), so this
# is invisible and harmless on macOS / native Linux. The user's
# original cwd is gone after the curl pipe finishes anyway — they
# don't notice the change.
cd "$HOME"

# ── Auto-recover from missing docker group in current shell ────────
#
# After `sudo usermod -aG docker $USER`, the user is in /etc/group's
# docker line but the running shell session loaded its group list at
# desktop-login time and has no way to refresh. Every subsequent
# `docker info` fails until the user runs `newgrp docker` manually
# or logs out + back in.
#
# This block sidesteps that for install.sh's own purposes: probe
# docker, check /etc/group membership, re-exec via `sg docker` if
# the gap is exactly that. The user sees a single `curl ... | bash`
# command in their history; they don't have to know about newgrp.
#
# Guarded against infinite loops via the env var; Linux-only.
if [ -z "${MONOCEROS_DOCKER_GROUP_REEXEC:-}" ] \
   && [ "$(uname -s)" = "Linux" ] \
   && command -v docker >/dev/null 2>&1 \
   && ! docker info >/dev/null 2>&1 \
   && command -v sg >/dev/null 2>&1 \
   && command -v getent >/dev/null 2>&1 \
   && getent group docker 2>/dev/null \
        | cut -d: -f4 \
        | tr ',' '\n' \
        | grep -qxF "$USER"; then
  # We're in the "usermod already ran, current shell is stale" trap.
  # Re-download ourselves to a temp file (the curl|bash invocation
  # consumed stdin, so we can't replay it) and exec under sg.
  __mono_self=$(mktemp -t monoceros-install.XXXXXX.sh)
  trap 'rm -f "$__mono_self"' EXIT
  if curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh > "$__mono_self" 2>/dev/null; then
    export MONOCEROS_DOCKER_GROUP_REEXEC=1
    exec sg docker -c "bash $__mono_self"
  fi
  # If the re-download fails (offline?), fall through and let the
  # downstream docker-info check render its usual setup hint.
fi

PACKAGE="@getmonoceros/workbench"
NODE_MIN_MAJOR=20

# Detect host OS once so prereq hints can show only the relevant
# commands. uname -s is POSIX-standard:
#   Darwin → macOS (Docker Desktop)
#   Linux  → native Linux vs WSL, split because the install/start advice
#            differs. Both get native Docker Engine guidance (get.docker.com,
#            `service docker start`); WSL only adds a one-line "or enable
#            Docker Desktop WSL integration" alternative. The managed-distro
#            Windows installer owns the Docker Desktop path; install.sh is the
#            bring-your-own-Docker route.
#   *      → unknown; fall back to generic doc links
case "$(uname -s)" in
  Darwin) PLATFORM="macos" ;;
  Linux)
    if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
      PLATFORM="wsl"
    else
      PLATFORM="linux"
    fi
    ;;
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

Monoceros needs Docker. Paste this block to install + grant access:

  ${CYAN}sudo -v${RESET}
  ${CYAN}curl -fsSL https://get.docker.com | sudo sh${RESET}
  ${CYAN}sudo usermod -aG docker \$USER${RESET}

Ignore the trailing "rootless mode" / "privileged service" notes
that $(dim "get.docker.com") prints — alternative install paths, not steps.

Other paths: $(dim "https://docs.docker.com/engine/install/")

Then re-run this installer.
EOF
      ;;
    wsl)
      cat >&2 <<EOF

Monoceros needs Docker. Install Docker Engine inside this WSL distro:

  ${CYAN}sudo -v${RESET}
  ${CYAN}curl -fsSL https://get.docker.com | sudo sh${RESET}
  ${CYAN}sudo usermod -aG docker \$USER${RESET}

Then start it (WSL has no systemd unless you enabled it):

  ${CYAN}sudo service docker start${RESET}

Using Docker Desktop instead? Enable its WSL integration for this distro.
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
  # WSL: the 'docker' on PATH may be Docker Desktop's WSL-integration shim
  # (a symlink into /mnt/wsl/docker-desktop) rather than a native Engine. If
  # Desktop is stopped/uninstalled/not integrated, that shim is dead: there's
  # no usable Docker here at all, so say that instead of "daemon not reachable".
  # The resolved CLI path reveals it even after `wsl --shutdown` drops the
  # tmpfs mount and leaves the symlink dangling.
  if [[ "$PLATFORM" == "wsl" ]]; then
    docker_real="$(readlink -f "$(command -v docker)" 2>/dev/null || true)"
    if [[ "$docker_real" == */docker-desktop/* ]] || [ -d /mnt/wsl/docker-desktop ]; then
      distro="${WSL_DISTRO_NAME:-this distro}"
      fail "Docker isn't available here: only Docker Desktop's WSL integration shim is present."
      cat >&2 <<EOF

Monoceros uses Docker. In a Windows PowerShell (not this WSL shell),
install Docker Desktop per-user (no admin, no UAC prompt):

  ${CYAN}winget install Docker.DockerDesktop --override "install --user --accept-license"${RESET}

Start Docker Desktop and wait for the dashboard to come up. Then turn on
WSL integration for this distro and Apply & Restart:

  Docker Desktop → Settings → Resources → WSL integration → turn on: ${BOLD}${distro}${RESET}

Then re-run this installer.
EOF
      exit 1
    fi
  fi
  fail "Docker is installed but the daemon isn't reachable."
  case "$PLATFORM" in
    macos)
      cat >&2 <<EOF

Start Docker Desktop:

  open -a Docker

Wait until the whale icon stops animating, then re-run this installer.
EOF
      ;;
    wsl)
      cat >&2 <<EOF

Start the Docker daemon in this distro:

  ${CYAN}sudo service docker start${RESET}

(systemd users: ${CYAN}sudo systemctl start docker${RESET}.)
Then re-run this installer.
EOF
      ;;
    linux)
      cat >&2 <<EOF

You're probably not in the 'docker' group yet:

  ${CYAN}sudo usermod -aG docker \$USER${RESET}

If you already are and 'docker info' still fails, the daemon may
be stopped:

  ${CYAN}sudo systemctl start docker${RESET}

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

# Rootless docker doesn't work with Monoceros's bind-mount model:
# files created inside the container end up with shifted UIDs on the
# host that the builder can't edit without sudo. Docker doesn't
# expose the kernel's idmap mount option that would fix this. We
# refuse here to keep builders from hitting opaque permission errors
# half an hour into their first apply.
#
# Detection mirrors detectDockerMode() in TS: docker info exposes
# `name=rootless` (or a bare `rootless` token in older versions)
# under SecurityOptions when the daemon is rootless.
if [[ "$PLATFORM" == "linux" ]] \
   && docker info --format '{{json .SecurityOptions}}' 2>/dev/null \
        | grep -qi 'rootless'; then
  fail "Docker is running in rootless mode, which Monoceros doesn't support."
  cat >&2 <<EOF

You're running Docker in "rootless" mode right now. That setup runs
the daemon without root privileges — sounds safer, but it remaps
user IDs between your host and the container in a way that prevents
the container from writing into the directories Monoceros mounts
into it. Cloning your repos, running 'npm install', building — all
fail with permission errors at the first attempt.

To fix, switch back to standard rootful Docker:

  ${CYAN}systemctl --user stop docker.service docker.socket 2>/dev/null || true${RESET}
  ${CYAN}dockerd-rootless-setuptool.sh uninstall${RESET}
  ${CYAN}rootlesskit rm -rf ~/.local/share/docker${RESET}
  ${CYAN}unset DOCKER_HOST DOCKER_CONTEXT${RESET}
  ${CYAN}sudo systemctl enable --now docker${RESET}
  ${CYAN}sudo usermod -aG docker \$USER${RESET}

If you added DOCKER_HOST or DOCKER_CONTEXT to ~/.bashrc / ~/.profile
(the rootless setup may have suggested it), remove those lines too —
the 'unset' above only affects your current shell. Otherwise new
terminals keep pointing at the rootless socket.

Then re-run this installer. Background: $(dim "https://getmonoceros.build/docs/start/requirements/")
EOF
  exit 1
fi

# WSL footgun: when install.sh runs inside WSL and Linux-side Node is
# missing, PATH-interop surfaces the Windows install's node from
# /mnt/c/.../node-vXX-win-x64/. Invoked from Linux bash, npm then
# writes to a Windows-side prefix, and the resulting `monoceros` on
# PATH is the Windows .cmd shim — no actual WSL install happens, just
# a re-install of the Windows variant. Treat /mnt/-resolved node as
# "Linux-side Node missing" and route through the existing
# install-Node hint (which tells the user to apt install nodejs npm).
node_path=$(command -v node 2>/dev/null || true)
node_via_wsl_interop=0
if [[ -n "$node_path" && "$node_path" == /mnt/* ]]; then
  node_path=""
  node_via_wsl_interop=1
fi
if [[ -z "$node_path" ]]; then
  if [[ "$node_via_wsl_interop" -eq 1 ]]; then
    fail "No Linux-side Node found (PATH-interop is surfacing the Windows install)."
  else
    fail "Node is not installed."
  fi
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

Monoceros needs Node ${NODE_MIN_MAJOR} or newer plus npm.

Install both with these two commands:

  ${CYAN}curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x | sudo -E bash -${RESET}
  ${CYAN}sudo apt install -y nodejs npm${RESET}

Other systems (Fedora/RHEL, fnm, nvm, volta, manual download):

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

# Same WSL footgun as above, for npm.
npm_path=$(command -v npm 2>/dev/null || true)
npm_via_wsl_interop=0
if [[ -n "$npm_path" && "$npm_path" == /mnt/* ]]; then
  npm_path=""
  npm_via_wsl_interop=1
fi
if [[ -z "$npm_path" ]]; then
  if [[ "$npm_via_wsl_interop" -eq 1 ]]; then
    fail "No Linux-side npm found (PATH-interop is surfacing the Windows install)."
  else
    fail "npm is not on PATH."
  fi
  cat >&2 <<EOF

Monoceros needs npm.

Install it with these two commands:

  ${CYAN}curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x | sudo -E bash -${RESET}
  ${CYAN}sudo apt install -y npm${RESET}

Other systems (Fedora/RHEL, fnm, nvm, volta, manual download):

  https://nodejs.org/en/download

Then re-run this installer.
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
      echo ""
    } >> "$rc_file"
    ok "appended PATH line to $(dim "$rc_file")"
  fi
fi

# --silent suppresses npm's "changed N packages" / "looking for funding"
# narration. Errors still surface on stderr. We print our own confirmation
# line below with the installed version, sourced from the binary itself.
#
# The `${arr[@]+"${arr[@]}"}` form is the portable bash 3.2-safe way
# to expand a possibly-empty array under `set -u`. macOS ships bash
# 3.2 by default (Apple stopped tracking bash at the GPLv3 switch),
# and bash 3.2 treats `"${empty_arr[@]}"` as an unbound-variable
# error even when the array was declared (`arr=()`). Bash 4.4+ fixed
# that; this fallback keeps the installer working on macOS without
# requiring users to upgrade their /bin/bash.
if ! npm install -g --silent ${npm_install_args[@]+"${npm_install_args[@]}"} "$PACKAGE" 2>/tmp/monoceros-install-err.$$; then
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
  # `menu select` enables arrow-key navigation in the candidate menu.
  # `unsetopt LIST_AMBIGUOUS` makes the first Tab actually LIST the
  # candidates instead of silently inserting their common prefix and
  # waiting for a second Tab — the latter is hostile to discovery
  # ("monoceros init demo --w<TAB>" should show the three `--with-*`
  # variants, not just complete to `--with`).
  menu_line="zstyle ':completion:*' menu select"
  list_line="unsetopt LIST_AMBIGUOUS"

  if [[ -f "$rc_file" ]] && grep -qF "$marker" "$rc_file"; then
    ok "zsh $(dim "→") $(dim "$target") $(dim "(.zshrc already wired)")"
  else
    {
      echo ""
      echo "$marker"
      echo "$fpath_line"
      echo "$autoload_line"
      echo "$menu_line"
      echo "$list_line"
      echo ""
    } >> "$rc_file"
    ok "zsh $(dim "→") $(dim "$target")"
    ok "$(dim "appended fpath + compinit + menu-completion lines to $rc_file")"
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
      echo ""
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
say "    $(cmd 'monoceros init hello --with-languages=node --with-features=claude')"
say "    $(dim "# optional: edit ~/.monoceros/monoceros-config.yml for global defaults")"
say "    $(cmd 'monoceros apply hello')"
say "    $(cmd 'monoceros shell hello')"
say ""
