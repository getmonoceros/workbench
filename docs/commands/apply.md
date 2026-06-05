# `monoceros apply`

Materializes a container config into
`$MONOCEROS_HOME/container/<name>/` and brings the dev container up.

```sh
monoceros apply <name>
```

## Purpose

`monoceros apply` is the step that writes a yml config concretely to
the filesystem:

1. Reads `$MONOCEROS_HOME/container-configs/<name>.yml`.
2. Validates schema (fields, regex constraints) and catalog (do the
   referenced languages/services exist?).
3. Generates into `$MONOCEROS_HOME/container/<name>/`:
   - `.devcontainer/devcontainer.json`, plus `compose.yaml` if applicable
   - `.devcontainer/post-create.sh`
   - `<name>.code-workspace` — multi-root workspace; the root folder is
     labelled `🦄 Monoceros`, and context-derived editor extensions (a DB
     client when a DB service is present, host tooling for GitHub/GitLab
     repos) are added as **recommendations** (see ADR 0016)
   - `.vscode/settings.json` — Explorer denoise for the root folder
     (hides the scaffold, leaves `home/`, `logs/`, `AGENTS.md`,
     `CLAUDE.md` visible)
   - `.claude/settings.json`
   - `.monoceros/.gitignore`
   - **`AGENTS.md`** + **`CLAUDE.md`** + **`.monoceros/commands.md`** —
     container briefing for AI tools inside the container (see
     [`docs/ai-tools.md`](../ai-tools.md#container-briefing--agentsmd--claudemd)).
4. Writes `.monoceros/state.json` with `origin: <name>`,
   `schemaVersion`, `monocerosCliVersion`, `materializedAt`.
5. Fetches the Git identity host-side (see priority below) and, for
   HTTPS repos, the credentials.
6. Brings the container up — compose mode with force-remove plus
   `devcontainer up`, image mode with
   `devcontainer up --remove-existing-container`.

Idempotent: a second apply with the same config overwrites the
scaffold files and restarts the container.

cwd is irrelevant — the command works from anywhere.

## Synopsis

```sh
monoceros apply <name> [--verbose]
```

## Arguments

| Argument    | Meaning                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `<name>`    | Config name. Resolves to `$MONOCEROS_HOME/container-configs/<name>.yml`.                                               |
| `--verbose` | Streams the raw `@devcontainers/cli` output instead of a spinner display. Auto-on when stderr is not a TTY (CI, pipe). |

## Safety check

The target directory `$MONOCEROS_HOME/container/<name>/` must either be
empty or already carry a `state.json` with a matching `origin: <name>`.
Otherwise it errors — this protects against accidentally overwriting an
existing dev container that belongs to a **different** config.

## Git identity resolution

`user.name` / `user.email` for the container are determined in this
order:

1. **Container yml** `git.user` (highest priority — explicit
   per-container choice)
2. **`$MONOCEROS_HOME/monoceros-config.yml`** `defaults.git.user`
   (workbench-wide defaults)
3. **Host** `git config --global --get user.name|email`
4. **Value from an earlier apply** in `.monoceros/gitconfig`
5. **Interactive prompt** (TTY sessions only; otherwise undefined)

When the prompt kicks in (stage 5 is the only source), Monoceros also
asks where the entered values should be persisted:

- **`g` (Global)** — `monoceros-config.yml` `defaults.git.user`. Becomes
  the default for every container on this machine. The default choice,
  because it usually fits.
- **`c` (Container)** — `<name>.yml` `git.user`. This container only.
- **`b` (Both)** — global default plus a container-specific override.

In non-interactive sessions (CI, scripts) `g` is chosen automatically —
otherwise the values would stay only in this container's
`.monoceros/gitconfig` and would have to be re-entered for the next new
container.

## Examples

First setup:

```sh
$ monoceros init nodejs-github sandbox
$ monoceros apply sandbox
✔ Materialized config 'sandbox' into …/container/sandbox. Starting container…
```

Edit + re-apply:

```sh
$ monoceros add-service sandbox postgres --yes
$ monoceros apply sandbox
```

A second config in the same home:

```sh
$ monoceros init python data-pipeline
$ monoceros apply data-pipeline
```

Both containers coexist under `$MONOCEROS_HOME/container/`.

## Related commands

- `monoceros init` — create a config ([init.md](./init.md))
- `monoceros add-*` / `monoceros remove-*` — edit a config
  (comment-preserving). After each call run `monoceros apply <name>`
  to materialize.
- `monoceros down <name> [--volumes]` — remove the container before a
  destructive re-apply.

## Output

In default mode (TTY, without `--verbose`) the container section shows
a spinner with phase labels instead of the raw `@devcontainers/cli`
output, followed by an inventory of what was just materialized in the
container:

```
▸ Container

  ⠹ starting container…
  ⠹ running postCreate…
  ✔ container ready (28s)

  Languages     node
  Services      postgres, redis
  Features      claude-code, atlassian
  Repositories  my-app, sandbox-utils
  Ports         3000, 5173
  APT packages  make, openssl

  log: ~/.monoceros/container/<name>/logs/apply-<name>-<…>.log
```

The summary block lists only the sections that are set in the yml —
empty ones are dropped. Features and repos are shown by their short
name (last path component, without `:tag`), so the lines don't get
bloated by GHCR URLs.

Recognized phases:

| Trigger in stream               | Phase                      |
| ------------------------------- | -------------------------- |
| `Start: Run: docker build`      | `building feature layers…` |
| `Start: Run: docker run`        | `starting container…`      |
| `Running the postCreateCommand` | `running postCreate…`      |

If an apply aborts, the spinner replaces the success case with a
`✘ apply failed` block containing the last ~15 lines of the
`devcontainer-cli` stream (so you see the real diagnosis) and a
reference to the log file.

`--verbose` turns the spinner off and streams the full output live as
before. Use it to debug the workbench itself or when you want to follow
the postCreate output step by step. It is enabled automatically in
non-TTY environments (CI, piped output).

## Log file

Every apply writes a full transcript **in addition** to the terminal
output, to:

```
$MONOCEROS_HOME/container/<name>/logs/apply-<name>-<ISO-timestamp>.log
```

Contents: a small header (command, start time, CLI version, config
path, host) plus everything that would otherwise appear on the terminal
— including the complete `@devcontainers/cli` stream (pull, build,
container start, and postCreate output) and the "First apply takes
~1–2 min" pre-warning, which in spinner mode now only lands in the log.
ANSI color codes are stripped so that `cat` and `grep` work directly.

At the end of the apply output, a `log: …` line points to the file —
also in the failure case. The `logs/` folder lives under
`container/<name>/` and is cleaned up along with `monoceros remove <name>`.

## AI tool briefing

Every apply (re)generates three files at the container workspace root,
so that Claude Code & co. know the real stack inside the container:

- `AGENTS.md` — stack inventory (languages, services, tools, repos,
  ports) plus behavior rules (declarative model, extension commands).
- `CLAUDE.md` — `@AGENTS.md` import between the same markers.
- `.monoceros/commands.md` — complete CLI reference, pulled via
  `@.monoceros/commands.md` from `AGENTS.md`.

`AGENTS.md` and `CLAUDE.md` are both surrounded by HTML comment markers.
Apply overwrites only the content **between** the markers — user
additions above/below are preserved across `apply`. `.monoceros/commands.md`
is 100% Monoceros-owned and is always rewritten completely.

On the first Claude start in a project, an "Allow external CLAUDE.md
file imports?" dialog appears once — accept it, the files are
Monoceros-generated. Full mechanism in
[`docs/ai-tools.md`](../ai-tools.md#container-briefing--agentsmd--claudemd).

## Failure modes

- **`No such config: <path>`** — the config does not exist.
  Fix: `monoceros init <template> <name>` first.
- **`already materialized from config 'X', not 'Y'`** — the target
  folder belongs to a different config. Fix: `monoceros apply X`
  (re-apply against the original config) or delete the folder.
- **`Refusing to materialize into non-empty directory`** — the target
  folder has foreign content and no state.json. Fix: delete the folder
  or choose a different config name.
- **`Unknown language: X` / `Unknown service: X`** — a catalog entry is
  missing. Schema validation passed, but the value is not in the list
  of supported languages/services.
- **`Invalid config name`** — the name contains a slash, space, or
  shell metacharacter. Only `[A-Za-z0-9._-]+` is allowed.
- **`Missing Git credentials for <host>`** — for each `repos:` host the
  apply fetches the HTTPS credentials **host-side** (via the credential
  helper) and mounts them into the container, so the clone there is
  authenticated. If it finds none, it aborts **before** the Docker build
  with provider-specific hints (e.g. `gh auth login`). This is a
  **local** check (no network access to the Git host) — it only checks
  whether a credential is present.
- **Repo clone fails** — repos are cloned **inside the container**
  (post-create.sh, with the mounted credential helper). If a clone fails
  (wrong/expired token, mistyped URL, host unreachable), the real git
  message appears in the container build log. Common cases:
  `could not read Username` → no credential; `Invalid username or token`
  → token expired / without org access (GitHub SSO!) / without `repo`
  scope. The clone uses the **container** environment — host-specific
  quirks (VPN DNS, VS Code `GIT_ASKPASS`) deliberately no longer play a
  role here.
