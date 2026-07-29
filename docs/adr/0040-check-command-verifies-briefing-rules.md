# ADR 0040: `monoceros check` verifies the briefing rules that leave a trace

- Status: accepted
- Date: 2026-07-29

## Context

The briefing tells the in-container agent how to work in a workbench (ADR 0014,
ADR 0039). A live test showed what happens when it does not read it: files at
the wrong place, service configuration written from memory, the new project
missing from the workspace file. All of it looks fine on the surface. The user
finds out by reading the result closely, or not at all.

Instructions cannot close that gap on their own, and the workbench cannot make
the agent read. What it can do is look at the result afterwards.

## Decision

`monoceros check <name>` reports, host-side, the briefing rules that leave a
trace on disk. Four rules:

- `workspace-registration` - a directory directly under `projects/` that is
  missing from `<name>.code-workspace`, so the editor never lists it.
- `workspace-root` - entries at the workspace root that are not
  Monoceros-owned, i.e. project files one level too high.
- `compose-drift` - a project compose file whose service block differs from the
  catalog's `deploy.compose` (ADR 0037): a different image tag, a missing
  healthcheck, or a value that does not fail fast where the block requires
  `${VAR:?…}`. What is required there is the `:?`, not the catalog's variable
  name: `${PG_PASSWORD:?…}` is the project doing the right thing under its own
  name, a variable without `:?` starts the service on an empty value, and a
  literal keeps the credential in the repo. Only service keys that name a
  catalog service are compared.
- `launch-config` - a project that serves something but declares no
  `.monoceros/launch.json`, a target on a port the container does not expose,
  or a start command that pins the server to `127.0.0.1`.

It reads the container directory and the yml, needs no container, no docker and
no agent, and changes nothing. It exits 1 when it finds something, so a
pipeline or an e2e scenario can assert on it.

The language rule and "do not write service configuration from memory" are not
checkable. That is exactly why they sit in the first lines of the briefing
instead of in more text further down.

## Consequences

- The check mirrors rules that live in the briefing generator. A rule that
  changes there has to change here, and vice versa - the two are only coupled
  by intent.
- A project's local dev compose file is compared like any other compose file.
  A project that deliberately runs an older database locally will be reported;
  the finding names the difference and changes nothing, so the user decides.
- The workspace-root rule needs an allowlist, and an incomplete one makes the
  command cry wolf on a healthy container. `.pnpm-store` is the case that showed
  up on the first real run: pnpm keeps its store on the project's filesystem,
  which in a dev container is the workspace mount and not `$HOME`, so it lands
  at the root of every Node workbench where pnpm ran. Tool caches that behave
  like that belong in the allowlist, not in a finding.
- The undeclared-server rule works from markers (a `dev`/`serve` script,
  Django's `manage.py`, a Spring Boot build), so it is deliberately narrow: a
  library with only a `build` script is not flagged, and an exotic server
  without a marker is missed.
