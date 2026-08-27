#!/usr/bin/env bash
# Monoceros devcontainer feature: graphify.
#
# Installs the `graphify` CLI (PyPI package `graphifyy` - upstream renamed
# it while reclaiming the short name) and registers it as a skill with
# whichever AI agent is actually in this container.
#
# Why uv and not pip: the base image ships an interpreter and no packaging
# tool at all. Measured in mcr.microsoft.com/devcontainers/typescript-node:22-bookworm:
# Python 3.11.2, no pip, no pipx, no uv, and `ensurepip` missing - so a venv
# imports but cannot bootstrap itself. uv is the only clean route and the
# upstream recommendation anyway.
#
# `--python python3.11` reuses that interpreter instead of downloading a
# second one into ~/.local/share/uv/python/, and it keeps the `leiden` extra
# installable: upstream restricts graspologic to Python below 3.13.
#
# The skill registration does NOT happen here. It writes into the agent's home
# directory (~/.claude, ~/.config/opencode), and those are bind-mounted at
# container start - a build-time write would be shadowed by the mount on the
# first run (ADR 0018). So install.sh leaves a post-create hook, which runs
# after the mounts are in place, on every container start.

set -euo pipefail

VERSION="${VERSION:-latest}"
EXTRAS="${EXTRAS:-}"

# Both options end up inside a shell command, so they are checked rather than
# trusted. Extras are lowercase alphanumeric words upstream; a specifier is
# digits and comparison operators. A typo fails the build with the reason
# instead of expanding into something else.
#
# The patterns live in variables because a bare `<` or `>` inside `[[ =~ … ]]`
# is a syntax error in bash 3.2, which is what a macOS test run gets.
EXTRAS_RE='^[a-z0-9]+(,[a-z0-9]+)*$'
VERSION_RE='^[0-9.,=<>!~*]+$'
if [ -n "${EXTRAS}" ] && ! [[ "${EXTRAS}" =~ $EXTRAS_RE ]]; then
  echo "[graphify] ERROR: extras must be comma-separated lowercase names (got '${EXTRAS}')" >&2
  exit 1
fi
if [ "${VERSION}" != "latest" ] && ! [[ "${VERSION}" =~ $VERSION_RE ]]; then
  echo "[graphify] ERROR: version must be \`latest\` or a PEP 440 specifier like \`==0.9.37\` (got '${VERSION}')" >&2
  exit 1
fi

NODE_HOME="$(getent passwd node | cut -d: -f6)"

if ! command -v uv >/dev/null 2>&1; then
  echo "[graphify] installing uv into /usr/local/bin"
  # UV_UNMANAGED_INSTALL puts uv at a fixed location and stops its installer
  # from editing any shell profile: the PATH question is settled below, for
  # every shell type at once, rather than for login shells only.
  curl -fsSL https://astral.sh/uv/install.sh \
    | env UV_UNMANAGED_INSTALL=/usr/local/bin sh
fi
uv --version >/dev/null 2>&1 || {
  echo "[graphify] ERROR: uv is not usable after install" >&2
  exit 1
}

SPEC="graphifyy"
if [ -n "${EXTRAS}" ]; then
  SPEC="graphifyy[${EXTRAS}]"
fi
if [ "${VERSION}" != "latest" ]; then
  SPEC="${SPEC}${VERSION}"
fi

echo "[graphify] installing ${SPEC} (as node, python3.11)"

# Create ~/.local/bin first, in its own shell. Debian's ~/.profile only adds it
# to PATH when it exists at shell start, so without this the install shell has
# it missing and uv closes with "`/home/node/.local/bin` is not on your PATH" -
# a warning that is both misleading (the symlink below settles PATH) and the
# kind of build-log line that generates a support question.
runuser -u node -- bash -lc 'mkdir -p "$HOME/.local/bin"'

# Install as the non-root `node` user, NOT root (this script runs as root), so
# the tool venv is node-owned and `uv tool upgrade` works from inside the
# container without sudo. Same rationale as the claude-code and opencode
# features (ADR 0018).
runuser -u node -- bash -lc "uv tool install --python python3.11 '${SPEC}'"

# uv links the entry points into ~/.local/bin, which Debian's ~/.profile adds
# to PATH - but only in a LOGIN shell, and only if the directory existed when
# that shell started. A plain `docker exec … bash`, an SSH session that is not
# a login shell, and every `sh -c` an agent spawns miss it. So the launcher
# gets a symlink on the system PATH, where root, node and any shell type find
# it. The target is stable: the tool venv lives in an image layer, not in a
# bind-mounted home path. Only `graphify`: the package's second entry point,
# `graphify-mcp`, needs the `mcp` extra that is deliberately not installed.
ln -sf "${NODE_HOME}/.local/share/uv/tools/graphifyy/bin/graphify" \
  /usr/local/bin/graphify

# Deliberately a non-login shell: this asserts the symlink above, not
# ~/.profile.
runuser -u node -- bash -c 'graphify --version' >/dev/null 2>&1 || {
  echo "[graphify] ERROR: install completed but \`graphify\` is not on PATH" >&2
  exit 1
}

# ─── Refresh hook (ADR 0054) ──────────────────────────────────────
# Only when the version is unpinned: a PEP 440 specifier in the yml is the
# builder's decision and an apply does not overrule it. The extras are part of
# the installed tool, so the upgrade keeps them by upgrading the tool rather
# than reinstalling a spec.
if [ "${VERSION}" = "latest" ]; then
  REFRESH_DIR=/usr/local/share/monoceros/refresh.d
  mkdir -p "${REFRESH_DIR}"
  cat >"${REFRESH_DIR}/graphify.sh" <<'HOOK'
#!/usr/bin/env bash
# Auto-generated by the Monoceros graphify feature.
#
# Keeps `graphify` current across applies (ADR 0054). The tool venv lives in a
# cached image layer, and every apply recreates the container from it, so the
# builder would otherwise stay on the release that was current when the layer
# was first built.
#
# `uv tool upgrade` does the version check itself against PyPI and is a no-op
# when the installed version is the newest one, so there is nothing to compare
# up front — we only read the version before and after to report what happened.
# Runs as the invoking user (node), which owns the tool venv, so no sudo.
#
# Deliberately no `set -e`: best-effort by contract.
set -u

note() {
  [ -n "${MONOCEROS_REFRESH_LOG:-}" ] || return 0
  printf '%s\n' "$1" >>"${MONOCEROS_REFRESH_LOG}" 2>/dev/null || true
}

version_of() {
  graphify --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1
}

installed="$(version_of)"

if ! command -v uv >/dev/null 2>&1; then
  note "graphify: uv is not on PATH, keeping ${installed:-the version from the image}"
  exit 0
fi

if ! uv tool upgrade graphifyy >/dev/null 2>&1; then
  note "graphify: could not check PyPI, keeping ${installed:-the version from the image}"
  exit 0
fi

now="$(version_of)"
if [ "${now}" = "${installed}" ]; then
  note "graphify ${now:-unknown} (already current)"
else
  note "graphify ${now:-unknown} (updated from ${installed:-unknown})"
fi
HOOK
  chmod 0755 "${REFRESH_DIR}/graphify.sh"
fi

POST_CREATE_DIR=/usr/local/share/monoceros/post-create.d
mkdir -p "${POST_CREATE_DIR}"

cat >"${POST_CREATE_DIR}/graphify-skill.sh" <<'HOOK'
#!/usr/bin/env bash
# Auto-generated by the Monoceros graphify feature.
#
# Registers graphify as a skill with every AI agent present in this container,
# once per container start. Which agents those are is DETECTED, not configured:
# the feature reacts to what is installed rather than to a list in the yml that
# somebody has to keep in sync - the same approach the atlassian feature's twg
# hook takes.
#
# `graphify install` takes one platform per call (it rejects a second value),
# so this loops. Registration is global, not `--project`: project scope writes
# into the builder's own repo and shows up in their git status. The global
# skill lands under the agent's home directory, which its own Monoceros feature
# already persists across an apply - the same coupling Claude Code's chat
# history has.
#
# Idempotent, and worth re-running: each call refreshes SKILL.md and its
# version marker, so the skill stays in step with a graphify that upgraded
# underneath it.
set -euo pipefail

# From $HOME, because a "global" opencode install ALSO writes
# .opencode/plugins/graphify.js plus .opencode/opencode.json into the current
# directory, unconditionally. In the workspace that would litter the builder's
# tree; in $HOME it is inert (opencode reads ~/.config/opencode) and gone on
# the next rebuild.
cd "${HOME}"

GRAPHIFY_PLATFORMS=()
if command -v claude >/dev/null 2>&1; then
  GRAPHIFY_PLATFORMS+=(claude)
fi
if command -v opencode >/dev/null 2>&1; then
  GRAPHIFY_PLATFORMS+=(opencode)
fi

if [ ${#GRAPHIFY_PLATFORMS[@]} -eq 0 ]; then
  echo "[graphify] no AI agent in this container - \`graphify\` is installed, no skill registered"
  exit 0
fi

for platform in "${GRAPHIFY_PLATFORMS[@]}"; do
  echo "[graphify] registering the skill for ${platform}"
  # Best-effort: graphify installs latest (unpinned by design) and is still
  # pre-1.0, so its install flags can change under us. A failure here must NOT
  # fail the post-create - devcontainer skips every remaining hook, including
  # other features', on a non-zero exit, and the container would come up half
  # built over a skill file.
  graphify install --platform "${platform}" || {
    echo "[graphify] WARN: 'graphify install --platform ${platform}' failed - the CLI works, the ${platform} skill is not registered until the feature is updated." >&2
  }
done
HOOK
chmod 0755 "${POST_CREATE_DIR}/graphify-skill.sh"

echo "[graphify] installed - the skill is registered per agent at post-create; run \`/graphify .\` in the agent, or \`graphify . --code-only\` on the shell"
echo "[graphify] done"
