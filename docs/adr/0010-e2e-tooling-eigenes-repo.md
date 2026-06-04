# ADR 0010 — E2E tooling in its own repo, maintainer-facing

- Status: accepted
- Date: 2026-05-28

## Context

M5 Task 4 (originally "test-plan rewrite") was repurposed on 2026-05-28
into an automated E2E test module (see backlog).
The manual test instructions in `docs/test-plan.md` are wired against a
long-obsolete CLI model; updating them line by line isn't worth it.

The obvious idea would have been a **GH Actions matrix** that runs
Linux / macOS / Windows in parallel. That turned out to be the wrong
hammer for several reasons:

- **macOS and Windows runners don't have Docker out of the box.**
  Linux runners: Docker native, fast. macOS: install colima or Docker
  Desktop via Brew — 3-5 min setup, fragile. Windows:
  Docker Desktop only in certain runner images, Linux container
  mode has to be switched on.
- **The bugs we actually want to catch are platform-specific
  tooling quirks** (macOS Docker Desktop launchd
  sockets, Windows wincred, UTF-8 in PowerShell, EACCES on
  privileged ports under Linux without CAP_NET_BIND_SERVICE).
  These show up on **real** machines, not in the sanitized
  runner environment.
- **Builder reality ≠ runner reality.** Whoever ends up using Monoceros
  has installed it via `install.sh` / `install.ps1` on their
  machine, and runs `monoceros …` from there. CI runs
  in sandbox containers don't simulate that.

## Rejected: CI matrix sweep as the main path

Three OSes × 5 scenarios × setup cost per run = very expensive, very
fragile, and in the end says little about the real builder experience.

## Decision

A **maintainer-facing E2E tool** that runs on the three real
builder machines (Thorsten's Linux box, Mac, Windows
laptop), drives Monoceros through the **public CLI interface**,
and runs a defined set of scenarios. An add-on to the
workbench, not built in.

### Repo separation

The tool lives in its **own repo** (`getmonoceros/monoceros-e2e`,
final name decided at creation time). Three reasons:

1. **Interface contract** — if the E2E tool lives in the same repo
   as the CLI code, the temptation is strong to import internal
   modules instead of calling the CLI. Separation enforces the
   discipline: the tool only knows subcommands, arguments, and
   exit codes — exactly what a builder has too.
2. **Independent release cycle** — new scenarios can be
   shipped without needing a CLI release.
3. **Clarity** — the workbench repo stays focused on the
   product; the tool _we_ use to test it is a separate
   thing.

### Surface: `monoceros e2e <…>`

Despite the repo separation, the invocation for the maintainer should be
**`monoceros e2e <scenario>`**, not `monoceros-e2e <scenario>`. One surface,
one mental model. Realized via **git-style plugin discovery**:

- `monoceros` itself only knows a small dispatcher: if the
  first argument is `e2e` and a binary `monoceros-e2e` is on the
  `PATH`, the remaining arguments are passed through to the binary.
- If the binary doesn't exist: a clear error message with the
  install curl command.
- The `__complete` engine offers `e2e` as a subcommand when
  the binary is installed (detected via `which`/`where`).

Models: `git foo` → `git-foo`, the `kubectl plugin` system.

### Installation

Analogous to the workbench: an `install.sh` / `install.ps1` bouncer in the E2E
repo that installs the npm package globally. On a workbench
installation:

```sh
# Linux / macOS
curl -fsSL https://getmonoceros.github.io/e2e/install.sh | bash

# Windows
iwr -useb https://getmonoceros.github.io/e2e/install.ps1 | iex
```

Update path: run the script again.

### Scenarios

Initially five, written as TypeScript functions (full language,
arbitrary asserts) — _not_ as a YAML/JSON DSL. The asserts
vary enough ("TCP probe", "HTTP 200", "`docker ps -a` must
be empty after remove") that a DSL would soon hit its limits.

| Scenario            | What it proves                          | Time     |
| ------------------- | --------------------------------------- | -------- |
| `minimal`           | init → apply → run → remove lifecycle   | ~1 min   |
| `with-services`     | Compose + service network via TCP probe | ~2 min   |
| `with-port`         | Traefik routing via fixture repo + HTTP | ~2 min   |
| `with-tunnel`       | TCP tunnel + Node probe from the host   | ~2-3 min |
| `image-mode-zombie` | `remove` clears image-mode containers   | ~1.5 min |

Three mechanics decisions:

- **Postgres reachability** in `with-services` is checked via the Bash
  builtin `</dev/tcp/postgres/5432`, not via the `psql` client.
  It only says "TCP works", but it saves the tool footprint in the workspace.
- The **HTTP probe** in `with-port` uses the existing fixture repo
  `getmonoceros/monoceros-e2e-fixture` (`serve-ports.mjs`), which
  was created for exactly this purpose.
- The **tunnel probe** in `with-tunnel` is a TCP connect from Node,
  _not_ `psql` from the host — it avoids cross-OS host deps
  (apt / brew / scoop).

### Lifecycle per scenario

- Default: setup → asserts → teardown (`monoceros remove --no-backup
--yes`).
- `--keep`: no automatic remove, the container stays around for
  manual inspection. Output shows the container name
  - the remove command.
- `--interactive`: wait for user confirmation after the asserts,
  before remove runs.
- Ctrl+C: everything stays in place, no cleanup attempt. Inconsistent
  state is cleared on the **next** start.

### Pre-flight cleanup

Containers and yml profiles that the scenarios create follow a
fixed naming convention:

```
e2e-<scenario>-<YYYY-MM-DD-HHMM>
```

Example: `e2e-minimal-2026-05-28-1830`. Before every test start
(whether single or via `--all`):

1. List `$MONOCEROS_HOME/container-configs/e2e-*.yml` → for each,
   `monoceros remove --no-backup --yes <name>`.
2. Emergency brake for zombies that `monoceros remove` no longer
   knows about: `docker ps -aq --filter "name=^e2e-"` → `docker rm -f`.

That way the maintainer can hit Ctrl+C at any time without corrupting
state — the next invocation cleans up anyway.

### Output format

- **Pretty-print** (default) — colored, with step-by-step status,
  per-scenario timing.
- **GitHub annotations** when `GITHUB_ACTIONS=true` is detected —
  `::error::` / `::notice::` markers that show up in the PR UI as inline
  annotations.
- No JUnit XML — there's no test aggregator in the pipeline that
  would consume it.

### CI integration

Smoke-test job on Linux runner only, runs on every main push and
PR (via the reusable precheck mechanism or as its own job).
Runs **only the `minimal` scenario** — proof of life that the
CLI is baseline-functional. macOS and Windows remain manual
runs on the builder machines.

Effort argument: the Linux smoke test is ~1 min of runner time. A macOS/Windows
smoke test would add 5-10 min of setup per run and only catch a
subset of the real builder quirks. Bad trade.

## Consequences

- **The workbench repo gets minimally invasive changes**:
  plugin dispatch (`commands/e2e.ts`, a few lines) and an
  optional entry in the completion spec. Otherwise unchanged.
- **A new repo** `getmonoceros/monoceros-e2e` with its own release
  workflow, its own npm package, its own install.sh/install.ps1.
- **Builder OS coverage** comes from real machines, not
  from a CI matrix. That doesn't scale arbitrarily, but for three OSes
  with a single maintainer it's exactly right.
- **A model for future tools**: when more maintainer-facing
  tools come up (e.g. `monoceros doctor` for diagnostics), the
  "own repo, git-style plugin" pattern is reusable.
