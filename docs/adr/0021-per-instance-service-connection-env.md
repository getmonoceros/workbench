# ADR 0021: Per-instance service connection env (multiple DB servers)

- Status: accepted
- Date: 2026-06-14

## Context

Curated services inject "connection env" into the workspace container so
the app and the in-container agent can reach them without knowing the
dev-default credentials. Today each service descriptor declares a flat
`service.connectionEnv` map of **fixed variable names**, e.g. postgres:

```yaml
connectionEnv:
  PGHOST: ${host}
  PGPORT: ${port}
  PGUSER: ${POSTGRES_USER}
  PGPASSWORD: ${POSTGRES_PASSWORD}
  PGDATABASE: ${POSTGRES_DB}
  DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${host}:${port}/${POSTGRES_DB}
```

`serviceConnectionEnv()` fills these per service and flattens them into a
single env map, which `scaffold.ts` writes into the workspace container's
compose `environment:` block — one flat namespace, **one value per
variable name.**

This breaks for **multiple database servers**, a normal need (app DB +
analytics DB, postgres + a pgvector store, two postgres, postgres +
mysql):

1. **Hardcoded names collide.** `postgres` and `mysql` both declare
   `DATABASE_URL`; with both present, the last-written wins and one URL
   is silently lost.
2. **Lookup is by exact catalog id.** Templates are resolved via
   `SERVICE_CATALOG[svc.name]`, so a second postgres the builder names
   `analytics` (names must be unique) gets **no** connection env.
3. **Service-name uniqueness isn't enforced**, so a duplicate name
   produces a broken compose file instead of an error.

## Decision

**One uniform rule, identical for one or N databases — no special
casing.** Every service that exposes connection info emits env vars
named after the service instance:

```
<UPPER(name)>_<SUFFIX>
```

`UPPER(name)` uppercases the service name, non-alphanumerics → `_`.
`SUFFIX` is what the descriptor declares (`URL`, `HOST`, `PORT`, `USER`,
`PASSWORD`, `DB`). So:

```yaml
# one postgres:
app:
  environment:
    POSTGRES_URL: postgresql://monoceros:monoceros@postgres:5432/monoceros
    POSTGRES_HOST: postgres
    POSTGRES_PORT: '5432'
    POSTGRES_USER: monoceros
    POSTGRES_PASSWORD: monoceros
    POSTGRES_DB: monoceros
```

```yaml
# postgres + pgvector — same rule, no branch:
  app:
    environment:
      POSTGRES_URL: …@postgres:5432/…
      POSTGRES_HOST: postgres
      …
      PGVECTOR_URL: …@pgvector:5432/…
      PGVECTOR_HOST: pgvector
      …
```

These names are unique by construction (service names are unique, point
4), so any number of databases coexist with zero collisions and one code
path for all counts.

**No bare conventional vars.** Monoceros does **not** inject
`DATABASE_URL`, the libpq `PGHOST`/`PGUSER`/… set, or `MYSQL_*`. Where a
framework defaults to `DATABASE_URL`, the in-container agent (Claude
Code / OpenCode — the AGENTS.md briefing lists the exact `<NAME>_*` vars)
sets it in the **project's `.env`**, or the builder does. Framework-/
project-specific config belongs in the project, not in Monoceros's global
injection. `psql` connects via `psql "$POSTGRES_URL"` rather than bare
libpq env.

**Resolved at apply, by catalog name (with an explicit override).** At
apply, each service's templates are looked up from the catalog **by its
service name**, filled, and emitted as `<NAME>_<SUFFIX>` (prefix from the
service's current name). A service may instead carry its own
`connectionEnv` block in the yml, which **overrides** the catalog — the
escape hatch for a custom-image service or a renamed second instance of
the same engine. So a curated `postgres`/`mongodb`/… (named as its
catalog id) gets its vars automatically; a same-engine second instance
renamed (e.g. `analytics`, required because names are unique) is not a
catalog id and must carry an explicit `connectionEnv` to get vars.

> Correction (2026-06-15): an earlier version of this ADR said the
> templates were **baked into the yml at expand** and read back at apply.
> They are not — the yml serializer does not persist a `connectionEnv`
> block, so reading only the baked field produced an **empty** workspace
> env (a regression shipped in 1.25.0). The mechanism is catalog-lookup
> by name, with the explicit-yml `connectionEnv` as an override.

**`apply` enforces unique service names.** A duplicate `services[].name`
is a hard validation error. `add-service` gains an optional instance name
so a second curated service of the same engine gets a distinct name.

The descriptor's `connectionEnv` keys change from full variable names to
**logical suffixes** (`URL`/`HOST`/`PORT`/`USER`/`PASSWORD`/`DB`); the
`<NAME>_` prefix is applied at render time.

## Rationale

- The collision lives in a flat env namespace; making the var name a
  function of the unique service name removes it at the root.
- **Uniformity over ergonomics-by-count.** A rule that behaves
  differently for one vs many DBs is special-casing spread across the
  fill logic and the briefing. One rule for all counts is simpler and has
  no "add a second DB and your `DATABASE_URL` silently vanishes" trap.
- The conventional-name convenience (`DATABASE_URL`, libpq) is a
  _project/framework_ concern; the container's coding agent or a project
  `.env` is the right place to map `<NAME>_URL` onto it.

## Consequences

- **Behavior change for existing single-DB ymls:** connection vars are
  now `POSTGRES_URL`/`POSTGRES_HOST`/… instead of `DATABASE_URL`/`PGHOST`.
  Apps that read `DATABASE_URL` set it from `POSTGRES_URL` (one line in a
  project `.env`); `psql` uses `psql "$POSTGRES_URL"`. The briefing
  explains the var names and the `.env` mapping.
- **Multiple DBs work identically** to one — no collisions, one code
  path.
- The yml service block gains a baked, editable `connectionEnv`; the
  briefing's "connection details" section is regenerated from it.
- `apply` may now reject a previously-accepted (broken) yml with
  duplicate service names — intended.

## Rejected

- **Count-based "conventional name iff exactly one service claims it"** —
  rejected: it special-cases one-vs-many in several places and silently
  drops `DATABASE_URL` when a second DB is added.
- **Always-present `DATABASE_URL` pointing at a designated primary** —
  rejected: adds a "primary" concept; the agent/project `.env` covers the
  framework need without it.
- **A `pgvector` reusing `DATABASE_URL`** (drop-in but un-coexistable) —
  rejected; multiple DB servers must work.
- **Prefixing libpq vars** (`POSTGRES_PGHOST`) — pointless, `psql` reads
  only `PGHOST`; we drop them and use `psql "$POSTGRES_URL"`.

## Related

- ADR 0020 (unified component descriptors) — the descriptor this extends.
- ADR 0003 (per-service bind-mounted data dirs).
