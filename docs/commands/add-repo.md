# `monoceros add-repo`

Registers a Git repository that gets cloned to `projects/<path>/` on
the next container build.

## Purpose

A solution consists of a workspace wrapper (`.devcontainer/`,
`.monoceros/`, `home/`) and one or more code repos in `projects/`.
`add-repo` makes these repos declarative — add them once, and from then
on every container rebuild and every new builder who takes over the
solution automatically clones the same sources.

What it is **not**:

- Not an ad-hoc `git clone` (that happens on the next `monoceros apply`,
  not on the `add-repo` call itself).
- Not a push mechanism (inside the container use `git push` as usual —
  auth works via the host credential helper, see below).
- No SSH auth (see [ADR 0006](../adr/0006-https-only-repo-auth.md) —
  Monoceros supports HTTPS URLs).

## Synopsis

```sh
monoceros add-repo <containername> <url> [--path=<folder>] \
                   [--git-name=<name> --git-email=<email>] \
                   [--provider=github|gitlab|bitbucket|gitea] [--yes]
```

## Options

| Flag                  | Meaning                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--path=<folder>`     | Override the target path under `projects/`. Subfolders allowed (`apps/web`). Default: derived from the URL (`bar.git` → `bar`).                                                                                                                                                                                                                              |
| `--git-name=<name>`   | Per-repo Git committer name. Overrides the container-level `git.user.name`. Pair with `--git-email`.                                                                                                                                                                                                                                                         |
| `--git-email=<email>` | Per-repo Git committer email. Pair with `--git-name`. Both together or not at all. Also accepts a `${VAR}` placeholder (resolved from `<name>.env`); a literal value is checked for valid format immediately.                                                                                                                                                |
| `--provider=<name>`   | Git provider hint (`github` \| `gitlab` \| `bitbucket` \| `gitea`). **Required for hosts other than `github.com` / `gitlab.com` / `bitbucket.org`.** Controls which CLI setup instructions the pre-flight shows when credentials are missing. Redundant for the three canonical hosts (auto-detected). `gitea` also covers Forgejo — same API, same UI flow. |
| `--yes` / `-y`        | Skip the confirmation prompt.                                                                                                                                                                                                                                                                                                                                |

## Mechanics

1. The container yml `$MONOCEROS_HOME/container-configs/<containername>.yml`
   gets an entry in `repos:`. Order is preserved — if clones build on
   each other, add them in the desired order. Comments and other fields
   are left untouched.
2. On the next `monoceros apply <containername>`,
   `.devcontainer/post-create.sh` regenerates. Each repo gets an
   idempotency block:
   ```bash
   if [ ! -d "projects/bar" ]; then
     echo "→ Cloning bar from https://github.com/foo/bar.git…"
     git clone "https://github.com/foo/bar.git" "projects/bar"
   else
     echo "→ projects/bar already exists, skipping clone"
   fi
   ```
   If a per-repo `git.user` is set, two
   `git -C projects/bar config user.name/email` lines follow right after.
3. `<containername>.code-workspace` gets an additional folder root for
   `projects/<path>/`. When opened in VS Code, the repo appears as its
   own column in the Explorer. If the repo's host is GitHub or GitLab,
   the matching editor extension (PR + Actions, or GitLab Workflow) is
   added to the workspace's extension **recommendations** — a soft
   prompt, not an auto-install (see ADR 0016).
4. On the container build, `git clone` runs. Auth happens via HTTPS
   credentials that `monoceros apply` pulls from the host Git credential
   system (see the Auth section below).

## URL format

**HTTPS-only.** Accepted URLs:

| URL                                                  | Folder under `projects/` |
| ---------------------------------------------------- | ------------------------ |
| `https://github.com/foo/bar.git`                     | `bar`                    |
| `https://github.com/foo/bar`                         | `bar`                    |
| `https://gitlab.com/group/sub/repo.git`              | `repo`                   |
| `https://github.com/foo/bar.git` + `--path=apps/web` | `apps/web`               |

SSH URLs (`git@github.com:…`, `ssh://…`) are rejected by the schema
with a clear error message. See
[ADR 0006](../adr/0006-https-only-repo-auth.md) for the rationale — in
short: HTTPS covers every realistic Git host (GitHub, GitLab, Gitea,
Bitbucket — all of them have personal access tokens) and avoids
platform-specific SSH agent forwarding complexity on macOS and Windows
Docker Desktop.

**Take the URL from the Git host's "Clone" / "Clone or download"
dialog** — there's usually an HTTPS tab next to the SSH tab.

## Idempotency

- **Same URL, same path** → no-op.
- **Same URL, different path** → new entry (a second clone of the repo
  into a different folder — rare, but allowed).
- **Same path, different URL** → validation error on apply
  ("Duplicate repo path"). Rename one of them with `--path`.
- **If the folder under `projects/<path>/` already exists** → the clone
  step is skipped; your local changes are left untouched. Even after a
  `monoceros apply` with a container rebuild.

## Path derivation

The default path is derived automatically from the URL (last segment,
`.git` stripped). Override it via `--path=<folder>` when the default
name is awkward or you want subfolders:

```sh
monoceros add-repo sandbox https://github.com/foo/bar.git              # → projects/bar
monoceros add-repo sandbox https://github.com/foo/bar.git --path=ui    # → projects/ui
monoceros add-repo sandbox https://github.com/foo/web.git --path=apps/web   # → projects/apps/web
```

## Examples

Single public repo:

```sh
monoceros add-repo sandbox https://github.com/foo/bar.git
monoceros apply sandbox
ls $MONOCEROS_HOME/container/sandbox/projects/bar/
```

With a subfolder path:

```sh
monoceros add-repo sandbox https://github.com/foo/web.git --path=apps/web
monoceros apply sandbox
```

Multiple repos:

```sh
monoceros add-repo sandbox https://github.com/myorg/api.git
monoceros add-repo sandbox https://github.com/myorg/web.git
monoceros add-repo sandbox https://github.com/myorg/types.git --path=shared
monoceros apply sandbox
```

Self-hosted GitLab (`provider` is required, otherwise the pre-flight
doesn't know which CLI instructions to show):

```sh
monoceros add-repo dev https://git.firma.de/team/app.git --provider=gitlab
monoceros apply dev
```

Self-hosted Gitea (or Forgejo — same provider value, same auth flow):

```sh
monoceros add-repo dev https://gitea.example.com/team/app.git --provider=gitea
monoceros apply dev
```

Per-repo committer identity (work vs. personal):

```sh
monoceros add-repo dev https://github.com/conciso/api.git \
  --git-name="Thorsten Kamann" --git-email=thorsten.kamann@conciso.de
monoceros add-repo dev https://github.com/kamann-info/blog.git \
  --git-name="Thorsten Kamann" --git-email=thorsten@kamann.info
```

Layout in the materialized container afterward:

```
$MONOCEROS_HOME/container/sandbox/
  home/  .devcontainer/  .monoceros/
  sandbox.code-workspace
  projects/
    api/      ← cloned
    shared/   ← cloned
    web/      ← cloned
    apps/web/ ← cloned (subfolder)
```

## Validation

- **URL**: must start with `https://`, URL-safe characters only.
  SSH-style URLs (`git@host:…`, `ssh://…`, `git://…`) are rejected with
  an error message.
- **Path**: must match `[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*`. Slashes for
  subfolders are allowed, no leading/trailing `/`, no `..` or `.`
  segments.
- **Git identity**: `--git-name` and `--git-email` only together. Email
  must match `<...>@<...>.<...>`.
- **Provider**: Only `github` / `gitlab` / `bitbucket` allowed. For host
  `github.com` / `gitlab.com` / `bitbucket.org` the value is redundant
  (auto-detected) and may at most match the canonical provider — a
  contradiction is rejected. For other hosts, `--provider` is required,
  otherwise an error message.

## Auth

### HTTPS credentials

On every `monoceros apply`, `git credential fill` runs host-side per
unique host (`github.com`, `gitlab.com`, your Gitea instance, …):

- Host git asks your local credential helper (macOS Keychain, Windows
  Credential Manager, Linux libsecret, `gh auth setup-git` for GitHub
  specifically) — this is an OS detail you never notice because your
  host has already configured it.
- Result: username + token land in
  `<container-dir>/.monoceros/git-credentials` (mode `0o600`).
- Inside the container, `credential.helper = store --file=<workspace>/.monoceros/git-credentials`
  is configured → reads the file → clones/pushes without a prompt.

If your host helper hasn't stored anything for a host yet, the host
helper UI prompts during `monoceros apply` (Keychain popup, GCM window,
terminal prompt — depending on the OS). After this one-time step it's
stored and subsequent applies are silent.

The credentials file is **rewritten on every apply** — stale tokens
(revoked, expired) are automatically replaced by freshly host-fetched
ones.

**If no credential helper is configured host-side**: `git credential
fill` returns empty, the container clone fails with "could not read
Username for `<host>`: No such device or address". Per-OS setup
instructions are in the `monoceros init` docs under "Prerequisites".

### Commit identity (`user.name` / `user.email`)

Resolution per repo (highest priority wins):

1. Per-repo `git.user` from the container yml (set via
   `--git-name`/`--git-email`)
2. Container-level `git.user`
3. `defaults.git.user` from `~/.monoceros/monoceros-config.yml`
4. Host-side `git config --global --get user.name/email`
5. Persisted in `.monoceros/gitconfig` (from an earlier apply)
6. Interactive prompt (if TTY)

post-create.sh sets `git -C projects/<path> config user.name/email`
right after the clone, so the per-repo identity takes effect from the
first commit.

#### `${VAR}` from `<name>.env`

`git.user.name` / `git.user.email` (per-repo **and** container-level)
may carry `${VAR}` placeholders that are resolved from `<name>.env` on
apply — that way the identity doesn't live in the shareable yml:

```yaml
repos:
  - url: https://github.com/conciso/logoscraper.git
    git:
      user:
        name: ${GIT_USER_NAME}
        email: ${GIT_USER_EMAIL}
```

```sh
# container-configs/<name>.env  (gitignored)
GIT_USER_NAME=Thorsten Kamann
GIT_USER_EMAIL=thorsten.kamann@conciso.de
```

The cascade is preserved: if one of the vars is **missing** from the
`.env`, the per-repo override is **discarded entirely** (all-or-nothing,
no mixed identity) and the repo falls back to the next level
(monoceros-config → host → prompt). At the container level, fallback
happens **per field**. A resolved but invalid value
(`GIT_USER_EMAIL=quatsch`) aborts the apply with a clear message — the
format check deliberately sits **after** resolution, not at parse time.

`add-repo --git-email` also accepts a `${VAR}` placeholder; a literal
value is checked for valid format immediately on input.

**Scaffolding on the first repo:** If the container doesn't have a
`git.user` yet, `add-repo` (like `init`) automatically creates a
container-level `git.user` with `${GIT_USER_NAME}`/`${GIT_USER_EMAIL}`
placeholders and seeds the empty keys into `<name>.env`. An existing
`git.user` (literal or placeholder) is left untouched. Empty keys → the
cascade fills in the identity on apply.

## On-the-fly clone with a running container

If the container for the name is currently running, `add-repo` clones
the repo directly into `projects/<path>/` in the container — no
`monoceros apply` needed. Mechanics:

1. Find the container via the Docker label
   `devcontainer.local_folder`. Not running → fallback: only update the
   yml, with a note showing the `apply` command for later.
2. Fetch host-side HTTPS credentials for the repo host (same mechanism
   as the apply pre-flight). No credentials → the yml stays updated,
   with a note showing what to do (`gh auth login` etc.).
3. `docker exec` in the running container: `mkdir -p projects/<parent>`,
   then `git clone <url> projects/<path>`. Idempotent — if the folder
   already exists, it's skipped.
4. If `--git-name`/`--git-email` was set: `git -C projects/<path> config
user.name/email` right after the clone.

All errors in the on-the-fly path leave the yml change **in place** — a
later `monoceros apply` catches up. The yml is the truth; the container
clone is a convenience.

## Related commands

- `monoceros init <name> --with-repo=<url>` — pull a repo in directly
  when creating the container yml. Also triggers the identity prompt if
  needed.
- `monoceros apply <name>` — rebuild the container if the on-the-fly
  clone didn't kick in (container wasn't there, etc.).
- `monoceros run <name> -- git status` — Git operations in the
  container.
- `monoceros remove-repo <name> <url-or-path>` — the inverse.

## Failure modes

- **`Invalid repo URL. Only HTTPS URLs are supported`** — you wrote an
  SSH-style URL. Use the HTTPS variant from the Git host's clone dialog.
- **`Invalid repo path`** — path contains forbidden characters or
  `..`/`.` segments. Check the charset, no leading/trailing `/`.
- **`Duplicate repo path`** — two repos claim the same
  `projects/<path>/` slot. Rename one of them with `--path`.
- **Clone fails with `could not read Username for '<host>'`** — no
  credential helper host-side, or the helper has no entry for this host.
  On macOS use `gh auth setup-git` for GitHub, or manually `git config
--global credential.helper osxkeychain` plus a one-time `git ls-remote
<https-url>` to store a token.
- **Clone fails with `Repository not found`** — wrong URL, or the repo
  is private _and_ the token has no access rights. Check the token
  scopes on GitHub (at least `repo` for private repos).

- **`Cannot reach declared repo: …` on `monoceros apply`** — pre-flight
  stage 2 ran `git ls-remote <url>` host-side and got an error. Three
  common causes:
  - **Repository not found / may not have access** → check the URL
    (case-sensitive), check workspace membership, broaden the token
    scope (GitHub: `repo`, GitLab: `read_repository`, Bitbucket: repo
    read).
  - **Authentication failed** (creds present, rejected) → token expired
    or revoked. Regenerate, re-run `gh auth login` / `glab auth login`.
  - **Could not resolve host** → DNS / VPN / offline. For company hosts:
    check the VPN.
