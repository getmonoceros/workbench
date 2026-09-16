#!/usr/bin/env bash
#
# Monoceros installer — macOS + Linux.
#
# What this does:
#   1. Verifies Docker is reachable (`docker info`).
#   2. Verifies Node >= 20 is on PATH (with npm).
#   3. Runs `npm install -g @getmonoceros/workbench`.
#   4. Seeds ~/.monoceros with the two config templates.
#   5. Drops a shell-completion file in the right place for your shell.
#
# Steps 1-4 are critical: failing one aborts the install with a reason.
# Step 5 is optional and only ever warns. See "Step contract" below -
# the ordering is load-bearing, the config templates are what a
# builder cannot reconstruct on their own.
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
  echo "    curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/install.sh | bash" >&2
  exit 1
fi

set -Eeuo pipefail

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
  if curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/install.sh > "$__mono_self" 2>/dev/null; then
    export MONOCEROS_DOCKER_GROUP_REEXEC=1
    exec sg docker -c "bash $__mono_self"
  fi
  # If the re-download fails (offline?), fall through and let the
  # downstream docker-info check render its usual setup hint.
fi

# Test seam: installer/test/install-matrix.sh points this at a tarball
# packed from the working tree, so CI gates a release on the artifact
# it is about to publish instead of on whatever is already on npm.
PACKAGE="${MONOCEROS_TEST_PACKAGE:-@getmonoceros/workbench}"
NODE_MIN_MAJOR=20

# Detect host OS once so prereq hints can show only the relevant
# commands. uname -s is POSIX-standard:
#   Darwin → macOS (Docker Desktop)
#   Linux  → native Linux vs WSL, split because the Docker advice differs:
#            native Linux gets Docker Engine guidance (get.docker.com,
#            `service docker start`), WSL gets Docker Desktop + WSL
#            integration (the supported Docker on Windows). The shim case is
#            handled separately in the daemon-unreachable branch below.
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
section() { current_step="$*"; printf '\n%s▸ %s%s\n' "$BOLD$UNDERLINE" "$*" "$RESET" >&2; }
cmd()     { printf '%s%s%s' "$CYAN" "$*" "$RESET"; }
dim()     { printf '%s%s%s' "$GREY" "$*" "$RESET"; }

# ── Step contract ──────────────────────────────────────────────────
#
# Every step in this installer is either CRITICAL or OPTIONAL, and
# there is no third variant:
#
#   critical  the builder ends up with a broken install, or without
#             something they cannot reconstruct on their own → call
#             `abort`, which names the step and the reason and exits
#             non-zero.
#   optional  convenience they can add afterwards → `warn` and carry
#             on with the rest of the install.
#
# What this rules out is what shipped for 58 releases and finally bit
# a builder (#109): a step that fails, prints nothing, and takes the
# remaining steps down with it through `set -e`. `section` records
# where we are and the ERR trap below turns any unguarded failure
# into a message that at least says which step died.
current_step="startup"

abort() {
  say ""
  fail "$current_step failed: $1"
  shift
  for line in "$@"; do say "  $line"; done
  say ""
  say "  Nothing after this step ran. Fix the cause and re-run the installer;"
  say "  it is safe to run repeatedly and leaves existing files alone."
  say ""
  exit 1
}

on_unexpected_error() {
  local rc=$1
  say ""
  fail "Installer aborted during \"$current_step\" (exit $rc)."
  say "  Nothing after this step ran. This is a bug in the installer,"
  say "  please report it with the output above:"
  say "  $(cmd 'https://github.com/getmonoceros/workbench/issues')"
  say ""
  exit "$rc"
}

trap 'on_unexpected_error $?' ERR

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
  or via Homebrew:   ${CYAN}brew install --cask docker-desktop${RESET}

No Homebrew yet? Install it first:

  ${CYAN}/bin/bash -c "\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"${RESET}

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
      distro="${WSL_DISTRO_NAME:-this distro}"
      cat >&2 <<EOF

Monoceros uses Docker. In a Windows PowerShell (not this WSL shell),
install Docker Desktop per-user (no admin, no UAC prompt):

  ${CYAN}winget install Docker.DockerDesktop --override "install --user --accept-license"${RESET}

Start Docker Desktop and wait for the dashboard to come up. Then turn on
WSL integration for this distro and Apply & Restart:

  Docker Desktop → Settings → Resources → WSL integration → turn on: ${BOLD}${distro}${RESET}

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

Start Docker Desktop and wait for the dashboard to come up. Then re-run
this installer.
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

# Put a directory on PATH for future shells. Login shells pick up
# ~/.local/bin via /etc/profile.d on modern Ubuntu, but interactive
# non-login shells (a normal terminal tab) need the rc-file append.
# The marker keeps repeat installs from stacking duplicate lines, and
# is deliberately the one earlier versions wrote - changing it would
# append a second line on every machine that already has the first.
persist_path_line() {
  local dir="$1" rc_file="" path_marker
  case "$user_shell" in
    bash) rc_file="$HOME/.bashrc" ;;
    zsh)  rc_file="$HOME/.zshrc" ;;
  esac
  path_marker="# monoceros: per-user npm prefix on PATH"
  if [ -z "$rc_file" ] || [ ! -f "$rc_file" ]; then
    return 0
  fi
  if grep -qF "$path_marker" "$rc_file"; then
    return 0
  fi
  {
    echo ""
    echo "$path_marker"
    echo "export PATH=\"$dir:\$PATH\""
    echo ""
  } >> "$rc_file"
  ok "appended PATH line to $(dim "$rc_file")"
}

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

  persist_path_line "$user_prefix/bin"
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

# Where the package landed. Everything below - the config templates
# above all - is derived from this, and it is computed from what we
# already know rather than looked up through PATH: the seeding must
# not depend on the freshly installed binary being resolvable.
if [ ${#npm_install_args[@]} -gt 0 ]; then
  npm_global_prefix="$user_prefix"
else
  npm_global_prefix="$npm_prefix"
fi
npm_global_root="$npm_global_prefix/lib/node_modules"
if [ ! -d "$npm_global_root" ]; then
  npm_global_root=$(npm root -g 2>/dev/null || echo "")
fi

# npm drops the `monoceros` shim in <prefix>/bin, but nothing says a
# shell looks there. Someone who ran `npm config set prefix
# ~/.npm-global` without the matching PATH line has a prefix that is
# writable - so the fallback branch above never fires - and still no
# `monoceros` command. Put it on PATH for this run and persist it,
# the same treatment that branch gives its own prefix.
if ! command -v monoceros >/dev/null 2>&1 \
   && [ -x "$npm_global_prefix/bin/monoceros" ]; then
  export PATH="$npm_global_prefix/bin:$PATH"
  persist_path_line "$npm_global_prefix/bin"
fi

# Resolve the binary + version. Both are nice to show: the builder
# sees what landed where and which version they're on. If it does not
# resolve, that is the end of the install - we are not printing a
# green check over a missing CLI again (#109).
cli_path=$(command -v monoceros 2>/dev/null || true)
cli_version=""
if [ -n "$cli_path" ]; then
  cli_version=$("$cli_path" --version 2>/dev/null | head -1 || true)
fi
if [[ -n "$cli_version" && -n "$cli_path" ]]; then
  ok "monoceros $(dim "$cli_version") $(dim "→") $(dim "$cli_path")"
else
  abort "npm reported success, but the CLI is not runnable." \
        "Expected the shim at $(dim "$npm_global_prefix/bin/monoceros")." \
        "If it is there, your shell is not looking in that directory."
fi

# ── 3. User home ───────────────────────────────────────────────────
# Ensure ~/.monoceros/ exists with an all-commented monoceros-config.yml
# template. The template ships as-is (no placeholder values active);
# the user uncomments the sections they need. No "copy the sample and
# rename it" ritual — the file is already in the right place under the
# right name, and being all-commented means it's a no-op until edited.
section "User home"

monoceros_home="$HOME/.monoceros"

config_src="$npm_global_root/@getmonoceros/workbench/templates/monoceros-config.sample.yml"
config_dst="$monoceros_home/monoceros-config.yml"

mkdir -p "$monoceros_home"

if [[ -f "$config_src" ]]; then
  if [[ -f "$config_dst" ]]; then
    ok "config $(dim '→') $(dim "$config_dst") $(dim '(already present, left alone)')"
  else
    cp "$config_src" "$config_dst"
    ok "config $(dim '→') $(dim "$config_dst")"
    say "  $(dim "All entries are commented out - uncomment what you need")"
    say "  $(dim "(git identity, feature API keys, etc).")"
  fi
else
  abort "the config template is missing from the installed package." \
        "Looked for $(dim "$config_src")." \
        "The npm package is incomplete - please report this."
fi

# Same treatment for the global secrets file: an all-commented
# monoceros-config.env template so the builder can discover where repo
# access tokens (PATs) go without hunting through docs. All-commented =
# a no-op until edited; public repos need no token at all.
env_src="$npm_global_root/@getmonoceros/workbench/templates/monoceros-config.sample.env"
env_dst="$monoceros_home/monoceros-config.env"

if [[ -f "$env_src" ]]; then
  if [[ -f "$env_dst" ]]; then
    ok "secrets $(dim '→') $(dim "$env_dst") $(dim '(already present, left alone)')"
  else
    cp "$env_src" "$env_dst"
    ok "secrets $(dim '→') $(dim "$env_dst")"
    say "  $(dim 'All entries are commented out - add repo tokens (PATs) here')"
    say "  $(dim 'when you need private clone/push (public repos need none).')"
  fi
else
  abort "the secrets template is missing from the installed package." \
        "Looked for $(dim "$env_src")." \
        "The npm package is incomplete - please report this."
fi

# ── 4. Shell completion ────────────────────────────────────────────
#
# OPTIONAL by the step contract: every failure below warns and moves
# on. The builder can regenerate this at any time with a single
# `monoceros completion <shell>`, and until #109 a stumble here was
# enough to abort the whole install before the home was seeded.
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
    if ! monoceros completion zsh > "$target" 2>/dev/null; then
      rm -f "$target"
      warn "could not generate zsh completion — skipping"
      return 0
    fi
    ok "zsh $(dim "→") $(dim "$target") $(dim "(Oh-My-Zsh)")"
    return 0
  fi

  # Vanilla zsh: write to ~/.zsh/completions/ and ensure .zshrc has
  # the fpath + compinit lines (guarded by the marker so we don't
  # duplicate on repeat installs).
  dir="$HOME/.zsh/completions"
  target="$dir/_monoceros"
  if ! mkdir -p "$dir" 2>/dev/null \
     || ! monoceros completion zsh > "$target" 2>/dev/null; then
    rm -f "$target"
    warn "could not generate zsh completion — skipping"
    return 0
  fi

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
  target="$dir/monoceros"
  if ! mkdir -p "$dir" 2>/dev/null \
     || ! monoceros completion bash > "$target" 2>/dev/null; then
    rm -f "$target"
    warn "could not generate bash completion — skipping"
    return 0
  fi

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

# ── 5. Next steps ──────────────────────────────────────────────────
section "Next steps"

say ""
if [[ -n "$cli_version" ]]; then
  ok "Monoceros $cli_version is ready."
else
  ok "Monoceros is ready."
fi
say ""
say "  Your container configs live here:"
say "      $(cmd "$monoceros_home/container-configs")"
say ""
# zsh/bash cache PATH-binaries at startup, so a freshly-installed monoceros
# is only visible after a hash rebuild (or in a new terminal).
say "  Activate in this shell $(dim '(or just open a new terminal):')"
case "$user_shell" in
  zsh)  say "      $(cmd 'rehash && compinit')" ;;
  bash) say "      $(cmd 'hash -r && source ~/.bashrc')" ;;
  *)    say "      $(dim '(open a new terminal)')" ;;
esac
say ""
say "  Get started $(dim '(describe a container, build it, then work inside):')"
say "      $(cmd 'monoceros init  myapp --with-languages=node --with-features=claude')"
say "      $(cmd 'monoceros apply myapp')"
say "      $(cmd 'monoceros shell myapp')"
say ""
say "  Working with Git repositories? Add your access tokens to:"
say "      $(cmd "$monoceros_home/monoceros-config.env")"
say "  $(dim 'Then gh, glab and clone/push are authenticated.')"
say "  $(dim 'Details: https://getmonoceros.build/docs/concepts/git-and-repos/')"
say ""
say "  Help        $(cmd 'monoceros --help')"
say "  Docs        $(cmd 'https://getmonoceros.build/docs')"
say "  What's new  $(cmd 'https://getmonoceros.build/changelog')"
say ""
