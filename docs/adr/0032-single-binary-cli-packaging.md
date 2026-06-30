# ADR 0032: Single-binary CLI packaging (no host Node)

- Status: accepted
- Date: 2026-06-30

## Context

The Monoceros CLI is a Node app, installed via npm (`bin: dist/bin.js`).
That makes **Node a host requirement**. The product goal has always been
a minimal host: ideally just Docker.

Two recent moves shrink the host footprint toward that goal:

- The managed WSL distro on Windows (ADR 0011) already solves "no Node on
  the host" there: Node is installed **inside** the distro, the Windows
  host has only a thin shim.
- PAT-based repo auth (ADR 0031) removes the host `gh`/`glab` requirement
  and, with config-driven git identity, removes the need for host `git`
  too: credentials come from a PAT written into the forwarded
  `git-credentials` file, identity comes from config, and every real git
  operation runs in the container.

After those, the **only** remaining host dependency on macOS/Linux is
Node, purely because of how the CLI is packaged. There is no encapsulation
layer there like WSL, and none is needed: the per-project dev container
already is the isolated tooling environment. So the right move on
macOS/Linux is not a parallel sandbox but simply removing the Node
dependency from the CLI itself.

## Decision

Ship the CLI as a **single self-contained binary** per OS/arch
(darwin-arm64, darwin-x64, linux-x64, linux-arm64). The host then needs
only the `monoceros` binary plus Docker (and, with ADR 0031, nothing
git-related on the host).

**This is a packaging change only. Nothing about the command model
changes.** Like `gh`, `docker`, or `kubectl`, a single binary still
carries a full multi-command CLI: `monoceros init/apply/shell/...` stay
identical in interface, arguments, and behavior. The citty command
definitions and the development workflow (TypeScript, pnpm, vitest) are
untouched. The binary just bakes in the Node runtime, the bundled JS, and
the assets, so no external Node or `node_modules` is required at run time.

Distribution: `install.sh`/`install.ps1` download the matching binary from
a GitHub Release and drop it on PATH, instead of running `npm install`. The
npm package stays as a secondary path for Node users. Windows stays
WSL-based (the distro could later run the Linux binary instead of an
in-distro npm install, but that is optional).

## Consequences

- **Host = Docker + the Monoceros binary.** With ADR 0031, no Node, no
  git, no provider CLI on the host.
- **Two known engineering costs**, both verified against the code:
  1. `@devcontainers/cli` is currently spawned as a **child `node`
     process** (resolves its JS bin, runs it under node). With no host
     Node, the binary must run that JS itself: either self-exec (a Node
     SEA binary is node and can run embedded JS) or embed the devcontainer
     CLI in-process. This is the largest piece of work.
  2. Assets (`templates/`, `bundled-components/`) are read today via
     `__dirname` disk paths. In a binary they must be embedded and read
     from the embedded store.
- All runtime deps are pure JS with **no native addons**
  (`@devcontainers/cli`, citty, consola, diff, yaml, zod), which is what
  makes bundling viable at all.
- **Build tool** is open: Node SEA (stays on the Node runtime, no
  compat surprises, but build-per-target and more manual asset embedding)
  vs `bun build --compile` (easy cross-compile and asset embedding, but a
  runtime swap to Bun that must be validated). Plan: a bun-compile spike
  first to settle the "devcontainer CLI inside a binary" question in
  practice, with Node SEA as the fallback.
- **Release model** gains a per-platform binary build-and-attach step
  alongside the existing npm publish.
- **Lost convenience:** auto-pickup of an existing host git identity. Git
  identity becomes config-driven (`defaults.git.user` / `git.user` / env,
  with prompt-and-persist). Optionally we can still parse `~/.gitconfig`
  as a plain file (no git binary) to keep that convenience.

## Status of implementation

Design only; not yet built. Independent track from ADR 0031, but together
they reach the "host = Docker + binary" target. First concrete step is the
bun-compile spike to prove out the devcontainer-CLI-in-binary path before
committing to SEA vs bun and reworking asset access.
