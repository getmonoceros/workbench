# ADR 0015 — Persist IDE State Across Container Rebuilds

- Status: accepted
- Date: 2026-06-05

## Context

`monoceros apply` recreates the container on every run — image-mode via
`devcontainer up --remove-existing-container`, compose-mode via a
label-based force-remove before `up` (see `devcontainer/compose.ts`).
Both **preserve docker volumes** but discard the container's writable
layer.

VS Code installs its server, the builder's extensions, and the
user-scoped settings/extension storage under `/home/node/.vscode-server`
inside the container. Empirically, a builder's hand-installed extensions
and their settings do **not** survive a `monoceros apply` rebuild —
confirmed in the field. That is unacceptable: extensions and their
settings must persist across rebuilds.

## Decision

Persist VS Code IDE state with **named docker volumes** mounted on the
relevant `~/.vscode-server` sub-directories — the mechanism VS Code
documents for "avoid extension reinstalls". Two per-container volumes:

| Volume (per container)               | Mount target                           | Holds                        |
| ------------------------------------ | -------------------------------------- | ---------------------------- |
| `monoceros-<name>-vscode-extensions` | `/home/node/.vscode-server/extensions` | installed extensions         |
| `monoceros-<name>-vscode-userdata`   | `/home/node/.vscode-server/data/User`  | settings + extension storage |

- **Named volumes** (not host binds) survive container removal, so the
  state outlives a rebuild. `apply` preserves volumes; `remove` deletes
  these two explicitly (`docker volume rm -f`).
- The mounts target **sub-directories**, never the whole
  `~/.vscode-server`. VS Code owns that directory (server binaries under
  `bin/`, etc.); a whole-directory mount fights that ownership.
- The runtime image (`images/runtime/Dockerfile`) pre-creates
  `~/.vscode-server/extensions` and `~/.vscode-server/data/User` owned
  by `node`, so the fresh volumes initialise node-owned. VS Code's docs
  require this for the non-root user — without it the server can't write
  into the volumes.
- Volume names are unique per container so two containers never share
  extension state. `name:` pins the exact name in compose (no project
  prefix), so image-mode and compose-mode use identical names and
  `remove` can delete them deterministically.

## Rationale

- It is VS Code's **documented, supported** mechanism — not a Monoceros
  invention. ([Avoid extension reinstalls](https://code.visualstudio.com/remote/advancedcontainers/avoid-extension-reinstalls))
- It satisfies the hard requirement (extensions + settings survive a
  rebuild) without taking over a directory VS Code manages, so it does
  not trigger the endless "configuration changed — rebuild?" loop.
- Volumes are the right storage for IDE caches/binaries: large,
  re-creatable, not something a builder browses on the host.

## Consequences

- A runtime-image change is required (the node-owned pre-created dirs).
  It ships to builders with the next runtime-image release; for local
  development, rebuild the image (`pnpm image:build`).
- IDE state lives in named volumes, **not** under `<container>/home/`,
  so unlike feature home-dirs it is not host-browsable and not part of
  `remove`-backups. Accepted — it is regenerable IDE cache, not builder
  data.
- `monoceros remove` must (and does) delete the two volumes, or they
  leak after the container directory is gone.
- A `restore` + `apply` starts with empty IDE volumes; VS Code
  re-populates them. The container definition is fully restored; only
  the local IDE cache starts fresh.

## Rejected

- **Host bind-mount of the whole `~/.vscode-server`** — the first
  attempt, reverted. It takes over a directory VS Code manages: the
  server bootstrap (`mkdir ~/.vscode-server/bin/<commit>` as `node`)
  hit `Permission denied` when Docker created the intermediate parent as
  root, and once that was worked around, VS Code raised an **endless
  rebuild prompt** because it never considered its server location
  settled. Lesson: for anything the IDE owns inside the container, mount
  only the specific sub-directories it documents, and let the IDE own
  the rest.
- **Relying on VS Code's own `vscode` volume** — VS Code does mount a
  `vscode` volume at `/vscode`, but it did not, in practice, keep the
  builder's hand-installed extensions across a `monoceros apply`
  rebuild. Explicit per-container volumes on the documented paths are
  what actually work.
- **A host bind on the sub-directories** (browsable, part of backups) —
  still needs the image pre-create, and re-introduces host-UID ownership
  friction on Linux. Named volumes are the documented, lower-friction
  choice; the lost host-browsability of IDE cache is not worth it.
