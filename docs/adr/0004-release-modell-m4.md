# ADR 0004 — Release model: N independent deployments, version-triggered

- Status: accepted
- Date: 2026-05-19

## Context

With M4, Monoceros leaves the "I clone the workbench repo and work
inside it" stage. A builder who has never seen the repo should be able
to install the tool and spin up containers. That raises questions the
M4 brief only half-answered:

- What exactly gets distributed where?
- Who triggers a release, and when?
- How does CI know whether there's anything to do for a given
  component?
- Do we need a staging environment?
- What physically lands on the user's machine — and what does Docker
  pull at runtime?
- Windows counts as a target platform.

When trying to do this pragmatically via a script plus manual publish
(see the reverted commit `ac1c081`), it became clear that the brief
implicitly assumed "one CLI plus one feature library" — that is, two
deployments. That's not right. Today there are five deployments (CLI +
runtime image + three features), and the number grows with every
additional feature on the backlog. "Feature" is a category, but not a
shared release artifact.

## Decision

### Artifact types and independent versioning

There are three types of release artifacts. Each instance of a type is
a standalone deployment with its own version number, its own release
cycle, and its own CI trigger.

| Typ               | Versionsquelle                                               | Distributionsziel                                          |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| **CLI**           | `packages/cli/package.json` `version`                        | GitHub Releases with platform-specific artifacts           |
| **Runtime image** | `images/runtime/VERSION` (to be created)                     | `ghcr.io/getmonoceros/monoceros-runtime:<version>`         |
| **Feature**       | `images/features/<name>/devcontainer-feature.json` `version` | `ghcr.io/getmonoceros/monoceros-features/<name>:<version>` |

Today that means five deployments — one CLI, one runtime image, three
features (`claude-code`, `atlassian`, `github-cli`). Every additional
feature under `images/features/` is one more deployment. They evolve
separately: `claude-code` jumps from `1.1.0` to `1.5.0` because
Anthropic changed something, while `atlassian` stays at `0.3.0` for
months. The CLI has its own SemVer track, independent of everything.

### Version-triggered pipelines

A pipeline publishes a component **exactly when the version declared in
the source is not yet in the registry**. No "has anything changed since
the last commit?", no explicit tag, no manual trigger. Whoever wants to
ship something bumps the version, commits, merges to `main` — the rest
takes care of itself.

This is detected in two stages:

1. **Path trigger** saves workflow runs when nothing relevant changed.
   A `paths:` filter per workflow — for example `images/features/**`
   for the features workflow.
2. **Version comparison within the workflow** decides per artifact
   whether to actually publish:
   - OCI artifacts (features, runtime image):
     `docker manifest inspect <ref>` — exit 0 = already there, skip;
     exit non-0 = new, publish.
   - GitHub release artifacts (CLI): `gh release view <tag>`
     analogously.

This is idempotent: re-running the workflow does nothing, because no
version number is missing anymore. It's explicitly visible in the
workflow log which components were published and which were skipped.
It's race-safe.

### Three workflow files

```
.github/workflows/
├── precheck.yml         ← lint + typecheck + test auf jedem PR
├── release-cli.yml      ← CLI-Release (paths: packages/cli/**)
├── release-runtime.yml  ← Runtime-Image (paths: images/runtime/**)
└── release-features.yml ← Alle Features (paths: images/features/**)
```

Three release workflows, but **N deployments** — the features workflow
iterates over `images/features/*/` and treats each subdirectory as its
own artifact. If `images/features/opencode/` is added tomorrow, not a
single line in `release-features.yml` changes; the loop finds the new
directory automatically.

This bundling applies only to features, because they are structurally
identical (same publish CLI, same registry schema, same versioning
convention). The CLI and runtime image have their own workflows,
because their build steps and artifact types differ enough that a
generalization would be artificial coupling.

### No staging environment

We're not building a separate staging org, no parallel registry
namespace, no second distribution pipeline. A staging environment would
double the infrastructure (every workflow twice, every visibility
setting twice, every doc duplicated) for a benefit that three smaller
mechanisms cover more cleanly:

- **Precheck** (`precheck.yml`) — lint, typecheck, vitest, format
  check on every PR and push to `main`. Source hygiene, no build or
  integration. Code must be green to land on `main`. The three release
  workflows (`release-cli.yml`, `release-features.yml`,
  `release-runtime.yml`) call precheck via `workflow_call` as an
  upstream job and gate their publish through `needs: precheck` — so a
  red precheck can't wave a release through. The direct `push:` trigger
  on precheck stays, so every main commit gets a visible quality-gate
  indicator even when no release path filters match.
- **Local smoke run** — `pnpm sandbox:reset` builds the runtime image
  locally, scaffolds a sandbox, spins up the container. Whoever changes
  a feature or the image runs this once before merging.
- **SemVer pre-release tags** — when we want to roll something out
  gradually, that works with `<name>:<version>-rc.<n>` (e.g.
  `claude-code:1.2.0-rc.1`) in the same registry namespace. The
  floating major tag (`:1`) explicitly does **not** move to RC
  versions; builders who want to test pin the RC manually in their yml.
  If all goes well, the regular `1.2.0` follows, the major tag moves
  with it, and yml pins go back to the major tag.

A real staging stage gets interesting once the CLI build pipeline
becomes complex (cross-compile, macOS notarization, Windows code
signing) and errors there would break the installation experience for
all builders. At that point, possibly a `MONOCEROS_CHANNEL=next` switch
in the install script that loads the latest pre-release instead of the
stable one. That's follow-up work, not M4 scope.

### What lands locally on the builder's machine — and what doesn't

On install, **only the CLI itself** comes onto the machine: the package
with our `dist/`, the templates directory (`templates/components/`,
which `monoceros init --with=…` composes) and the user docs
(`docs/commands/`, which generated solution READMEs link to). Where npm
writes that depends on the user's npm configuration
(`/usr/local/lib/node_modules/`, `%APPDATA%\npm\node_modules\`, the
Homebrew cellar, etc.); the `bin` entry from `package.json` puts the
`monoceros` shim on the PATH. Monoceros itself doesn't know this path
and doesn't need to. See ADR 0005 for the distribution decision.

The runtime image and the features are **not files on the builder's
disk**. Docker pulls the runtime image from GHCR on the first
`monoceros apply`; the devcontainer-cli pulls the features referenced in
the yml at that point too. Docker caches both in its own image store
(`/var/lib/docker/...`, or the Docker Desktop VM). Monoceros does not
manage this cache.

User state lives completely separate from the tool:

| Plattform    | Nutzer-State-Pfad           |
| ------------ | --------------------------- |
| macOS, Linux | `~/.monoceros/`             |
| Windows      | `%USERPROFILE%\.monoceros\` |

`monoceros-config.yml`, `container-configs/<name>.yml`, materialized
`container/<name>/` trees with `home/`, `projects/`, `data/`. Updating
or uninstalling the CLI tool **never** touches this path. Node's
`os.homedir()` resolves both platforms correctly out of the box.

### Platform matrix for the CLI

> **Superseded on 2026-05-20** by
> [ADR 0005 — CLI distribution via npm](./0005-cli-distribution-via-npm.md).
> While working out the details, it turned out that Monoceros internally
> spawns `@devcontainers/cli` as a Node subprocess and therefore needs
> Node on the host anyway, short of a substantial architectural
> overhaul. That makes the platform matrix with five pre-built binaries
> pointless — the CLI is distributed as an npm package instead. The
> section below is kept only as a historical note.

A GitHub release per CLI version contains five artifacts:

- `monoceros-macos-arm64.tar.gz`
- `monoceros-macos-x64.tar.gz`
- `monoceros-linux-arm64.tar.gz`
- `monoceros-linux-x64.tar.gz`
- `monoceros-windows-x64.zip`

Plus two install scripts in the repo root that download and unpack the
matching artifact:

- `install.sh` for macOS and Linux (bash, curl-pipe-bash-capable)
- `install.ps1` for Windows (PowerShell)

How exactly the tarballs are built (single binary via `bun --compile`
or via Node SEA, or classically with a Node dependency) is an
implementation detail of the CLI workflow, not an architecture
decision. The default recommendation remains a single binary, because
"the user has to install Node" clashes with the expectations of a CLI
tool — but the final choice is made in the implementation ticket.

## Consequences

- The M4 brief (`docs/m4-brief.md`) is obsolete with this ADR. It
  describes an earlier state in which the distribution question was
  assumed to be "npm install -g". We leave it in place as a hand-over
  note, because it documents the pivot state of 2026-05-19, but the
  operative truth from now on is this ADR.
- The interim `scripts/publish-features.sh` (commit `ac1c081`) is
  reverted — it fit the manual-first-CI-later model, which we discard.
- The `images/runtime/VERSION` file is new and must be created before
  the first runtime image push.
- The backlog M4 task list is recut to the new model: task 2 becomes
  "features workflow", task 3 becomes "runtime workflow", task 4
  becomes "CLI release workflow including install scripts", task 7
  (CI skeleton) becomes "precheck" and is standalone.
- Windows is explicitly in scope. Consequences for the CLI
  implementation (path resolution, binary build, install script) must
  be considered from now on — no after-the-fact "Windows support
  sprint".
- The ✅ markers in the backlog's M4 DoD remain aspirational ("this is
  what done looks like"), not executed. When M4 is complete, they are
  not removed but confirmed.

## Non-goals of this ADR

- **Concrete YAML workflow files** — these emerge in the respective
  implementation commits. This ADR fixes the logic (path trigger +
  version detection + idempotency), not the action syntax.
- **Brew tap / WinGet manifest / Scoop bucket** — these are wrappers
  over the GitHub Releases tarballs and can come once we see real users
  and demand. For now, the direct install path.
- **Auto-update of the installed CLI** — today manual via re-running
  the install script. Auto-update mechanics come in a later stage, if
  at all.
- **Single-binary build tool choice** (`bun --compile` vs. Node SEA
  vs. `pkg`) — implementation detail, belongs in the CLI workflow PR
  and not in this ADR.
- **Exactly when the GHCR packages flip from `private` to `public`** —
  this is a one-time UI click per package, after the first successful
  workflow run. The ADR says nothing about it, because it's not a design
  decision.
