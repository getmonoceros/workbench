# ADR 0029: `monoceros status` as a stack overview, not a docker-ps dump

- Status: accepted
- Date: 2026-06-25

## Context

`monoceros status <name>` passed the raw output of `docker compose ps` (compose
mode) or `docker ps -a` (image mode) straight through. That table shows the
container, but nothing Monoceros-shaped: services appear by their docker name
(not the yml name), ports are internal mappings rather than the `*.localhost`
URLs the proxy actually serves, and **apps do not appear at all** - even though
ADR 0027/0028 made long-running app servers first-class. There was no
`status <name> <app>`, so the only way to ask "is my dev server up?" from the
host was to `shell` in and run `monoceros-ctl list`.

## Decision

**`status` renders a Monoceros-styled overview of the whole stack**, in the same
visual vocabulary as `monoceros-ctl list` and the apply summary (`▸` sections,
cyan identifiers, `✓` up / `·` down, dimmed secondary detail).

Sections: **Container**, **Services**, **Apps**, **Ports**, **Built in**.

- **Two registers, kept apart.** Runtime state (container / services / apps)
  carries a `✓`/`·` liveness glyph. Declared composition (Built in = languages +
  features, and the Ports it routes) comes from the yml and carries **no**
  glyph - a feature is never "stopped", it is baked into the image or it isn't.
  Mixing the two would make `·` read as "stopped" for something that has no run
  state. The Built-in block is captioned "from the yml" to mark the register.

- **Data sources.**
  - Container: `docker ps -a` filtered by the `devcontainer.local_folder`
    label (the same stable handle `shell`/`remove` use), for state + uptime +
    docker name + compose project.
  - Services: `docker ps -a` filtered by the `com.docker.compose.project`
    label read off the container, mapped onto the yml's declared service names
    (so a declared-but-down service still shows, as `not created`/stopped).
    Keying on the project label avoids parsing version-variable `compose ps
--format json`.
  - Apps: `monoceros-ctl list --json` (new NDJSON surface on the runner) execed
    in the container - one source of truth for liveness, no ANSI to scrape.
  - Ports / Built in: the yml, via `solutionConfigToCreateOptions` +
    `proxyUrlsFor`. The app inventory also comes host-side from the launch
    configs, so it lists even with the container stopped.

- **Graceful degradation.** App liveness needs the container up **and** runtime
  1.6.0 or newer (for `list --json`). When either is missing, apps are still
  listed from the host-side launch-config inventory but without a glyph, plus a
  one-line note ("start the container…" / "needs runtime 1.6.0+"). Services come
  from `ps -a`, so they still show as stopped. Ports and Built in always render
  (pure yml), so `status` is useful even on a cold or absent container.

- **`status <name> <app>` narrows.** A positional that the launch config knows
  renders just that app's targets; otherwise it is treated as a compose service
  (one-line view); otherwise an error listing the known names. This mirrors
  `logs <name> [<app>]`'s dual-meaning positional.

## Consequences

- The Built-in block overlaps the post-apply summary's feature/language echo.
  Accepted: the summary is a point-in-time echo right after `apply`; `status` is
  the on-demand "how does it look now". `status` is deliberately more than pure
  runtime state.
- New runtime surface: `monoceros-ctl list --json` (NDJSON, one object per
  target). Gated host-side by `runtimeSupportsAppStatus` (>= 1.6.0); the same
  image that ships `reconcile` (ADR 0028).
- The raw docker table is gone. No `--raw` escape hatch was added; `docker ps` /
  `docker compose ps` remain available directly for anyone who wants the table.
- Ships in runtime 1.6.0 (`list --json`) + CLI 1.36.0 (the renderer + the
  `<app>` positional), alongside the ADR 0028 app-restore work.
