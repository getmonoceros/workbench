# Contributing to Monoceros

Working on the workbench itself (not just using it)? This is the entry
point. The codebase is pnpm workspaces + TypeScript + Node 20+, tested
with Vitest, formatted/linted via prettier + eslint (lint-staged +
husky).

Read [`CLAUDE.md`](CLAUDE.md) first - it carries the conventions,
component taxonomy, board workflow, and the release model in full.

## Local setup

Clone and install once:

```sh
git clone https://github.com/getmonoceros/workbench
cd workbench
pnpm install
```

To drive the CLI, point the `monoceros` command at your checkout with a
shell alias. It runs `src/bin.ts` directly via `tsx`, so it reads live
from your working tree - code changes take effect immediately, no
rebuild or reinstall:

```sh
alias monoceros="$(pwd)/packages/cli/node_modules/.bin/tsx $(pwd)/packages/cli/src/bin.ts"
```

This alias is **per terminal session**: it lives only in the shell you
defined it in and is gone when you close it, so set it again in each new
terminal you work from. `$(pwd)` is expanded at definition time, so run
the line from the repo root (it bakes the absolute checkout path into
the alias). To make it permanent, put that resolved line in your shell
rc instead.

The alias then behaves like the installed binary:

```sh
monoceros init hello --with-languages=node --with-features=claude
monoceros apply hello
```

## Working on the runtime image or features

- **Runtime image** lives in [`images/runtime/`](images/runtime/); the
  local build and the `MONOCEROS_BASE_IMAGE_OVERRIDE` workflow are
  documented in [`images/runtime/README.md`](images/runtime/README.md).
- **Components** (languages, services, features) live under
  [`components/`](components/). To make `apply` pick up a locally edited
  feature instead of the published GHCR tag, point
  `MONOCEROS_FEATURES_DIR_OVERRIDE` at your `components/features/`
  directory.

## Release model

A version bump that lands on `main` **is** the release signal - pushing
it publishes. There are no tags or manual buttons. Publishing is gated
behind `precheck` (lint + typecheck + test + format) **and** `e2e-smoke`;
a red gate blocks the publish. Verify locally before bumping. The full
logic, including which version field maps to which artifact, is in
[`CLAUDE.md`](CLAUDE.md#release-model-read-before-touching-versions).

## Known issue: Traefik proxy with two homes

As soon as you test with both the aliased `monoceros` from your checkout
(dev home `<checkout>/.local`) and a globally installed `monoceros`
(prod home `~/.monoceros`), they
collide on the machine-wide Traefik singleton `monoceros-proxy`. It is
reused **by container name** - not per home and not per port. Whoever
starts it first wins; the other context reuses the same container, which
then watches the wrong `traefik/dynamic` directory, so port routes
return `404` (Traefik runs but doesn't know the route). A
`routing.hostPort` change does **not** help while the container name is
shared. When switching context:

```sh
docker rm -f monoceros-proxy   # then apply / add-port again in the new context
```

Only developer machines with two homes hit this; a normal builder has
only `~/.monoceros` and never sees it.
