# ADR 0052 — `upgrade` carries a service-image fix to an existing workbench

- Status: accepted
- Date: 2026-08-21

## Context

A critical CVE landed in Keycloak (CVE-2026-18963, unauthenticated
account takeover through the reset-credentials flow). The catalog shipped
`quay.io/keycloak/keycloak:26.6`, and the fix is only in the 26.7 line:
upstream stopped publishing community images for 26.6 after 26.6.4, so
the floating `26.6` tag will never carry the patch. Bumping the catalog
to `26.7` was the obvious half of the answer.

The other half was not obvious, and it was wrong. A builder who already
runs a workbench with Keycloak had **no path to the fix**, because two
things stood in the way:

1. The image reference lives in the container yml, not in the catalog at
   runtime. `init` / `add-service` expand a catalog entry into an
   editable block, and from then on the yml is the source of truth. A
   catalog bump therefore reached new workbenches only. `upgrade` rewrote
   `runtimeVersion:` and nothing else.
2. Even with the same tag string, nothing re-pulled. `docker compose up`
   uses whatever is in the local image cache, so a floating tag that
   moved upstream (`postgres:18` gaining a patch) never arrived either.

ADR 0018 made `upgrade` the single freshness action and listed what it
refreshes: feature tools, the runtime base, plus prune and a timestamp.
Service images were simply not in that list. The result was a command
that promises freshness and quietly leaves the one component most likely
to carry a security fix untouched — a database, an identity provider, a
message broker.

## Decision

**`upgrade` refreshes curated service images too.** Two mechanisms,
because the two failure modes above are independent:

**1. It writes the catalog's current tag into the yml.** Per target
container, after the runtime pin, every service whose image comes from
the catalog is pulled up to the reference the catalog ships now. Each
rewrite is logged (`old → new`) and counted in the summary, because
`upgrade` silently editing a builder's config would be worse than the
staleness it fixes.

Matched by image **repository**, not by service name. That also catches
an instance renamed with `add-service … --as`, and it leaves an image the
builder chose themselves alone — no catalog entry claims its repository,
so nothing rewrites it. Only indented `image:` lines are considered, so a
top-level key and a commented-out example scaffold are never touched, and
the rewrite is textual so comments and layout survive (same approach as
`setRuntimeVersion`).

**2. It re-pulls the project's service images before anything starts.**
`docker compose pull --ignore-buildable --ignore-pull-failures`, with the
deferred-service profile active, against the compose file the current
apply just wrote. It runs before the container cycle so both the initial
`devcontainer up` and the deferred second wave (ADR 0025) find fresh
images locally.

`--ignore-buildable` skips the workspace service, which is built from the
Dockerfile rather than pulled. `--ignore-pull-failures` and a caught
exception keep an offline or rate-limited registry from failing the whole
upgrade: the cached image still starts, and the builder gets a warning
naming the apply log.

**Routine `apply` does none of this.** It reuses the cache, exactly as it
reuses the base pin and the feature layers (ADR 0017, ADR 0018).

## Rationale

- **`upgrade` is the freshness command.** A builder who runs it to get
  security fixes should get the service ones too. Anything else makes the
  command misleading rather than merely incomplete.
- **The yml stays the source of truth.** `upgrade` does not read the
  catalog behind the yml's back at apply time; it edits the yml, visibly,
  the same way it already edits `runtimeVersion`. The container remains
  derivable from its config alone, and the change is in git-diffable
  reach of the builder.
- **A builder's own image is theirs.** Repository matching means "you run
  the catalog's Postgres, here is its current tag", never "we know better
  than your pin".
- **The re-pull is separate on purpose.** Retagging alone would miss a
  patch inside a floating tag, and pulling alone would miss a whole
  version line going end-of-life. The Keycloak CVE needed both.

## Consequences

- `upgrade` now costs a registry round-trip per service image. Acceptable:
  it is explicit and occasional, and `--quiet` keeps the progress noise
  out of the spinner.
- `upgrade` modifies the `services:` block of a container yml. Visible in
  the log and the summary, and a builder who wants a specific tag can set
  it to a repository the catalog does not carry, or re-pin after the
  upgrade.
- A curated service that the catalog moves across a **major** version
  (`postgres:18` → `19`) now arrives through `upgrade` and can need a data
  migration. That is the same exposure the floating minor tags already
  carried; making it visible in the log and the summary is the mitigation,
  and a catalog major bump stays a deliberate, documented change.
- ADR 0018's list of what `upgrade` refreshes is extended, not replaced.

## Rejected

- **Resolving the image from the catalog at apply time instead of the
  yml.** Would fix delivery for everyone at once, and break
  reproducibility: the same yml would then materialize different
  containers depending on the installed CLI version. The yml is the source
  of truth (ADR 0002).
- **Re-pulling on every `apply`.** Defeats the cached-and-fast promise of
  routine `apply` and burns a registry round-trip per service on every
  run. This is exactly the trade ADR 0018 already settled for tools.
- **Matching by service name.** Simpler, and it silently skips every
  instance renamed with `--as` — including the identity provider in the
  workbench that motivated this ADR.
- **Failing the upgrade when a pull fails.** An offline laptop would then
  be unable to refresh its tools because a registry was unreachable. The
  cached image starting with a warning is the better failure.
