# ADR 0028: Restore running apps across an apply - pid-file presence is the desired state

- Status: accepted
- Date: 2026-06-25

## Context

`monoceros apply` tears down and recreates the container, so every
long-running app server the builder had up (`monoceros start <name> <app>`,
or the agent's `monoceros-ctl start`) dies with it. Until now the human had to
remember which servers were running and restart each by hand. ADR 0027 built
the precondition for fixing this (per-app `launch.json` + the `monoceros-ctl`
runner + run-state under `.monoceros/run/`); issue #23 is the fix.

ADR 0027's consequences sketched the fix as a **liveness snapshot taken before
teardown**: while the old container is still up, read `run/` and record which
targets are genuinely alive (`kill -0`), then restart exactly that set after
bring-up. The reasoning was that "a pid file exists" is not "the process was
alive" - a crashed server leaves a stale file - and that the pid numbers are
meaningless after a recreate (pid recycling), so a naive "read `run/` and start
everything" would falsely resurrect crashed targets and must never signal an
old pid.

Designing it alongside the Docker-restart case (ADR 0026, where the group comes
back with `restart: unless-stopped`) surfaced a simpler model.

## Decision

**The PRESENCE of a `.monoceros/run/<app>/<target>.pid` file is the
desired-state ("wanted") marker; its CONTENT is the last-known pid (liveness).
`monoceros-ctl reconcile` restarts every wanted target that is not currently
alive. `apply` runs it after bring-up.**

- **No separate marker, no pre-teardown snapshot.** The pid file is already
  written by `start` and removed only by an explicit `stop`; a crash or a
  recreate leaves it behind. So its presence already encodes "started and not
  deliberately stopped", and `.monoceros/` lives on the bind mount, so that
  intent survives the recreate. There is nothing to snapshot before teardown -
  the want-set is still on disk after bring-up.

- **`reconcile`** (new `monoceros-ctl` subcommand) walks `run/**/*.pid`, skips
  the ones whose pid is alive, and restarts the rest via the normal `start_one`
  path (which rewrites the pid file with the fresh pid). It is best-effort: one
  target failing never aborts the others (unlike `start`'s fail-fast default
  set). Orphans are reaped, not resurrected: if the app's `launch.json` or the
  target is gone, the stale pid file is removed instead of started.

- **Desired-state over liveness-snapshot.** We deliberately restore what the
  builder _wanted_ up, not only what happened to be alive at apply time - a
  target that had crashed comes back. This is the exact `unless-stopped`
  contract ADR 0026 chose for the container group: it comes back unless you
  stopped it, crashes included. An explicit `monoceros stop` is the one clear
  "I don't want this" signal, mirroring Docker's manual-stop bit. The "stale
  pid file resurrects a crashed process" objection from ADR 0027 is not a bug
  under this model - it is the intended behavior.

- **No signalling of old pids.** `reconcile` never kills by a recorded pid; it
  only reads it to decide "already running" (and skip). Right after a recreate
  nothing the runner manages is up, so that read is a no-op and every wanted
  target is restarted fresh. The pid-recycling hazard (an old number matching
  an unrelated new process) is therefore bounded to a vanishingly unlikely
  false "already running" skip in a near-empty fresh process table, never a
  wrong kill.

- **Apply trigger, host-gated.** After a successful bring-up (and the deferred
  service wave, ADR 0025), apply execs `monoceros-ctl reconcile`. A host-side
  probe (`hasWantedApps`, reading the bind-mounted `run/` dir) skips the exec
  and its output entirely when nothing was running - the common case. Gated on
  the runtime shipping `reconcile` (>= 1.6.0); below that, apply leaves apps
  stopped (the prior behavior). Best-effort: a failure warns, never fails the
  apply.

## Consequences

- A builder who runs `apply` to add a port / feature gets their running servers
  back automatically, in the same `unless-stopped` spirit as the rest of the
  stack. `monoceros stop <name> <app>` is the way to keep one down across an
  apply.
- The same `reconcile` primitive is the natural trigger for the **Docker
  restart / host reboot** case that ADR 0026 left open for apps (PID 1 is
  `sleep infinity`; the entrypoint brings sshd back but not apps). Wiring
  `reconcile` into the runtime entrypoint - a sibling of `monoceros-sshd-up.sh`,
  firing on every container start - closes that gap with no new state model.
  Tracked as a separate issue; out of scope here.
- This supersedes the liveness-snapshot plan in ADR 0027's consequences. That
  plan is not wrong, just heavier than needed: the desired-state already
  persists, so the before/after teardown dance is unnecessary.
- Ships in runtime 1.6.0 (`monoceros-ctl reconcile`) + CLI 1.36.0 (apply
  trigger + runtime gate).
