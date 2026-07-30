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
trace on disk. Seven rules:

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
  `.monoceros/launch.json`, a target on a port the container does not expose, a
  start command that pins the server to `127.0.0.1`, and a `readyTimeout` the
  pinned runtime is too old to honour (dropped in silence, so the target keeps
  the 20 seconds it was written to escape). Plus the two things that decide
  whether a target can start at all: a `cwd` that does not exist under the app
  directory, and a package script the project does not define - the `npm run dev`
  where the script is called `start`, which otherwise surfaces as an npm error
  out of the container on the first `monoceros start`. The finding lists the
  scripts the package does have.

  That last one only fires where the answer is unambiguous. Three things produce
  nothing: a compound command (`cd ui && npm run dev`), a workspace flag, where
  the script lives in that workspace's package rather than this one, and any
  toolchain outside npm, pnpm and yarn. The workspace case is not
  hypothetical: it is what the first real workbench this ran against used, and a
  naive lookup would have reported a script that is defined exactly where it
  should be. Leading environment assignments (`PORT=3000 npm start`) are skipped,
  and the `package.json` is resolved under the target's `cwd`, not the app root.

- `service-config` - a config file written for a service at the location the
  descriptor's `exampleVolumes` prescribe (`projects/<app>/keycloak/*.json`)
  that no volume in the yml mounts. This one is structural, not a slip: the
  agent can write the realm from inside the container but not the bind that
  feeds it, which lives in the yml on the host. The finding reads the file to
  name what it is (a realm export names its realm) and hands over the volume
  spec with `<app>` filled in. Only that directory is searched; a file the agent
  put elsewhere is out of scope, because guessing at any JSON under `projects/`
  would report more than it finds.
- `ports` - two launch targets on one port, which only one of them can bind,
  and a port exposed in the yml that no launch config declares, i.e. a route
  into the void. The second half stays quiet until at least one app has a launch
  config, since "ports exposed, apps not built yet" is the normal state right
  after `init --with-ports`.
- `briefing-markers` - `AGENTS.md` or `CLAUDE.md` without the marker pair. Apply
  then treats the file as Monoceros-owned and rewrites it whole, so notes the
  builder added to it are lost, silently.

It reads the container directory and the yml, needs no container, no docker and
no agent, and changes nothing. It exits 1 when it finds something, so a
pipeline or an e2e scenario can assert on it.

`monoceros status` carries the two rules that belong to its own register -
whether a thing that runs can actually answer - as markers on the row they
concern: a target on an unexposed port (no `.localhost` URL for it either, since
the proxy has no route) and a service whose config file nothing mounts. Both
print the way out where the builder is standing, rather than pointing at
`check`, which would only print another report. The `service-config` detector is
shared between the two commands so they cannot disagree. The remaining rules
stay out of `status`: a compose file that deliberately pins an older database is
the builder's call, and `status` must not become a nag screen.

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
