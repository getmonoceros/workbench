# ADR 0027: Per-app launch config + in-container runner for long-running app servers

- Status: accepted
- Date: 2026-06-23

## Context

A long-running dev server started by the build agent dies when the build
session ends (`exit`, closing the terminal) or on a container restart. Until
now the briefing taught the agent a raw `setsid` incantation that recorded a
process-group pid into `logs/<app>.pid` and tailed `logs/<app>.log`. Two
problems:

- The human had no clean way to (re)start the server. The start command isn't
  guessable (`npm run dev`, `mvn spring-boot:run`, `python manage.py
runserver`, `cargo run`, …); only the agent at build time or the human knows
  it. Monoceros must not infer it.
- pids and logs were both flat in `logs/`, keyed on a free-form short name.
  Logs are logs; pids are runtime state and do not belong there.

ADR 0026 made the container group survive a Docker restart but explicitly did
**not** restart the builder's app (it was never a workbench-managed process).
This ADR makes the app a first-class, declaratively-described thing, which is
also the precondition for auto-restarting it across an apply (issue #23).

## Decision

**A per-app launch config, materialized and run by a single in-container
runner that the host shells into.**

- **Launch config.** `projects/<app>/.monoceros/launch.json` lives in the
  app's own repo, is hand-editable, and is maintained by the agent (briefing
  instruction: when you start a long-running server, add/update its entry).
  It is a list of named `configurations`, each `{ name, command, cwd?, port?,
env?, default? }`, at most one `default`. `command` is a single string run
  through `setsid sh -c` (it is what the agent/human already types, and it
  goes through a shell anyway). Read at start time, after the app exists. No
  language detection, no apply-time declaration.

- **One runner, two front doors.** The start/stop mechanics live in a single
  shipped script, `monoceros-ctl` (runtime image, `/usr/local/bin`). The agent
  calls it directly inside the container (`monoceros-ctl start <app>`); the
  host command `monoceros start/stop <name> <app>` is a `docker exec` onto the
  same script. One source of truth, no drift between two code paths. The agent
  does **not** lose the ability to start (it was a regression risk); it gains a
  named command instead of a raw incantation.

- **Naming: distinct binary, shared verbs.** In-container is `monoceros-ctl`,
  not `monoceros-start`/`mono`/`mwb`. Reasoning settled in discussion:
  - Identical names (`monoceros-start`) would masquerade as a `monoceros` CLI
    that does not exist in the container, and the signatures differ anyway (no
    `<name>` inside the container).
  - Short generic tokens (`mono`, `mwb`) collide: `mono` is the Mono .NET
    runtime (`/usr/bin/mono`), and any 3-letter name can be taken by a later
    `apt install`. A build-time check only proves "free at build time".
  - The `monoceros-` prefix is collision-proof by construction; `-ctl` is the
    established pattern (`systemctl`) for a verb-neutral dispatcher that grows
    to `logs`/`list`. The primary caller is the briefed agent, so length is a
    non-issue.

- **State out of `logs/`.** Runtime state lives under
  `.monoceros/run/<app>/<target>.pid`; logs under `logs/<app>/<target>.log`.
  Both are inside the workspace bind-mount (`container/<name>/` on the host
  maps to `/workspaces/<name>/`), so the host reads exactly what the runner
  writes. `.monoceros/` survives `apply` (apply only overwrites generated
  scaffold), which is what lets #23 later restart what was running.

- **`port` is declarative + active, but never wires the proxy.** A target's
  `port` drives a readiness probe (`start` waits until something actually
  listens, so "started" means "up") and a reachable-URL hint
  (`http://<name>-<port>.localhost`). It does not add proxy routes: the proxy
  routes only the ports declared at the container level, and the container
  cannot add ports. If the agent needs a new port it escalates to the human
  (`monoceros add-port`).

- **Dispatch by argument count.** `start/stop/logs <name>` stay container
  lifecycle; `start/stop/logs <name> <app>` address the app. `<app>` is a
  positional (it can be a nested path under `projects/`), `--target` is a flag
  (target names only need to be unique within an app, so any `app/target`
  delimiter would be ambiguous). `list-apps <name>` parallels
  `list-components`. Completion of `<app>` and `--target` is pure host-side
  filesystem, so it works with the container stopped.

- **Container-global gitignore.** A `core.excludesFile`
  (`.monoceros/global-gitignore`, wired in post-create) excludes `.monoceros/`
  from every repo in the container, so the per-app config dir does not pollute
  the app repo by default. Opting into versioning is per app via the app's own
  `.gitignore` (`.monoceros/*` + `!.monoceros/launch.json`, or `!.monoceros/`).
  A single-file re-include while the directory is globally excluded does not
  work (git does not descend into an excluded dir), hence the `*` + `!file`
  form.

## Consequences

- The agent keeps starting servers, now via `monoceros-ctl`; the human gains
  start/stop/restart from the host without knowing the command. The briefing
  flips from "run this raw `setsid` line" to "declare it in `launch.json`, run
  `monoceros-ctl`".
- This feature depends on the runtime image carrying `monoceros-ctl`: the host
  `start/stop <name> <app>` needs runtime >= 1.4.0. Older images simply lack
  the command (clean failure), consistent with the version-coupling pattern.
- Auto-restart across an `apply` is deliberately **not** in scope here (issue
  #23). The hard part is that "file exists" is not "was alive": a crashed
  process leaves a stale pid file, and after apply the container is recreated
  so the pid number is meaningless (pid recycling). The correct fix is a
  liveness snapshot taken **before** teardown, designed together with ADR 0026
  / issue #22.
- pids permanently leave `logs/`; a future reader of `logs/` sees only logs.

## Update (2026-06-23, #24): multiple default targets

The original spec allowed **at most one** `default`. Real use (an app whose API
and web frontend belong together) showed that "start the app" often means
"start a set". Revised:

- **Any number of targets may be `default: true`.** `start <app>` with no
  `--target` starts the whole default set; a single default behaves as before.
- **Declared array order is the start order.** Because `start` already waits for
  a target's `port` to listen before returning, ordering an entry before the
  things that depend on it (both with ports) gives real sequencing without a
  `dependsOn` concept. A target without a port has no readiness signal: started
  in order, but the next does not wait.
- **Fail-fast.** If a target in the set does not come up (process dies, or its
  port never listens within the window), the remaining ones are not started.
- **Single-target callers** (`logs`, `stop --target`, `start --target`) still
  resolve exactly one; a multi-target default set with no `--target` is an error
  for them.
- `stop <app>` with no `--target` mirrors start: it stops the same default set
  (best-effort, no fail-fast).

Ships in runtime 1.5.0 (the runner does the set iteration) + CLI 1.35.0 (relaxed
validation, briefing). An explicit `dependsOn` for port-less ordering stays out
of scope unless a real need appears.
