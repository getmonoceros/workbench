# ADR 0059: Apps come back after a container restart

- Status: accepted
- Date: 2026-09-27
- Implements: #25
- Relates to: [ADR 0026](0026-restart-policy-survive-docker-restart.md) (the container
  group restarts `unless-stopped`),
  [ADR 0028](0028-restore-running-apps-across-apply.md) (the `reconcile`
  primitive and the pid file as the "wanted" marker)

## Context

ADR 0026 brings the workspace, its services and sshd back after a Docker
restart or a host reboot, but not the builder's app servers: PID 1 is
`sleep infinity`, and only `apply` ran `monoceros-ctl reconcile` (ADR 0028). A
builder who rebooted overnight came back to a container that was up and
attach-ready, with every dev server down. The same held for `monoceros start`
after `stop --down`, which creates a fresh container.

## Decision

**Two triggers for the same `reconcile`, split by whether the container is
new, plus a lock so they can overlap.**

- **Entrypoint, on a restart.** The runtime entrypoint runs
  `monoceros-ctl reconcile` on every start of an existing container: a
  `docker restart`, a Docker Desktop restart, a reboot, a plain `stop` +
  `start`. It runs as the runtime user, in the background and best-effort, so
  PID 1 never waits on an app's readiness probe, and only after the egress
  rules are in place. Its output goes to `logs/reconcile.log`.

- **Not on a container's first start.** A fresh container (`apply`, or `start`
  after `stop --down`) has not run post-create yet, and starting apps then
  races the setup. The entrypoint skips its first start, recognised by a
  marker in the container's own writable layer (`/var/lib/monoceros/started`),
  which a recreate clears and a restart keeps.

- **Host side, after the container is ready.** `apply` already reconciles
  after bring-up. `monoceros start` now does the same, after the deferred
  services (ADR 0025). It is gated like apply's: runtime >= 1.6.0, and only
  when a wanted pid file exists.

- **A launch lock.** After a plain `stop` + `start` both triggers run at once.
  `monoceros-ctl` serialises "is it running, launch it, stamp its pid" with a
  `flock` on `.monoceros/run/.lock`, released before the readiness wait. The
  second caller sees the target alive and reports it as "already running", and
  `reconcile` now lists live targets that way instead of skipping them
  silently.

- **The new pid goes to `<target>.pid.new` first.** During a reconcile the old
  pid file is still there. Waiting for "the pid file is non-empty" read that
  stale number straight back, and could stamp a reused pid (ADR 0028's update,
  #42). The old file stays as the wanted marker until the fresh pid is stamped
  into it.

- **A bounded retry for an early exit.** Being started after the services is
  not the same as finding them ready: `docker compose up` returns once a
  service's container runs, not once it answers, and on a reboot the services
  and the workspace come up in parallel anyway. Any app that needs a service at
  boot dies until that service answers. `reconcile` therefore retries a target
  that exits too early (before binding its port, or within a few seconds of its
  start when it has none), every 5 seconds for up to 2 minutes, with one line
  saying so. It does not know which service the app waits for and does not
  need to: the early exit is the signal, whatever the dependency. An explicit
  `monoceros start <name> <app>` does not retry; there the failure is shown at
  once. This is the "light bounded retry" #25 left open, chosen over waiting
  for each service's port, which would need the list of services inside the
  container and still miss a service that listens before it is ready.

## Consequences

- An app the builder started comes back after a reboot, a Docker restart and
  every `monoceros start`, until an explicit `monoceros stop <name> <app>`.
  This is the `unless-stopped` contract of ADR 0026, extended to the apps.
- `monoceros start` takes longer when apps are wanted: each ported target
  waits for its port, as in `apply`, and a target whose service is slow to
  answer is retried for up to 2 minutes. A target that is broken for good
  costs those 2 minutes on every start until it is fixed or stopped.
- The entrypoint part needs the runtime that ships it. The host part in
  `start` works with any runtime from 1.6.0 on; without the lock it never
  overlaps with an entrypoint pass, because older runtimes have none.
- No supervisor: an app that crashes while the container runs stays down until
  the next restart or `start`. That is out of scope, as in #25.
