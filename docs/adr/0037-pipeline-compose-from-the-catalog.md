# ADR 0037: The project's pipeline compose file is assembled from catalog parts

- Status: accepted
- Date: 2026-07-29

## Context

A project built in a workbench needs its services in a pipeline too, and in a
different shape than the dev container runs them. The workbench already knows
which services the app depends on: they are in the container yml.

Left to itself, the in-container agent derives that shape from
`.devcontainer/compose.yaml` or from what it remembers about the image. Both
were tried in a real run, and both went wrong in ways nobody would notice in
review:

- The generated compose file carried this workbench's dev credentials as
  fallbacks, `${POSTGRES_USER:-monoceros}`. A forgotten pipeline variable would
  have brought up a reachable database on a user and password that sit in the
  catalog.
- Keycloak was configured with `start-dev`, which keeps everything in an
  in-memory database and turns the hostname check off, in a file the project
  used for a staging-like environment.
- The realm file the agent wrote contained demo users with passwords and a
  client with the password grant enabled.

Writing the file for the project is not an option either. It holds the app's own
services (build, migrations, the app itself), a developer edits it, and it lives
in the repo.

## Decision

Every curated service carries the finished compose service block in its
`component.yml` under `deploy:`. `apply` renders `.monoceros/deploy.md` from the
services actually configured, and the agent copies a block verbatim and builds
the app's own services around it. The briefing points at that file and tells the
agent not to derive the configuration from the dev compose or from memory.

The blocks are compose, not prose. Prose ages silently and cannot be checked; a
fragment can be rendered, parsed, validated with `docker compose config` and
started.

Four properties the blocks hold to, because each one was a defect first:

- **No variable defaults.** Every value is `${VAR:?message}`, so compose stops
  with a named variable instead of starting on a catalog credential. Enforced:
  the catalog refuses to load a `deploy` block containing `${VAR:-…}`.
- **Deployment settings, not dev settings.** Keycloak runs `start` with its own
  database and a set hostname, MySQL creates a non-root application user, Redis
  gets `--requirepass`. Where the two genuinely differ, the block says so in one
  line (Mailpit is for test runs only).
- **`deploy.requires` for what a service needs beside itself**, as a fragment
  with top-level keys, so a named volume can be declared and a service can bring
  several parts. Keycloak brings its own postgres, rustfs its data volume.
  Everything contributed is named after the component, checked on load, so two
  blocks in one file cannot collide.
- **One image.** `deploy.compose` must name the same image as `service.image`
  (checked on load), and the renderer swaps in a per-container image override, so
  the dev container and the pipeline cannot drift apart.

A service without a block is named in the file rather than omitted, so the agent
cannot read silence as "this one needs nothing".

## Consequences

- **The compose file stays the project's.** On a later run the agent reconciles
  it: adds what is missing, leaves what a human edited alone. Git is the merge
  mechanism, as for any other shared file.
- **A new curated service is not finished without a `deploy` block.** Eight
  services have one today.
- **Data provisioning stays out of scope.** The blocks describe how a service
  runs, not how a schema or a realm gets into it. The app's schema comes from the
  project's migrations as its own pipeline step. Keycloak's boot import only
  fills an empty database, so changing a realm in an existing environment needs
  the project's own step (partialImport or config-as-code); the workbench does
  not ship tooling that reaches a deployment.
- **The parts are verified, not asserted.** All eight blocks were rendered into
  one compose file and started: nine containers healthy, and the credentials
  checked to be in effect (Redis rejects an unauthenticated `ping`, MongoDB an
  unauthenticated insert, the MySQL app user sees only its own database). That
  run found a healthcheck that never turned healthy.
