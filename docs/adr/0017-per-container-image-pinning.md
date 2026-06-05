# ADR 0017 — Per-Container Runtime-Image Pinning + Explicit Upgrade

- Status: accepted
- Date: 2026-06-05

## Context

The runtime base image is referenced as the floating major tag
`ghcr.io/getmonoceros/monoceros-runtime:1` (`DEFAULT_BASE_IMAGE` in
`create/catalog.ts`). It is **re-derived from the CLI default on every
`monoceros apply`** and written into the generated `devcontainer.json` /
`compose.yaml`. Two consequences:

- The actual base image an **existing** container runs can change over
  time — a routine `apply` (add a repo, tweak a port) re-emits the
  current default, and a fresh image pull behind the floating tag swaps
  the toolchain under a container that already holds real work. That is
  silent, non-reproducible drift — unacceptable for a production
  product.
- Nothing records which image a container was actually built with. Today
  `.monoceros/state.json` carries `origin`, `schemaVersion`,
  `monocerosCliVersion`, `materializedAt` — **not** the image. The yml
  has no base-image field at all.

This became concrete with ADR 0015 (IDE-state persistence): that feature
needs an image **capability** (the `~/.vscode-server` dirs pre-created
as `node`, shipped in runtime `1.1.0`). Emitting its volume mounts
against an older image breaks the container (root-owned volume → EACCES).
So the workbench must _know_ which image a container is pinned to and
never emit config the running image can't support.

Core product value (CLAUDE.md): the yml is the source of truth, the
container is derived, **reproducible across machines**.

## Decision

**1. Pin the runtime image version per container, in the yml.** `init`
writes the CLI's current runtime version as a top-level
`runtimeVersion: 1.1.0` — **version only**. The image name/registry is
a CLI constant (overridable for dev via `MONOCEROS_BASE_IMAGE_OVERRIDE`),
so the builder never types `monoceros-runtime:…`; all commands deal in
bare version numbers. Because the pin lives in the yml, it travels when
the yml is shared — same yml → same image on any machine.

**2. `apply` reuses the pinned version; it never bumps it.** Re-applying
an existing container for any reason keeps its pinned image. New
containers get the CLI's current default at `init` time and are pinned
from then on. **Exact versions only** — no floating major and no
npm-style ranges/placeholders; since upgrades are always manual (point
3), a range would serve no purpose and only re-introduce drift.

**3. Upgrading the base image is explicit and opt-in** — never a side
effect of routine `apply`. A dedicated command:

- `monoceros upgrade <name>` — pin to the **latest** published runtime
  version and re-apply.
- `monoceros upgrade <name> 1.1.0` — pin to a **specific** version
  (bare version number, not a full image ref) and re-apply.
- `monoceros upgrade --list` — list all available runtime versions (so
  the builder can choose one), changing nothing.

Hand-editing `runtimeVersion` in the yml + `apply` stays a valid manual
path.

**4. Features gate on the pinned image's capability.** The scaffold
emits image-version-dependent config (e.g. the ADR 0015 IDE volumes)
**only** when the pinned version supports it. A container below the
threshold simply doesn't get that config — no persistence, but no
breakage. The capability arrives on the next apply after an explicit
upgrade. Mechanism starts simple — a hardcoded minimum runtime version
per feature (compared against the pin). A richer capability map is
purely additive if it's ever needed; this choice locks nothing in.

**5. `state.json` records the resolved image** (audit: "this container
was last materialized against `monoceros-runtime:1.1.0`").

**6. No legacy / unpinned-fallback mode.** `init` always writes
`runtimeVersion`, so going forward every container is pinned. A
pre-pinning yml (no field) is transitional only: `apply` **errors with
a hint** ("no runtime pinned — run `monoceros upgrade <name> <version>`
or recreate the container") rather than silently adopting a default and
re-imaging. We do not maintain a floating runtime mode. The handful of
existing production containers are re-created or explicitly upgraded by
hand — accepted, since there are very few and the alternative (a
migration mechanism) is not worth building.

## Rationale

- **Reproducibility**: an existing container stays on the image it was
  built with; a teammate applying the same yml gets the same image.
- **No silent drift**: the base image only changes when the builder asks
  for it — the right contract for production work.
- **Safe feature rollout**: capability-gating means image-dependent
  features (0015 and future ones) can never break a container running an
  image that lacks the capability.
- **Migration is non-destructive**: legacy containers are untouched
  until explicitly upgraded.

## Consequences

- yml schema gains an optional runtime-image field; `init` populates it;
  `apply` reads it (floating-tag fallback when absent).
- A new explicit upgrade path (command or flag) is needed.
- The scaffold needs a capability check (pinned version vs a per-feature
  minimum), i.e. a small notion of "which runtime version provides
  what".
- `state.json` gains a resolved-image field.
- **`upgrade` (no version) and `--list` query the published runtime
  tags** in the registry (`ghcr.io/getmonoceros/monoceros-runtime`) to
  resolve "latest" / enumerate versions — a network call. Needs a
  sensible offline/failure behavior (e.g. error with a hint, and an
  explicit `<version>` always works without a lookup).
- **Security/patching tradeoff**: base-image-only fixes (e.g. a CVE in
  the base) no longer reach containers by passive re-pull — they require
  an explicit upgrade. This needs a visible "upgrade available" signal
  eventually so pinned containers don't silently rot. (Out of scope
  here; flagged.)
- ADR 0015's IDE volumes become conditional on the pinned version ≥ the
  version that ships the `~/.vscode-server` node-owned dirs.

## Rejected

- **Keep floating `:1`, re-derived every apply** — the status quo;
  silent, non-reproducible image drift under existing containers. The
  problem this ADR exists to fix.
- **Pin only in `state.json`, not the yml** — `state.json` is local
  materialization state and does not travel with the shared yml, so two
  machines applying the same yml would diverge. Breaks reproducibility.
- **Auto-upgrade the image on `apply`** — convenient, but defeats the
  whole point: the builder loses control over when their toolchain
  changes.

## Settled decisions (resolved with the maintainer)

- **yml field shape** → version-only, top-level `runtimeVersion: 1.1.0`;
  commands take bare version numbers (no full image ref). A private
  registry stays a future extension via the env override / an optional
  full-ref form.
- **Upgrade UX** → dedicated `monoceros upgrade <name>` (no version →
  latest, `<version>` → specific, `--list` → available versions).
- **Legacy fallback** → none. `init` always pins; a pre-pinning yml
  makes `apply` error with a hint. Few existing prod containers get
  recreated/upgraded by hand.
- **Pin granularity** → exact version only, no ranges.
- **Capability model** → start simple (hardcoded minimum runtime version
  per feature). Revisitable later; additive, locks nothing in.

## Follow-ups (not blocking acceptance)

- A visible "newer runtime available" signal so pinned containers don't
  silently rot (the security/patching tradeoff above).
- Optional full-ref / private-registry form of `runtimeVersion` if an
  enterprise needs a mirrored runtime image.
