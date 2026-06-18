# ADR 0025 — Deferred service start for services that need cloned workspace files

- Status: **accepted**
- Date: 2026-06-18

## Context

A devcontainer and its auxiliary services come up **together**. In
compose mode, `monoceros apply` runs a single `devcontainer up`
([apply/index.ts], [devcontainer/compose.ts]). Inside that one call the
ordering is fixed by `@devcontainers/cli`:

1. `docker compose up -d` starts the `workspace` **and every service in
   `runServices`** as parallel siblings (no `depends_on` between them).
2. Features are baked into the workspace image.
3. Lifecycle hooks run **inside** the workspace, last of all
   `postCreateCommand` → `.devcontainer/post-create.sh`, which **clones
   the repos** into `projects/<path>/`.

So the repos (and any file inside them) appear only at step 3, **after**
all services have already started at step 1. This is the reverse of a
normal local docker-compose project, where the human clones first and
runs `compose up` second, so repo files are on disk before any container
boots.

This bites any service that needs a file from a cloned repo at boot:

- **Keycloak** with `start-dev --import-realm` reads a `realm.json` from
  its import dir. The realm is a project artifact (lives in the repo).
  At service start the repo is not cloned yet, so Keycloak boots with no
  realm and never re-imports (existing realms are skipped on later
  starts).
- **Postgres** with an `init.sql` bind-mounted from a repo - the exact
  case that motivated ADR 0012.

Constraints that close off the obvious fixes:

- The clone **must** run in-container (it needs the container's network
  and the mounted credential helper). Cloning host-side before `compose
up` was tried (ADR 0012) and **reverted**: the host does not share the
  container's network/auth context and produced false aborts across
  platforms.
- The workspace **cannot** reach the Docker daemon (container isolation,
  ADR 0002), so it can neither start nor restart a sibling service after
  the clone.
- Within `devcontainer up` there is **no Monoceros-controlled seam**
  between "services up" (step 1) and "clone done" (step 3) - they are
  one opaque call.

ADR 0012's revert note left this open ("remains open and should be
solved container-side"); ADR 0019 lists the per-service config model
(env/volumes, e.g. the Keycloak realm import) as the open design
question. This ADR resolves the **timing** half of both.

## Decision

Introduce a per-service boolean flag **`deferStart`** (default `false`).
A deferred service is **not** started together with the workspace;
Monoceros starts it in a **second wave**, host-side, **after**
`devcontainer up` returns - which is after `postCreateCommand` (and thus
the clone) has completed.

Mechanism:

1. The generated `devcontainer.json` lists only **non-deferred** services
   under `runServices`. The deferred service is still defined in
   `compose.yaml`, just not auto-started.
2. After `runContainerCycle` returns in `runApply` (an existing seam),
   Monoceros runs `docker compose -p <project> up -d <deferred services>`.
   Compose is additive, so this joins the deferred service to the same
   project the devcontainer-cli created.
3. The same two-wave logic applies to `monoceros start`. (On a restart
   the cloned files already exist on disk, so the deferral is harmless
   but no longer strictly necessary; keeping it uniform is simplest.)

`deferStart` is a **descriptor-only, hidden** field for now: it lives in
the service descriptor's `service:` block (`ServiceBlockSchema`, ADR 0020)
and is **not** exposed in the user-facing yml schema. A builder does not
set it by hand; only a curated `component.yml` carries it (the curated
**keycloak** entry sets `deferStart: true`). It is therefore **not** baked
into the expanded yml service object (unlike `connectionEnv`); instead the
start paths resolve it by **catalog lookup by service name**
(`SERVICE_CATALOG[name].deferStart`), the same fallback shape
`serviceConnectionEnv` already uses.

This keeps the surface minimal: no new user knob, no yml-schema change, no
`ResolvedService` field. The one consequence is that a **renamed** curated
service (a yml `name` that no longer matches the catalog id) loses the
deferral - acceptable while keycloak is the only deferred service. If
concrete use-cases for builder-set deferral appear, promote it to the yml
schema then.

This is the **timing** piece only. A working Keycloak service also needs
the import mount (where it reads `realm.json`) and a `command`
(`start-dev --import-realm`); those are separate descriptor additions.

## Consequences

- **Defining semantic / the sharp edge:** a deferred service is **not
  reachable during the workspace's `postCreate`**. This is free for the
  Keycloak-import case (nothing needs Keycloak during postCreate). It is
  a real trade for a service that postCreate depends on - e.g. a database
  you run migrations against in postCreate must **not** be deferred.
- Solves the Keycloak realm-import timing: by the time the deferred
  Keycloak starts, the repo (and its `realm.json`) is on disk, so the
  import behaves exactly like the normal local case. No waiting, no
  timeout, no race inside the container.
- Also solves the open ADR 0012 case (postgres + `init.sql` from a repo),
  with the same caveat - the builder opts in per service and accepts the
  "not available during postCreate" consequence.
- **Lifecycle impact is confined to the start paths.** `stop`, `status`,
  `remove`, and `logs` already operate on the whole compose project
  ([devcontainer/compose.ts]) and pick up the deferred service with no
  change. Only `apply` and `start` gain the two-wave logic.
- The second-wave `compose up` runs host-side, where Monoceros has
  docker/compose access - no new privilege, no workspace-side docker.
- Edge case handled: if **every** service is deferred, `runServices` is
  omitted entirely, so `devcontainer up` brings up only the workspace
  (covered by a scaffold test).
- A failure of the second-wave start is surfaced as a **warning** and
  does **not** flip the apply/start result - the workspace itself is up,
  and the builder can retry the deferred service with `monoceros start`.

## Rejected alternatives

- **Host-side clone before `compose up`** - this is ADR 0012, already
  tried and reverted (wrong network/auth context).
- **Keycloak waits internally** (its `command` polls for the file with a
  timeout, then starts) - leaves the pipeline untouched but carries a
  timeout delay on empty starts and a race for clones slower than the
  timeout. `deferStart` removes the wart entirely because the file is
  guaranteed present.
- **Global reorder: all services start after the clone** - regresses the
  common case (databases would be unreachable during postCreate, breaking
  migrations/seeds). The per-service flag keeps the default behavior and
  makes the deferral an explicit, local opt-in.
- **Workspace restarts/provisions the service after the clone** - via
  docker is impossible (no daemon access, ADR 0002); via Keycloak's HTTP
  admin API is possible but needs a post-create provisioning step plus a
  tool, and requires Keycloak up during postCreate. More moving parts
  than a declarative start-order flag.

[apply/index.ts]: ../../packages/cli/src/apply/index.ts
[devcontainer/compose.ts]: ../../packages/cli/src/devcontainer/compose.ts
