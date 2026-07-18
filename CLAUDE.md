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
3. [getmonoceros.build/docs](https://getmonoceros.build/docs/) — the
   user-facing command reference (what the CLI can do today)

## Conventions

- **Everything in the public repo is in English** — commit messages,
  source-code docs (comments, JSDoc), and user docs (README, concept
  documents, ADRs). The workbench is a public project with a global
  audience. (Internal, German-language strategy docs live in the private
  `monoceros-concept` repo — see the local `.claude/CLAUDE.md`.)
- **Command docs live on the website, not in this repo.** User-facing
  command documentation is authored as MDX in the `monoceros-web` repo
  under `src/content/docs/docs/reference/{lifecycle,config,utilities}/`
  and is updated in the same change as the CLI code. Do **not** recreate
  a `docs/commands/` here — it was removed to end the double-maintenance,
  so the docs now have one home: getmonoceros.build/docs. `monoceros
--help` stays the in-CLI reference and is generated from the citty
  command definitions, independent of the website.
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
- **What becomes a component** (service vs. feature vs. dependency) is
  settled in [ADR 0019](docs/adr/0019-component-taxonomy-service-feature-dependency.md).
  Before adding a database, CLI, framework, or tool to the catalog,
  classify it there first: separate networked container is a **service**;
  a global tool installed into the workspace is a **feature**; anything
  pulled from the project's own package manifest (Spring Boot, Django,
  Next.js, …) is a **dependency** and out of scope. Reach for this ADR
  whenever a "should we support X?" question comes up
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
- **Keep shell completion in step with the CLI.** Completion is derived
  from `COMMAND_SPECS` in
  [`packages/cli/src/completion/resolve.ts`](packages/cli/src/completion/resolve.ts),
  which is a hand-maintained mirror of the citty commands. When you add
  or change a command, flag, or positional, update that spec in the same
  change: register the new command, add its flags, and tag each value
  source (`staticSource` for catalog-derived lists, `dynamicSource` with
  a `kind` for filesystem-backed ones like container names or apps).
  Both the bash/zsh engine and the self-contained PowerShell script are
  generated from it (`buildPwshCompletionModel`), so an un-mirrored
  change silently loses completion on Windows. A test pins the command
  list, but flags and value sources are not auto-checked. A new dynamic
  `kind` also needs a matching host-side resolver in the pwsh script in
  [`packages/cli/src/commands/completion.ts`](packages/cli/src/commands/completion.ts).

## Working an issue (board workflow)

When you are asked to work a GitHub issue, drive it through the
**🦄 Project Monoceros** board. Statuses, in order:
`Backlog → Ready → In progress → In review → Done & Delivered`.

1. **In progress** - move the issue here before writing code. If it
   isn't on the board yet, add it first, then set the status. When you
   move an issue to In progress, always assign it to the repo owner
   (@thorque) at the same time.
2. **Implement** - do the work.
3. **In review** - once it's done, everything is pushed, and the
   release pipelines are running, move it to In review and add an issue
   comment describing what you changed. (On this repo a version-bump
   push publishes, so delivery happens here too - see the release model
   below.)
4. **Done & Delivered** - the closing step, after the review. This is
   the user's call: they move it themselves or tell you to. Never move
   an issue to Done & Delivered on your own.

Board fields can be renamed (e.g. "Done" → "Done & Delivered"):
re-query the live Status options before relying on a name, don't trust
a remembered value.

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
