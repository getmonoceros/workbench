# Monoceros Workbench

## How do you behave when you code? What principles guide your decisions, your style, your approach to problem-solving?

- Think before coding. State your assumptions out loud. If the request is ambiguous, ask. If a simpler approach exists, push back. Stop when you are confused, name what is unclear, do not just pick one interpretation and run.
- Simplicity first. Write the minimum code that solves the problem. No speculative abstractions. No flexibility nobody asked for. The test: would a senior engineer call this overcomplicated.
- Surgical changes. Touch only what the task requires. Do not improve neighboring code. Do not refactor what is not broken. Every changed line should trace back to the request.
- Goal-driven execution. Turn vague instructions into verifiable targets before writing a line. “Add validation” becomes “write tests for invalid inputs, then make them pass.

---

The product is called **Monoceros**. The directory is called
`monoceros-workbench`, because we build the workbench — the frame in
which the builder builds their dev container, without the workbench
itself dictating what goes inside.

## What Monoceros is

A **workbench for local, reproducible dev containers with AI coding
tooling**. The builder describes declaratively what should be in the
container (language, services, AI tools, repos), and Monoceros
materializes it. Language- and stack-agnostic — Node, Python, Java,
Rust, Go, and .NET all run.

What sets it apart from cloud Codespaces / Cursor Cloud:

- **local** — no SaaS, no forced subscription, no data leaving the
  machine except what you deliberately choose
- **declarative** — the yml is the source of truth, the container is
  derived from it; reproducible across machines
- **AI tools are first-class** — Claude Code, OpenCode, Rovo Dev,
  Codex, GitHub Copilot, etc. land in the container as devcontainer
  features
- **container isolation by default** — everything runs in a Linux
  container, not on the host. A deliberately mounted workspace is
  exposed, the rest of the host is not.

What Monoceros is **not**:

- not a cloud platform, not SaaS, not a fixed tech stack
- no built-in web UI
- **no iteration workflow** — no plan/generate/review pipeline; if
  something like that comes, it comes as a separate project that
  builds on top of the workbench

## CLI model

All commands follow the form:

```sh
monoceros <command> <containername> [<args> …]
```

Layout under `$MONOCEROS_HOME` (dev: `<workbench>/.local`, prod:
`~/.monoceros`):

```
container-configs/<name>.yml   ← yml profile (source of truth)
container/<name>/              ← materialized dev container
monoceros-config.yml           ← optional global defaults
monoceros-config.sample.yml    ← marker + template (committed in dev)
```

Workflow:

```sh
monoceros init <name> [--with-languages=… --with-features=… \
       --with-services=… --with-apt-packages=… --with-repos=… --with-ports=…]
                                          # compose yml (without --with-*:
                                          # documented template)
monoceros list-components                 # show the component catalog
monoceros apply <name>                    # → container/<name>/
monoceros shell <name>                    # work inside it
monoceros add-feature <name> <ref>        # edit the yml
monoceros apply <name>                    # rebuild
monoceros remove <name>                   # tear the container down completely (backup on by default)
monoceros restore <backup-path>           # restore a container from a backup
```

cwd is irrelevant — everything goes through convention.

## Reading order for new sessions

1. This file (short overview)
2. [`docs/concept.md`](docs/concept.md) — the story of the workbench,
   what Monoceros does and explicitly does not do
3. [`docs/commands/README.md`](docs/commands/README.md) — what the
   CLI can do today

## Conventions

- **Everything in the public repo is in English** — commit messages,
  source-code docs (comments, JSDoc), and user docs (README, concept
  documents, command docs under `docs/commands/`, ADRs). The workbench
  is a public project with a global audience. (Internal,
  German-language strategy docs live in the private
  `monoceros-concept` repo — see the local `.claude/CLAUDE.md`.)
- **One MD file per new CLI command** under `docs/commands/<name>.md`
  in the same commit as the code, plus a reference in
  [`docs/commands/README.md`](docs/commands/README.md). Generated
  solutions point via the README to `/opt/monoceros-workbench/docs/commands/`
- **Context7** is the first stop for external library versions.
  Tools: `mcp__context7__resolve-library-id` and
  `mcp__context7__query-docs`. Never write version numbers from
  memory — archive versions are stale by definition
- **Never start/kill server processes manually.** As soon as dev
  servers come into play, configure that via `.claude/launch.json`
- **Do not change the global git config.** Per repo, locally, nothing
  beyond that
- **Put ADRs** under `docs/adr/` (Markdown, numbered, short). Concept
  documents go in `docs/`; ADRs are more specific
- **Clean up the Traefik proxy after dev smoke tests.** The
  `monoceros-proxy` singleton is machine-wide and is reused by
  `ensureProxy()` **by name** (not per home, not per port). If you ran
  port tests in `.local` (dev) and the proxy is still running, a
  subsequent test against `~/.monoceros` (prod) reuses exactly that
  container — it then watches the `.local` `traefik/dynamic` and prod
  routes silently return `404`. So: after `.local` smoke tests with
  ports, run `docker rm -f monoceros-proxy` before testing in a
  different home (and so you don't leave a proxy corpse behind for the
  builder). Details in the README under “Developing on the workbench”.

## The workbench's own stack (not the containers built with it)

- pnpm workspaces
- TypeScript + Node.js 20+
- Vitest for tests
- prettier + eslint via lint-staged + husky

The workbench is language-agnostic _for the containers built with it_.
But the workbench codebase itself is TypeScript.

## Release model (READ before touching versions)

**A version bump that lands on `main` IS the release signal. Pushing
it publishes a new version. There are no tags, no manual buttons — the
bumped version number is the trigger.** This is intended, not a
surprise. Treat every version bump as "this will publish on push".

- `packages/cli/package.json` version → `release-cli.yml` publishes to
  **npm** (`@getmonoceros/workbench`).
- `images/features/<name>/devcontainer-feature.json` version →
  `release-features.yml` publishes the feature to **GHCR**.
- `images/runtime/VERSION` → `release-runtime.yml` builds + pushes the
  runtime image to **GHCR**.

Each `publish` job only ships a version that isn't already in the
registry, so re-pushing an unchanged version is a no-op skip.

**Publishing is gated. Nothing reaches npm or GHCR unless BOTH gates
are green:**

1. `precheck` (lint + typecheck + test + format check), and
2. `e2e-smoke` (pack + global install + real `monoceros apply`
   scenarios) — wired as a reusable `workflow_call` that every
   `release-*.yml` `publish` job `needs:`. A red e2e blocks the
   publish; it is a hard prerequisite, never a parallel race.

So: do not bump + push expecting to "see if it's good" — pushing a bump
commits to a release, and the gates either pass and publish or fail and
block. Verify locally first.
