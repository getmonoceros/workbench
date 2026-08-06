#!/usr/bin/env bash
# Monoceros devcontainer feature: atlassian.
#
# Installs Atlassian CLIs that share a single Atlassian account:
#   - Rovo Dev (acli, default on) — the `acli rovodev` AI agent
#   - Teamwork Graph (twg, default on)
#   - Forge (forge, default on) — the `@forge/cli` app-dev toolchain
#
# Each tool is toggled independently via the `rovodev` / `twg` / `forge`
# options. `instance` / `email` / `apiToken` are shared by twg and Forge;
# Rovo Dev needs its OWN token (`rovodevToken`), because acli only accepts
# a Rovo Dev scoped token and answers a classic one with a bare
# "authentication failed" — which is why the two cannot share a variable.
#
# Each tool gets a post-create hook under
# /usr/local/share/monoceros/post-create.d/, run on every container start:
#   - rovodev: the non-interactive login, reading the token from the
#     environment (ATLASSIAN_ROVODEV_TOKEN) rather than from a value baked
#     in here. The feature layer is cached, so a baked token would outlive a
#     rotation and every later `apply` would log in with the old one
#     (ADR 0018).
#   - twg: (re-)installs its agent skills. Auth is env-var only.
#   - forge: records the analytics consent, so the prompt never blocks a
#     non-interactive `forge` call. Auth is env-var only
#     (FORGE_EMAIL / FORGE_API_TOKEN), the keychain-free path Atlassian
#     recommends for containers.
#
# No hook fails the apply over a credential. A wrong or missing token is a
# one-minute fix on the host, and devcontainer's postCreate aborts the WHOLE
# remaining sequence on a non-zero exit: every later hook, including other
# features', would be skipped and the container would come up half built.

set -euo pipefail

ROVODEV="${ROVODEV:-true}"
TWG="${TWG:-true}"
FORGE="${FORGE:-true}"
INSTANCE="${INSTANCE:-}"
EMAIL="${EMAIL:-}"
APITOKEN="${APITOKEN:-}"
ROVODEVTOKEN="${ROVODEVTOKEN:-}"
BITBUCKETTOKEN="${BITBUCKETTOKEN:-}"

if [ "${ROVODEV}" != "true" ] && [ "${TWG}" != "true" ] && [ "${FORGE}" != "true" ]; then
  echo "[atlassian] rovodev, twg and forge all disabled — nothing to install" >&2
  exit 0
fi

ARCH="$(dpkg --print-architecture)"
case "${ARCH}" in
  amd64 | arm64) ;;
  *)
    echo "[atlassian] unsupported architecture: ${ARCH}" >&2
    exit 1
    ;;
esac

POST_CREATE_DIR=/usr/local/share/monoceros/post-create.d
mkdir -p "${POST_CREATE_DIR}"

# ─── Rovo Dev (acli) ──────────────────────────────────────────────
if [ "${ROVODEV}" = "true" ]; then
  ACLI_URL="https://acli.atlassian.com/linux/latest/acli_linux_${ARCH}/acli"
  echo "[atlassian/rovodev] downloading acli for ${ARCH} from ${ACLI_URL}"
  TMP="$(mktemp)"
  curl -fsSL -o "${TMP}" "${ACLI_URL}"
  install -o root -g root -m 0755 "${TMP}" /usr/local/bin/acli
  rm -f "${TMP}"
  acli --version >/dev/null 2>&1 || {
    echo "[atlassian/rovodev] ERROR: install completed but \`acli\` is not on PATH" >&2
    exit 1
  }

  PRESET_SITE_SCRIPT=/usr/local/share/monoceros/rovodev-billing-site.py
# The site Rovo Dev bills against. Without it the first `acli rovodev run`
  # asks on stdin, and that is where an agent's first Rovo Dev call stops dead,
  # the same class of problem as Forge's analytics prompt. We already have the
  # value: it is the `instance` option twg receives as TWG_SITE.
  #
  # acli has no `config set`, only "open the config in your editor", so this
  # edits the YAML. Line-oriented on purpose: config.yml is a commented template
  # and a YAML round trip would strip its documentation out. Its own file rather
  # than inline in the hook, so it is readable and testable on its own.
  cat >"${PRESET_SITE_SCRIPT}" <<'PRESET_SITE_PY'
"""Fill Rovo Dev's `atlassianBillingSite.siteUrl`, only when it is unset.

Never overwrites an answered value: a builder may have picked a different site
on purpose. Writes nothing but that one line, so acli's commented template
survives.
"""

import os
import re
import sys

KEY = 'atlassianBillingSite:'
UNSET = ('', 'null', '~', '""', "''")


def normalize(site: str) -> str:
    return site if site.startswith(('http://', 'https://')) else f'https://{site}'


def main() -> int:
    site = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
    if not site:
        return 0
    site = normalize(site)
    path = os.path.join(os.path.expanduser('~'), '.rovodev', 'config.yml')
    os.makedirs(os.path.dirname(path), exist_ok=True)

    if not os.path.exists(path):
        # No config yet: two valid lines, every other setting keeps its default.
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(f'{KEY}\n  siteUrl: {site}\n')
        print(f'[atlassian/rovodev] billing site preset to {site}')
        return 0

    with open(path, encoding='utf-8') as fh:
        lines = fh.read().split('\n')

    start = next((i for i, l in enumerate(lines) if l.strip() == KEY), None)
    if start is None:
        with open(path, 'a', encoding='utf-8') as fh:
            fh.write(f'\n{KEY}\n  siteUrl: {site}\n')
        print(f'[atlassian/rovodev] billing site preset to {site}')
        return 0

    for i in range(start + 1, len(lines)):
        line = lines[i]
        if line.strip() and not line.startswith((' ', '\t')):
            break  # next top-level key, so the block has no siteUrl
        match = re.match(r'^(\s*)siteUrl:\s*(.*)$', line)
        if not match:
            continue
        if match.group(2).strip() not in UNSET:
            return 0  # answered already
        lines[i] = f'{match.group(1)}siteUrl: {site}'
        break
    else:
        lines.insert(start + 1, f'  siteUrl: {site}')

    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))
    print(f'[atlassian/rovodev] billing site preset to {site}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
PRESET_SITE_PY
  chmod 0644 "${PRESET_SITE_SCRIPT}"

  # The hook takes email and token from the ENVIRONMENT, not from values
  # interpolated here: this script runs at image-build time behind a layer
  # cache, so a baked token would outlive a rotation (ADR 0018). The workbench
  # puts ATLASSIAN_ROVODEV_EMAIL / ATLASSIAN_ROVODEV_TOKEN into the workspace
  # runtime env from the feature's options, so a plain `monoceros apply` after
  # replacing the token is enough. Written unconditionally for the same
  # reason: at build time we do not yet know whether a token will be there.
  HOOK="${POST_CREATE_DIR}/atlassian-rovodev.sh"
  cat >"${HOOK}" <<'EOF'
#!/usr/bin/env bash
# Auto-generated by the Monoceros atlassian feature (rovodev).
#
# Runs on every container start and re-runs the login, so replacing the token
# on the host propagates with the next `monoceros apply`. acli's login is a
# single API call; the cost is nothing next to the container build.
#
# Never fails the apply. devcontainer's postCreate stops the whole remaining
# sequence on a non-zero exit, so a bad token would cost every later hook too.
set -uo pipefail

EMAIL="${ATLASSIAN_ROVODEV_EMAIL:-}"
TOKEN="${ATLASSIAN_ROVODEV_TOKEN:-}"

if [ -z "${EMAIL}" ] || [ -z "${TOKEN}" ]; then
  echo "[atlassian/rovodev] no ATLASSIAN_ROVODEV_TOKEN set, so Rovo Dev stays unauthenticated."
  echo "[atlassian/rovodev] Rovo Dev needs its OWN scoped token, not the one twg and Forge use:"
  echo "[atlassian/rovodev]   id.atlassian.com -> Security -> create an API token with scopes"
  echo "[atlassian/rovodev] Put it in monoceros-config.env (or <name>.env) as ATLASSIAN_ROVODEV_TOKEN, then re-apply."
  exit 0
fi

# Pre-set the billing site before the login, so the first `acli rovodev run`
# has nothing left to ask on stdin. Best-effort: a failure here costs a prompt,
# not the apply.
python3 /usr/local/share/monoceros/rovodev-billing-site.py "${ATLASSIAN_ROVODEV_SITE:-}" ||
  echo "[atlassian/rovodev] could not preset the billing site; the first run will ask for it" >&2

echo "[atlassian/rovodev] performing non-interactive Rovo Dev login for ${EMAIL}"
if printf '%s' "${TOKEN}" | acli rovodev auth login --email "${EMAIL}" --token; then
  echo "[atlassian/rovodev] auth login done."
  exit 0
fi

# acli answers a classic API token with a bare "authentication failed", which
# says nothing about what is actually wrong. Say it here instead.
echo "[atlassian/rovodev] login FAILED, so Rovo Dev is unauthenticated. Everything else in this container is unaffected." >&2
echo "[atlassian/rovodev] The usual cause is the wrong KIND of token: Rovo Dev only accepts a scoped one." >&2
echo "[atlassian/rovodev]   id.atlassian.com -> Security -> create an API token with scopes" >&2
echo "[atlassian/rovodev] Replace ATLASSIAN_ROVODEV_TOKEN on the host, then re-apply. To try it by hand: acli rovodev auth login" >&2
exit 0
EOF
  chmod 0755 "${HOOK}"
  echo "[atlassian/rovodev] post-create login hook installed"
fi

# ─── Teamwork Graph (twg) ─────────────────────────────────────────
if [ "${TWG}" = "true" ]; then
  echo "[atlassian/twg] installing via official install script"
  TMP="$(mktemp)"
  curl -fsSL -o "${TMP}" https://teamwork-graph.atlassian.com/cli/install
  # The official install script:
  #   - Downloads the binary; we pin install dir to /usr/local/bin so
  #     both root (build time) and node (runtime) have it on PATH.
  #   - Runs a `twg consent --source direct-public-installer` step
  #     that prompts on stdin. We feed it `yes` via a heredoc; the
  #     extra blank lines are harmless padding in case a future
  #     version adds more prompts. (The recorded consent lands in
  #     /root/.config/twg/ which is not visible to the node user at
  #     runtime — we re-record it as node in the post-create hook
  #     below.)
  #   - With --skip-login / --skip-skills we keep the install
  #     non-interactive. Auth is env-var based (see the workspaceEnv
  #     note below, no login step); skills install later as the node
  #     user so they persist into the bind-mounted home.
  #
  # Heredoc (not `yes ... |`) deliberately: a long-lived `yes` left
  # writing into a closed pipe after the install script exits gets
  # SIGPIPE'd, and our own `set -o pipefail` would then propagate
  # that 141 as a feature-install failure even though the install
  # actually succeeded.
  bash "${TMP}" \
    --install-dir /usr/local/bin \
    --skip-login \
    --skip-skills \
    <<'TWG_INSTALL_INPUT'
yes
yes
yes
TWG_INSTALL_INPUT
  rm -f "${TMP}"

  # The install script's mktemp + chmod +x leaves twg-bin at 0700
  # (only root can execute it). Re-chmod so the node user can run it.
  if [ -f /usr/local/bin/twg-bin ]; then
    chmod 0755 /usr/local/bin/twg-bin
  fi
  if [ -f /usr/local/bin/twg ]; then
    chmod 0755 /usr/local/bin/twg
  fi

  twg --version >/dev/null 2>&1 || {
    echo "[atlassian/twg] ERROR: install completed but \`twg\` is not on PATH" >&2
    exit 1
  }

  # twg authenticates purely from the TWG_USER / TWG_SITE / TWG_TOKEN
  # (+ optional TWG_BBC_TOKEN) env vars that the workbench injects into
  # the workspace runtime env from the shared account options
  # (feature.workspaceEnv, gated on the `twg` toggle): the same
  # keychain-free path as Forge. There is deliberately no login step.
  # Recent twg makes `twg login` OAuth-only, and it aborts without a TTY,
  # which is unavailable during `monoceros apply`'s postCreate. So the
  # post-create hook's only job is to (re-)install twg's agent skills as
  # the node user, which needs no credentials, so it runs whenever twg is
  # installed regardless of whether creds are set.
  HOOK="${POST_CREATE_DIR}/atlassian-twg.sh"
  cat >"${HOOK}" <<EOF
#!/usr/bin/env bash
# Auto-generated by the Monoceros atlassian feature (twg).
# Runs every container start. twg auth comes from the TWG_* env vars
# injected via feature.workspaceEnv; there is no login step here (recent
# twg's \`twg login\` is OAuth-only and needs a TTY). This hook only
# (re-)installs twg's agent skills as the node user.
set -euo pipefail

# (Re-)install twg's agent skills. Canonical install lands in
# /home/node/.agents/skills/twg (persisted via the feature's
# persistentHomePaths); .agents/skills-native agents (codex, cursor,
# gemini, copilot, …) read it directly. Agents with their own skills
# dir (claude -> .claude/skills, opencode -> .opencode/skills) need an
# explicit --agent flag, so we detect which AI CLIs are present in this
# container and pass the matching flags. This keeps the atlassian
# feature decoupled from the container's feature list: it reacts to
# whatever is actually installed. Idempotent: re-running just refreshes
# the wrappers.
echo "[atlassian/twg] (re-)installing twg skills"
TWG_SKILL_AGENTS=()
if command -v claude >/dev/null 2>&1; then
  TWG_SKILL_AGENTS+=(--agent claude)
fi
if command -v opencode >/dev/null 2>&1; then
  TWG_SKILL_AGENTS+=(--agent opencode)
fi
# Best-effort: twg installs latest (unpinned by design — the feature model
# is "always the current tool"), so its CLI can change flags across
# releases and has broken this call before. A failure here must NOT fail
# the whole post-create; warn and carry on with the skills simply absent.
if ! twg skills install --yes "\${TWG_SKILL_AGENTS[@]}"; then
  echo "[atlassian/twg] WARN: 'twg skills install' failed — twg's CLI may have changed. Container continues; twg agent skills are not installed until the feature is updated." >&2
fi
EOF
  chmod 0755 "${HOOK}"
  echo "[atlassian/twg] post-create skills hook installed; auth via TWG_* workspace env"
  if [ -z "${INSTANCE}" ] || [ -z "${EMAIL}" ] || [ -z "${APITOKEN}" ]; then
    echo "[atlassian/twg] instance/email/apiToken not all set; set them in the container yml so TWG_USER/TWG_SITE/TWG_TOKEN reach the shell (otherwise run \`twg login\` once in the container)"
  fi
fi

# ─── Forge (@forge/cli) ───────────────────────────────────────────
if [ "${FORGE}" = "true" ]; then
  # Forge is a Node CLI; the runtime ships Node, so a global npm install
  # is enough. No post-create login hook: `forge login` stores creds in
  # the OS keychain (libsecret on Linux), which we deliberately do not
  # carry. Instead Forge reads FORGE_EMAIL / FORGE_API_TOKEN at command
  # time; the workbench injects them into the workspace runtime env from
  # this feature's `email` / `apiToken` options (feature.workspaceEnv),
  # so the right account is in scope without a login step here.
  # Unpinned on purpose (the feature model: latest at build, refreshed by
  # `monoceros upgrade`). Deliberately WITHOUT `@latest`, so npm's
  # engine-aware resolution picks the newest version this container's Node
  # actually satisfies. That difference is not academic: @forge/cli 13.3.0
  # declares `>=20.18.1 <22.23.1 || >22.23.1 <24.17.0 || >24.17.0`, which
  # excludes exactly two Node point releases, and one of them is the 22.23.1
  # that the base image ships. `@latest` would install it anyway, over its
  # author's explicit exclusion. So npm holds it at 13.0.0, forge warns that
  # it is out of date, and the reason is invisible unless we say it.
  echo "[atlassian/forge] installing @forge/cli globally via npm"
  npm install -g @forge/cli
  forge --version >/dev/null 2>&1 || {
    echo "[atlassian/forge] ERROR: install completed but \`forge\` is not on PATH" >&2
    exit 1
  }
  # `forge --version` is not one line. On a Node it considers unsupported it
  # prints two warning lines first, and piping that into `head -1` closes the
  # pipe early: under `pipefail` the assignment fails, `set -e` takes the whole
  # feature down, and the build says "failed to install" with nothing above it.
  # So capture the output whole and pick the version out of it. The first line
  # is not the version either, which is the other half of the same bug: it used
  # to end up in the note as the installed "version".
  FORGE_VERSION_OUT="$(forge --version 2>/dev/null || true)"
  FORGE_INSTALLED=""
  if [[ "${FORGE_VERSION_OUT}" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    FORGE_INSTALLED="${BASH_REMATCH[1]}"
  fi
  FORGE_LATEST="$(npm view @forge/cli version 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -n "${FORGE_INSTALLED}" ] && [ -n "${FORGE_LATEST}" ] &&
    [ "${FORGE_INSTALLED}" != "${FORGE_LATEST}" ]; then
    echo "[atlassian/forge] installed ${FORGE_INSTALLED}, not ${FORGE_LATEST}: that version declares a Node range this container's $(node --version) does not satisfy, so npm kept the newest compatible one."
    # And again as a feature note, so it reaches the end of `monoceros apply`.
    # The build log is not a channel: it scrolls past behind the spinner, and a
    # cached rebuild does not produce it at all while this still holds.
    mkdir -p /usr/local/share/monoceros/notes.d
    cat >/usr/local/share/monoceros/notes.d/atlassian-forge.txt <<NOTE
forge is ${FORGE_INSTALLED}, not the latest ${FORGE_LATEST}: this container runs Node $(node --version), which ${FORGE_LATEST} excludes in its engines field, so npm installed the newest one that fits. \`forge\` will say it is out of date.
Pinning a different Node major for this workbench (\`monoceros add-language <container> node:<major>\`, then re-apply) gets the newer forge.
NOTE
  else
    rm -f /usr/local/share/monoceros/notes.d/atlassian-forge.txt 2>/dev/null || true
  fi
  if [ -z "${EMAIL}" ] || [ -z "${APITOKEN}" ]; then
    echo "[atlassian/forge] no email/apiToken set — set them in the container yml so FORGE_EMAIL/FORGE_API_TOKEN reach the shell"
  fi

  # Forge asks for analytics consent on first use, on stdin. An agent calling
  # `forge` hits that prompt and stops there, and the answer lands in the NODE
  # user's config, so answering it at build time (as root) would not help.
  # Record it in the hook instead, which runs as node, and default to off:
  # nothing about a local dev container should phone home unasked.
  HOOK="${POST_CREATE_DIR}/atlassian-forge.sh"
  cat >"${HOOK}" <<'EOF'
#!/usr/bin/env bash
# Auto-generated by the Monoceros atlassian feature (forge).
#
# Pre-answers the Forge CLI's analytics consent so it never prompts on stdin,
# where a non-interactive `forge` call would hang. The file lives under
# ~/.config/@forge, which the feature persists, so this is a no-op once set.
# Never fails the apply: postCreate aborts the whole remaining sequence on a
# non-zero exit, and a consent flag is not worth that.
set -uo pipefail

CONFIG="${HOME}/.config/@forge/cli-nodejs/config.json"
if [ -f "${CONFIG}" ] && grep -q '"analytics-preferences"' "${CONFIG}" 2>/dev/null; then
  exit 0
fi
if forge settings set usage-analytics false >/dev/null 2>&1; then
  echo "[atlassian/forge] analytics consent recorded as off"
else
  echo "[atlassian/forge] could not record the analytics consent; \`forge\` may prompt once" >&2
fi
exit 0
EOF
  chmod 0755 "${HOOK}"
  echo "[atlassian/forge] post-create consent hook installed"
fi

echo "[atlassian] done"
