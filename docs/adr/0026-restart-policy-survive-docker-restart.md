# ADR 0026: Restart Policy - the running stack survives a Docker restart

- Status: accepted
- Date: 2026-06-22

## Context

When Docker (Docker Desktop, the daemon, or the whole host) restarts - an OS
update, a crash, a reboot - what should happen to a dev-container that was
running?

The first answer (issue #19) was "nothing comes back until `monoceros
start`": the workspace carried no restart policy, so it stayed down. That
issue actually started from a **bug** - curated services were scaffolded with
`restart: unless-stopped` while the workspace had none, so after a restart the
services came back **alone**, without the workbench they belong to. #19 fixed
the asymmetry by dropping the service policy too, making the whole group stay
down.

That removed the surprise but left a worse one: a builder whose machine
rebooted overnight came back to a cold environment and had to remember to
`monoceros start` every project. That does not match how a developer expects a
local stack to behave - and it does not match Docker's own model, where
`restart: unless-stopped` is the standard "survive a restart" policy that
virtually every docker-compose dev setup already uses.

Three sibling robustness fixes landed alongside this decision:

- **#20** - sshd is brought up from the image entrypoint (image mode sets
  `overrideCommand: false`), so a workspace that comes back is immediately
  attach-ready.
- **#21** - the `monoceros-proxy` singleton is created with `restart:
unless-stopped` (and healed in place), so routing survives a restart.

Both assume the thing they make robust actually comes back. The open question
this ADR settles is whether the **dev-container group** comes back too.

## Decision

The whole dev-container group defaults to **`restart: unless-stopped`**, the
same policy the proxy uses. After a Docker/host restart the group that **was
running** comes back on its own; a group that was deliberately stopped stays
down.

- **Workspace.** Compose mode: `restart: unless-stopped` on the `workspace`
  service. Image mode: `--restart=unless-stopped` in `runArgs`.
- **Services.** Default to `unless-stopped` at scaffold time. An explicit
  per-service `restart:` in the yml overrides the default (e.g. `restart: no`
  to opt one service out). The policy is **not** written into the yml - the
  yml stays clean (keeping #19's improvement); only the generated
  `compose.yaml` / `runArgs` carry the default.
- **Proxy.** Already `unless-stopped` (#21). The whole stack is now uniform.

Docker does the "was it running?" bookkeeping for us. `unless-stopped`
restarts a container on daemon start **only if it was running and not manually
stopped**; `monoceros stop` performs a real `docker`/`compose stop`, which
sets Docker's manual-stop bit, so a stopped group stays down. We need no
custom detection of pre-restart state.

This **reverses the user-facing outcome of #19** (group stays down →
running group comes back) while keeping the asymmetry fixed: the policy is now
uniform across workspace and services, just in the other direction.

## Consequences

- A builder returns to their running environment after a reboot without a
  manual `monoceros start`. Explicit control is preserved: `monoceros stop`
  keeps a group down across restarts.
- "Comes back" means the container shell, sshd, and services are up and an IDE
  can reattach. It does **not** auto-start the builder's dev server / app: PID
  1 is `sleep infinity`; the app was never a workbench-managed process.
- Host-reboot load is bounded by what was actually running - projects the
  builder stopped stay down.
- Existing containers pick up the policy on their next `monoceros apply`
  (recreated from the regenerated `compose.yaml` / `runArgs`). A container that
  is only ever `monoceros start`ed against a stale scaffold keeps its old
  policy until re-applied.
- A per-service `restart: no` (or `always`) in the yml still wins, so a builder
  can tune a single service without losing the group default.
