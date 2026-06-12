# ADR 0020: Unified component descriptors: one component.yml as single source of truth

- Status: accepted
- Date: 2026-06-12

## Context

Component metadata (languages, services, features) currently lives in
three separate representations plus a bundled copy, all hand-synced and
free to drift:

1. **`packages/cli/src/create/catalog.ts`** - config-in-code:
   `LANGUAGE_CATALOG` and `SERVICE_CATALOG` as TypeScript `Record`
   literals (image, env defaults, healthcheck, ports, the new
   `defaultOptions`, ...).
2. **`images/features/<name>/devcontainer-feature.json`** plus its
   `x-monoceros` block - the definition for the features we author
   (options schema, defaults, `optionHints`, `persistentHomePaths`,
   `briefing`).
3. **`packages/cli/templates/components/*.yml`** - hand-written yml
   fragments (the `contributes` block) that `init` merges into the
   builder's yml, carrying literal options like `permissionMode: auto`.
4. **`packages/cli/features/<name>/` bundle** - produced by
   `scripts/sync-feature-manifests.mjs`, which only **copies** the
   hand-written manifest into the npm package (run via `prebuild`).

There is no machine link between these. Concrete drift already exists:

- `claude.yml` sets `permissionMode: auto` as a literal; the manifest
  separately declares `permissionMode` (default `auto`), `apiKey`,
  `version`, and lists `optionHints: ["apiKey"]`. `permissionMode` is
  in neither the hints nor derived from the manifest default. If the
  manifest default changes, the template never tracks it.
- Service image versions in `SERVICE_CATALOG` (`postgres:18`,
  `redis:8`) drifted from the docs (`postgres:16`, `redis:7`).
- `defaultOptions` for `java` was added in code (catalog.ts), invisible
  in the builder's yml, while feature options are visible.

Three problems follow:

1. Feature metadata is maintained in **two places** (manifest +
   component template) and kept in sync by hand. It does not stay in
   sync.
2. **Config-in-code does not scale.** Every new language/service edits
   one growing central file; at 20-30 entries it is unmaintainable, and
   it mixes data with logic.
3. **No uniform format**, although the needs are ~90% identical across
   categories: `id`, `displayName`, `description`, `options`,
   `optionHints`, `briefing`.

## Decision

**1. One descriptor per component is the single source of truth.** A
root `components/` tree, one `component.yml` per component:

```
components/
  languages/java/component.yml
  services/postgres/component.yml
  features/claude-code/
      component.yml                 # single source of truth
      install.sh                    # feature-specific, stays
      devcontainer-feature.json     # GENERATED, never hand-edited
```

`catalog.ts`'s `LANGUAGE_CATALOG`/`SERVICE_CATALOG` and
`templates/components/*.yml` are removed. `images/` keeps only
`runtime/`.

**2. `devcontainer-feature.json` is generated from `component.yml`,
never hand-written.** A `generate-feature-manifests` step (replacing the
copy-only `sync-feature-manifests.mjs`) runs at the same hooks: the
`packages/cli` `prebuild` (for the npm bundle) and in
`release-features.yml` before the GHCR publish (so the spec file exists
at publish time). The generated file is not committed; the source of
truth is `component.yml`. `image:build` / `image:rebuild` (the runtime
image) are untouched.

**3. One unified schema** for all three categories: a common head, a
single option model, briefing, and a small category-specific block.

```yaml
id: claude-code
category: feature # language | service | feature
displayName: Claude Code
description: "Anthropic's CLI coding assistant ..."
documentationURL: https://docs.anthropic.com/en/docs/claude-code

options: # one option model for all categories
  apiKey:
    type: string
    default: ''
    description: 'sk-ant-… for API auth; empty for OAuth on first run.'
    secret: true # replaces x-monoceros.optionHints
    surface: yml # yml | silent | env
  permissionMode:
    type: string
    default: auto
    proposals: [auto, ask, edits, bypass]
    surface: yml

briefing:
  - text: 'Claude Code CLI (`claude`) ...'
  - whenOption: rovodev
    text: '...'

feature: # category-specific block
  persistentHomePaths: ['.claude']
  persistentHomeFiles: [{ path: '.claude.json', initialContent: "{}\n" }]
```

```yaml
id: java
category: language
language:
  feature: ghcr.io/devcontainers/features/java:1
  builtin: false
  versions: [latest, 21, 17, 11, 8]
options:
  installMaven: { type: boolean, default: true, surface: yml }
  installGradle: { type: boolean, default: true, surface: yml }
```

```yaml
id: postgres
category: service
service:
  image: postgres:18
  defaultPort: 5432
  dataMount: /var/lib/postgresql
  healthcheck:
    { test: [CMD, pg_isready, ...], interval: 10s, timeout: 5s, retries: 5 }
  connectionEnv: [DATABASE_URL, PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE]
  vscodeExtensions: [cweijan.vscode-database-client2]
options:
  POSTGRES_USER: { type: string, default: monoceros, surface: env }
  POSTGRES_PASSWORD:
    { type: string, default: monoceros, secret: true, surface: env }
  POSTGRES_DB: { type: string, default: monoceros, surface: env }
```

`secret: true` replaces `x-monoceros.optionHints` (it can no longer
fall out of sync with the option list). `surface` decides, per option,
where it is written: `yml` into `container-configs/<name>.yml`, `env`
into `<name>.env`, `silent` only into the generated devcontainer.json.

One in-memory `Component` model, one loader. Every consumer
(`list-components`, the `init` generator, `resolveFeatures`, the
briefing generator, `serviceConnectionEnv`) reads only from it.

**4. Options reach the builder's yml, uniformly - the user yml schema
is extended backward-compatibly.** Features and services already carry
options/env in the yml. Language entries become `string | object` so
language options can be surfaced too:

```yaml
languages:
  - node # shorthand still valid
  - java: # object form when options are surfaced
      version: 21
      installMaven: true
      installGradle: true
```

Existing string entries (`java`, `java:21`) keep parsing. At `init`,
options marked `surface: yml` are written into the yml with their
defaults; this settles the earlier inconsistency (ADR-less, raised in
review) by making `java`'s Maven/Gradle and `claude`'s `permissionMode`
follow one rule.

## Rationale

- A single source kills drift **structurally**, not by discipline. The
  manifest, the yml fragment, the hints, and the briefing are all
  derived from one file.
- File-per-component scales linearly and keeps data in data files, not
  in a growing TypeScript literal.
- One schema because the needs are ~90% shared; the differences are a
  small per-category provisioning block.
- `surface` gives one consistent, declarative rule for option
  visibility across every category.
- Extending (not freezing) the user yml schema keeps existing ymls and
  materialized containers working while letting new ymls be richer.

## Migration (phased, surgical)

1. Build the schema + a zod loader + the `Component` model alongside the
   existing code.
2. Add the `component.yml` -> `devcontainer-feature.json` generator;
   wire it into `prebuild` and `release-features.yml`.
3. Move consumers onto the new model one at a time
   (`list-components`, `init`, `resolveFeatures`, briefing).
4. Port the `catalog.ts` data and `templates/components/*.yml` into
   descriptors; delete the old sources; update the
   `release-features.yml` publish path
   (`images/features/` -> `components/features/`).

**Invariant:** existing `container-configs/<name>.yml` files still parse
and `apply`; already-materialized containers under `container/<name>/`
are untouched (they do not read the catalog at runtime). A re-`apply`
may fold in the new defaults (e.g. `languages: [java]` now also gets
Maven/Gradle) - intended, not a break; `remove` + `apply` (or `upgrade`)
adopts it.

## Consequences

- The copy step (`sync-feature-manifests.mjs`) becomes a generate step.
  The generated `devcontainer-feature.json` is gitignored; the source of
  truth is `component.yml`.
- `release-features.yml` gains a generate-before-publish step and a
  publish-path update.
- The language-spec parser handles `string | object`; the yml schema and
  its validation grow the object form.
- `version` handling is unchanged in spirit: a feature's `version` stays
  `surface: silent` so it floats to latest (ADR 0018); a language pins
  via the `:version` suffix or the object `version:` key.
- `catalog.ts` shrinks to helpers only (e.g. `serviceConnectionEnv`,
  runtime-image resolution); the catalog `Record`s are gone.

## Rejected

- **Keep config-in-code (`catalog.ts`).** Does not scale, mixes data and
  logic, central-file churn.
- **Make `devcontainer-feature.json` the source of truth and add
  parallel descriptors for languages/services.** Weaker uniformity; the
  `version` field is feature-publishing-specific and meaningless for
  languages/services; only covers the features we author.
- **Express `java` as a feature block in the yml** (to surface options
  the same way as `claude`). Loses the `languages:` shorthand and the
  `:version` UX; conceptually demotes a language to a feature.
- **Freeze the user yml schema** (managed language options stay
  invisible). Conflicts with the requirement that the options we manage
  appear in `container-configs/<name>.yml`.

## Related

- ADR 0019 (component taxonomy) - this is the structural realization of
  that service/feature/dependency split.
- ADR 0018 (tool freshness) - feature `version` stays unpinned, now
  expressed as `surface: silent`.
- `packages/cli/scripts/sync-feature-manifests.mjs` - becomes the
  generator; `release-features.yml` - gains generation + a path update.
