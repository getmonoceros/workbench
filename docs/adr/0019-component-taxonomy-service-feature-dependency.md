# ADR 0019: Component taxonomy: service vs. feature vs. dependency

- Status: accepted
- Date: 2026-06-12

## Context

Every time a new tool, framework, database, or CLI is proposed for the
catalog, the same question resurfaces: does this become a Monoceros
**service**, a **feature**, or is it none of our business? Without a
written rule each candidate is re-argued from scratch, and the answers
drift. This ADR fixes the boundary so future "should we support X?"
discussions resolve by classification, not by re-derivation.

The catalog today has three kinds of entries (see
`packages/cli/src/create/catalog.ts` and
`packages/cli/templates/components/`):

- **languages** (node, python, java, go, rust, dotnet) — a toolchain
  installed into the workspace container via an upstream devcontainer
  feature
- **services** (postgres, mysql, redis) — separate networked containers
- **features** (claude-code, github-cli, atlassian) — tools installed
  into the workspace container

"Language" is really a specialized "feature" (it installs a toolchain
into the workspace). The hard, recurring boundary is the other three:
service, feature, and the category that does **not** belong in the
catalog at all — a project **dependency**.

## Decision

A candidate is classified by **where it lives and who provisions it**:

**Service** — it is a _server process that runs as its own networked
container_, and the workspace talks to it over the network. Provisioned
by Monoceros as a sibling container with connection env injected into
the workspace.
Examples: postgres, mysql, redis, and (accepted as future candidates)
mongodb, minio, mailpit, pgvector, keycloak.
Test: "Is it a separate server the app connects to?" → service.

**Feature** — it is a _globally installed tool inside the workspace
container_ (a CLI, an SDK, an agent) that would be tedious to set up by
hand and is useful **across projects**, not pulled from any single
project's manifest. Provisioned as a devcontainer feature.
Examples: claude-code, github-cli (`gh`), atlassian CLIs, and (accepted
as future candidates) opencode, glab, cloud CLIs.
Test: "Is it a global tool you'd otherwise install once per machine /
container, independent of any project's package manifest?" → feature.

**Dependency** — it is a _library or framework pulled from the project's
own package manifest_ (`pom.xml`, `build.gradle`, `package.json`,
`requirements.txt`, …). Monoceros provides the language + toolchain; the
dependency comes from the project and is **not** a catalog entry.
Examples: Spring Boot, Django, Rails, Next.js, Express.
Test: "Does the language's package manager fetch it from the project
manifest?" → dependency, out of scope.

The line between feature and dependency, one level deeper than
service-vs-feature: **frameworks are dependencies, not features.** A
framework becomes feature-worthy only if it ships a _globally installed
CLI_ that is both painful to obtain otherwise **and** useful across
projects — and even then it is the bar, not a default. The Spring Boot
CLI, for instance, does not clear it: scaffolding is covered by Spring
Initializr (`start.spring.io`) and building/running needs only the JDK +
Maven/Gradle that the `java` language feature already provides.

## Rationale

- One axis explains all three categories: **provisioning locus.**
  Separate container → service. Installed into the workspace globally →
  feature. Comes from the project manifest → dependency (not ours).
- It keeps the catalog honest and small. Frameworks do not bloat it;
  they live where they belong, in the project's build file.
- It is technology-independent. Keycloak is a service whether the app is
  Node or Java; Spring Boot is a dependency regardless of which IAM sits
  next to it. Classification never depends on the surrounding stack.

## Consequences

- New catalog requests are triaged against the three tests above before
  any implementation discussion. A "no, that's a dependency" is a valid,
  cheap answer.
- Confirmed near-term additions by category: **features** opencode,
  glab; **services** mongodb, minio, mailpit, pgvector, keycloak. (Build
  order and the service config model — env/volumes, e.g. Keycloak realm
  import — are tracked separately, not decided here.)

## Edge cases / rejected

- **Supabase (local).** Does not fit "service": `supabase start` is
  itself a docker-compose stack of ~10 containers orchestrated by the
  Supabase CLI. Modeling it as a feature would require docker-in-docker
  and a second, CLI-hidden orchestration beneath Monoceros's single
  declarative compose file — which contradicts the "the yml is the
  source of truth" premise. Deferred as its own design question (nested
  orchestration vs. single-compose), not a catalog entry.
- **Spring Boot / framework CLIs as features.** Rejected as a default:
  frameworks are dependencies (above). A framework CLI is considered
  only against the "global, painful otherwise, cross-project" bar.
- **RabbitMQ / Kafka.** Are services by the test, but only needed when a
  specific project builds on them — not cross-cutting like a database or
  a mail catcher. Added on demand, not pre-emptively.

## Related

- `packages/cli/src/create/catalog.ts` — service + language catalogs.
- `packages/cli/templates/components/` — component templates (the
  `category` field already encodes language/service/feature).
- The service config model (per-service env/volumes, e.g. Keycloak realm
  import) is an open design point referenced here but decided elsewhere.
