# ADR 0018 — Tool Freshness Model: cached `apply`, `upgrade` refreshes + prunes, staleness nudge

- Status: accepted
- Date: 2026-06-10

## Context

ADR 0017 pinned the runtime **base image** per container and made base
upgrades explicit (`monoceros upgrade`). It deliberately left one thing
open, quoting its own Consequences:

> base-image-only fixes … no longer reach containers by passive re-pull
> — they require an explicit upgrade. This needs a visible "upgrade
> available" signal eventually so pinned containers don't silently rot.
> (Out of scope here; flagged.)

Beyond the base, there is a second, sharper problem 0017 did not touch:
**feature-installed tools go stale and there is no way to refresh them.**

- Features install their tools at **build time**: `gh` via the
  cli.github.com apt repo, `claude` via `npm install -g`, the Atlassian
  CLIs via `curl`. Each lands in a **cached image layer**.
- Docker's layer cache is **machine-global** and keyed by the install
  _instruction_, not the resolved tool version. So `npm install -g
…@latest` is resolved **once** — when the layer is first built — and
  then frozen. Every later `apply`, and every _new_ container with the
  same feature+options, reuses that frozen layer (`--remove-existing-
container` recreates the container, not the image; there is no
  `--build-no-cache`).
- Consequence: tools silently rot. A year-old `gh` means CVEs,
  deprecated/removed API endpoints, broken auth flows. For `claude`
  there is also a perpetual "update available" nag, because it is
  installed **as root** into the root-owned npm prefix and the non-root
  runtime user can never self-update it ("no write permission to npm
  prefix").

Using devcontainer **features** does not help here: on the freshness
axis a feature is no better than a raw `apt-get` — both bake into a
cached layer. (Features are chosen for composition, ecosystem reuse,
devcontainer-standard interop, and the `x-monoceros` metadata they
carry — not for freshness.)

The product is **local** and frequently runs on a laptop that is asleep
or off. Cloud-style scheduled prebuilds (always-on infrastructure
rebuilding images nightly) are therefore unreliable here: the "nightly"
job often simply never fires. Freshness must be an **explicit, fast,
safe** action plus **visibility** — not a background assumption.

## Decision

**1. `apply` always uses the current cached image.** It never
force-refreshes tools or the base. Fast and predictable — consistent
with ADR 0017 ("apply reuses the pin; it never bumps it").

**2. `upgrade` is the single freshness action.** It:

- **(a) Refreshes feature tools** by rebuilding their layers with the
  cache busted, so the install scripts re-pull latest. Features are
  **not** version-gated — there is no per-tool version pin; freshness
  comes from the rebuild. (Cloud-coupled CLIs can't be meaningfully
  pinned anyway.)
- **(b) Updates the runtime base only when a newer version exists** —
  the version-checked pull from ADR 0017. `upgrade <name> <version>`
  still pins a specific base.
- **(c) Prunes old, unused images — strictly Monoceros-owned ones**
  (old runtime versions no longer pinned by any container; dangling
  build layers left by the rebuild). It **never** touches images
  Monoceros did not create. Scoped via a Monoceros label/tag, not a
  blanket `docker image prune`.
- **(d) Records the timestamp of its last successful run** in
  machine-global Monoceros state.

**3. `apply` reads that timestamp and prints a non-blocking nudge** when
the last successful `upgrade` is older than a threshold (default ~30
days, configurable in `monoceros-config.yml`): _"Tools last refreshed N
days ago — run `monoceros upgrade` to update."_ This is the visible
"don't silently rot" signal ADR 0017 flagged.

**4. Scope: global.** `upgrade` with no name refreshes everything in use
across all containers (the union of features + each container's base) +
prune + one machine-global timestamp. `upgrade <name>` (ADR 0017) stays
for targeting a single container and also updates the global timestamp.
Rationale: the Docker cache, the prune, and "when did I last refresh"
are inherently machine-level; rebuilding a feature layer once benefits
every container that uses it.

**5. Self-updating tools stay current between upgrades on their own.**
Specifically, `claude` is installed as the non-root `node` user into the
node-owned npm prefix (`/usr/local/share/npm-global`), so its runtime
self-updater works. Today it is installed as root → cannot self-update →
perpetual nag. `upgrade` is the floor for _all_ tools; self-update is a
bonus layer for the ones that support it.

## Rationale

- **Correctness independent of machine uptime.** Freshness is an action
  you can always run, not a background job that may never fire on a
  sleeping laptop.
- **Completes ADR 0017's flagged gap** (the staleness signal).
- **Honest about the limit.** For non-self-updating tools, "current" =
  "as of the last `upgrade`". We make upgrading trivial, **safe**
  (auth, workspace, and service data persist via bind mounts, so an
  upgrade never loses work), and **visible**. We do not pretend caching
  delivers freshness.
- **Base stays pinnable / reproducible** (ADR 0017); only feature tools
  float, because cloud CLIs can't be pinned in any useful way.

## Consequences

- `upgrade` gains: a cache-busting feature-layer rebuild, a scoped image
  prune, and a global timestamp write — a real rebuild, with real
  network and time cost (acceptable: it is explicit and occasional).
- A new machine-global state record (the timestamp). `apply` reads it
  (cheap, local).
- The prune is **destructive** → it must be tightly scoped to
  Monoceros-owned images via a label/tag and well tested. (Aligns with
  the standing rule against blanket destructive operations.)
- The `claude-code` feature changes to install **as `node`** (which also
  unblocks self-update); the feature is republished.
- "`apply` = cached" means a brand-new container can start from a stale
  shared-cache layer; the nudge + `upgrade` are the remedy. We do **not**
  special-case first-apply (it would slow every new container and still
  need `upgrade` for ongoing freshness).

## Rejected

- **Background prebuild daemon (nightly cache warming).** The right
  north-star — it is local Codespaces "prebuilds" — but a substantial
  subsystem (scheduler, in-use registry, disk + prune policy, Docker
  socket / privilege) and unreliable on a laptop that sleeps. Deferred
  to its own epic; the explicit-`upgrade` model is the foundation it
  would later sit on.
- **First-`apply`-always-`--build-no-cache`.** Makes every new
  container's first build slow and still needs `upgrade` for ongoing
  freshness; the staleness nudge covers visibility far more cheaply.
- **Auto-refresh on routine `apply` / a fixed cadence.** Defeats
  predictability and burns time on every apply.

## Settled decisions (resolved with the maintainer)

- **Scope of `upgrade`** → **global** (point 4): one machine-global
  timestamp; `upgrade <name>` retained for targeting a single container.
- **Staleness threshold** → **30 days** default, overridable in
  `monoceros-config.yml`.

## Related

- ADR 0017 (per-container image pinning + explicit upgrade) — this ADR
  extends its `upgrade` command and closes its flagged staleness gap.
- The `claude-code` permission-mode default (`bypassPermissions`) is a
  separate, smaller change tracked in the backlog, not part of this
  freshness decision.
