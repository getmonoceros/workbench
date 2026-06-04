# `monoceros add-service`

Adds a backing service (database, cache, object store, …) to the
container config. Idempotent, shows a diff before writing.

```sh
monoceros add-service <name> <service-or-image> [--as=<service-name>] [--yes]
```

## Two ways to register a service

`<service-or-image>` is interpreted as follows:

- **Curated name** (`postgres`, `mysql`, `redis`) → expands to a
  **complete, editable service block** with image, default port,
  persistent `data:` volume, `healthcheck` (the workspace waits via
  `depends_on` for `service_healthy`, not just "container started"),
  and `restart: unless-stopped`. The env values render as `${VAR}`
  placeholders; the dev defaults (`POSTGRES_USER=monoceros`, …) are
  seeded into `<name>.env` (see "Secrets"). Runnable right away; you
  adjust afterward as needed.

- **Arbitrary image** (`rustfs/rustfs:latest`, `clickhouse/clickhouse-server:24`)
  → actively writes `name` + `image` and places the rest (`port`, `env`,
  `volumes`, `healthcheck`) below as a **commented-out skeleton**.
  Monoceros doesn't know third-party images — you fill in what the image
  needs. A note about this is printed to the console.

For curated services the service name (Compose service, DNS name on the
network, data directory) is the name itself; for images it's derived
from the image ref (`rustfs/rustfs:latest` → `rustfs`).

## Examples

```sh
# Curated: full block with dev defaults
monoceros add-service logoscraper postgres

# Arbitrary image: name + image + commented-out skeleton
monoceros add-service logoscraper rustfs/rustfs:latest

# The same service multiple times — its own name per instance
monoceros add-service logoscraper postgres --as=postgres-app
monoceros add-service logoscraper postgres --as=postgres-analytics
```

## The service model

Each service entry is an object. Fields:

| Field         | Purpose                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `name`        | Compose service name / DNS hostname / data directory. Unique per container.                        |
| `image`       | Docker image (required).                                                                           |
| `port`        | **Internal** listen port → default for `monoceros tunnel`. **No** host mapping.                    |
| `env`         | Environment variables. `${VAR}` is resolved from `<name>.env` (see below).                         |
| `volumes`     | `data:/path` (persistent bind mount under `data/<name>/`) or relative host path (`projects/…:/…`). |
| `healthcheck` | Compose healthcheck. `test` as a string or `["CMD", …]` array.                                     |
| `restart`     | `no` / `always` / `on-failure` / `unless-stopped`.                                                 |
| `command`     | Override the container command.                                                                    |

Deliberately **not** included: `ports` (host mappings) — host exposure
goes through [`add-port`](./add-port.md) (HTTP via Traefik) or
[`tunnel`](./tunnel.md) (TCP). And no Docker named volumes — `data:`
binds to the host disk so data is part of `remove` backups
([ADR 0003](../adr/0003-container-state-model.md)).

## Secrets: `${VAR}` and `<name>.env`

Values like passwords don't belong in the (shareable) yml. In the yml the
env keys are named the same as the `${VAR}` placeholder — for curated
services that's the env key itself, i.e. `POSTGRES_PASSWORD →
${POSTGRES_PASSWORD}`:

```yaml
# container-configs/logoscraper.yml
services:
  - name: postgres
    image: postgres:18
    env:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
```

```sh
# container-configs/logoscraper.env  (gitignored)
POSTGRES_PASSWORD=monoceros        # from seeding; change to a real secret here
```

Curated services seed their dev defaults automatically when registered
(`add-service` reports which keys it created) — so the container runs
right away, and you change a value in only one place. Custom images seed
nothing (Monoceros doesn't know their variables); there you enter
placeholders + `.env` keys by hand.

Copying the container means: copy both `<name>.yml` **and** `<name>.env`,
then adjust the `.env` — same structure, different secret.

On `apply` all `${VAR}` are replaced from `<name>.env` — both in
**service fields** and in **feature options**. This keeps API tokens out
of the yml too:

```yaml
features:
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
    options:
      apiKey: ${ANTHROPIC_API_KEY} # value comes from <name>.env
```

This way the yml can be shared without handing over tokens. If a variable
is missing, the apply aborts with a clear, collected error message
(instead of silently setting an empty value). `monoceros init` creates
`<name>.env` with explanatory text right away; it travels with `remove`
backups and is excluded from version control via
`container-configs/.gitignore` (`*.env`).

## `--as` — the same service multiple times

`--as=<name>` overrides the service name. Needed to register the same
image more than once (two Postgres servers) or to keep two images that
derive the same name distinct. Each instance gets its own
`data/<name>/` directory and its own DNS name.

## Reachability + credentials

From within the dev container the service is reachable via its **name**
as the hostname (not `localhost`) on its internal port:

```
postgresql://<user>:<pass>@<name>:5432/<db>
```

Curated Postgres with the seeded dev defaults
(`monoceros`/`monoceros`/`monoceros` from `<name>.env`):

```
postgresql://monoceros:monoceros@postgres:5432/monoceros
```

If you change `POSTGRES_*` in the `.env`, the URL changes accordingly.

From the **host** (DB GUI, etc.) there is no `localhost:5432` — use
[`monoceros tunnel <name> <service>`](./tunnel.md) for that.

## DB schema / seed: migration, not an `init.sql` bind mount

The obvious approach would be to bind-mount an `init.sql` from a repo into
the service (Postgres' `docker-entrypoint-initdb.d`). **Don't do that**
in a Monoceros container: repos are cloned **inside the container**
(post-create, after the container starts), so they're **not** on the host
before `compose up` starts the service — the bind-mount source would be
empty, and the schema would never be applied.

The robust path is the one real apps use anyway: **a migration** that you
run **from the workspace** against the service once it's ready. On apply
the workspace already waits for `service_healthy` — so when your migration
runs, the DB is accepting connections:

```sh
# in the workspace, after `monoceros apply` is done:
npm run migrate            # or: psql "$DATABASE_URL" -f db/schema.sql
```

For one-off things that need **superuser** privileges (`CREATE EXTENSION`,
roles), apply them once via [`monoceros shell`](./shell.md) /
[`tunnel`](./tunnel.md) + `psql`.

## Idempotency + collision

- Same call twice → no change (an existing service with the same image is
  left untouched, your edits to the block survive).
- Same name, **different** image → error with a hint to use `--as`.

## Arguments + options

| Argument / Option     | Meaning                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `<name>`              | Container name.                                                           |
| `<service-or-image>`  | Curated name (`postgres`/`mysql`/`redis`) or arbitrary image ref.         |
| `--as=<service-name>` | Override the service name (same service multiple times / name collision). |
| `--yes, -y`           | Skip the diff confirmation prompt (for scripts).                          |

## External services instead of a local Compose service

Existing DB outside the container (production, shared dev DB): instead of
`add-service`, by hand in the yml:

```yaml
externalServices:
  postgres: postgresql://user:pass@host:5432/dbname
```

On apply no `postgres` Compose service is generated — the container
accesses the external host directly.

## Related commands

- [`remove-service`](./remove-service.md) — the inverse (data directory remains)
- [`tunnel`](./tunnel.md) — reach the service from the host
- [`monoceros apply <name>`](./apply.md) — make the change take effect

## Failure modes

- **`A service named '<name>' already exists with a different image`** —
  use `--as=<other>` or remove the existing service first.
- **`Invalid --as name …`** — name must be `[a-z0-9][a-z0-9_-]*`.
- **`No such config`** — the container yml doesn't exist.
