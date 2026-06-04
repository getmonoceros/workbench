# ADR 0001 — M1 build plan: CLI and template first, custom runtime image later

- Status: accepted
- Date: 2026-05-10

## Context

The M1 backlog (internal) originally lists the eleven tasks in an order
that begins with building and publishing our own runtime image
(tasks 1–2), with CLI implementation and the default template building
on top of it.

During planning, a different order was preferred: **CLI and template
first against a public devcontainer base image, our own image only
later**.

## Decision

The M1 tasks are implemented in this order:

1. **CLI skeleton** — `packages/cli/` with citty, all 9 subcommands as
   stubs, smoke tests. _(✅ done 2026-05-10)_
2. **Default template** — `templates/default/.devcontainer/devcontainer.json`
   minimal, against a public base image
   (`mcr.microsoft.com/devcontainers/typescript-node:22-bookworm` or
   similar), bind mount of `~/.claude/`, postCreate.
3. **`monoceros create`** — writes `.devcontainer/`,
   `.monoceros/stack.json`, `README` stub. Flags `--languages` /
   `--services` / `--postgres-url`. Idempotent.
4. **`monoceros shell`** — wraps `@devcontainers/cli`
   (`devcontainer up` + `devcontainer exec bash`), cwd awareness.
5. **`monoceros run -- <cmd>`** — non-interactive, exit-code propagation.
6. **`monoceros start` / `stop` / `status` / `logs`** — Compose passthrough.
7. **`monoceros add-service` / `add-language`** — mutations with
   diff preview.
8. **Custom runtime image** — `images/runtime/Dockerfile`, mechanics
   taken from the archive, template block removed.
9. **Verification across three paths** — VS Code Dev Containers, Cursor,
   Claude Code.
10. **Auth smoke test** — bind-mount auth out of the box.

The original backlog task "publish the image" is dropped as a separate
step; publishing becomes part of step 8 once the image is stable.

## Rationale

- **Usable code sooner.** With a public base image, `monoceros create …
&& monoceros shell` is already runnable after step 4 — without an
  image build pipeline. Our own image is a refinement, not a blocker.
- **Iteration budget for CLI UX.** CLI and template decisions
  (flag schema, `.monoceros/stack.json` format, `add-*` idempotence)
  have a bigger impact on the later pipeline (M2) than the image
  details. They are better tackled first.
- **Image spec gets sharper through CLI usage.** Once the CLI and
  template run, it is clear which tools the image _really_ needs. The
  other way around risks spec inflation.
- **Still M1 before M2.** The order stays within M1 — our own image just
  moves to the end. M2 starts only when all ten steps are green.

## Consequences

- `templates/default/.devcontainer/devcontainer.json` initially
  references a Microsoft devcontainer base image. This is temporary.
- The egress whitelist and the non-root setup from the archive only land
  in our own image with step 8. Until then the sandbox is _not_ fully
  hardened — deliberately accepted for the build phase.
- `docs/backlog.md` is updated to match this order; the original task
  numbering is not preserved.
