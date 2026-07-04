# ADR 0008 - Docker in the container as an opt-in feature (DinD, with eyes open)

- Status: proposed
- Date: 2026-05-26
- Updated: 2026-06-26 (risk section expanded, DooD comparison made honest, paths corrected to the `components/` layout)

## TL;DR (read this first)

Running Docker inside the Monoceros container is possible, but it is
expensive and, on the security axis, in **direct tension with the
project's central isolation bet**. Both available mechanisms -
Docker-in-Docker (DinD) and Docker-outside-of-Docker (DooD) - end at
"host-root-equivalent". There is no safe variant.

If we ship anything, it is strictly opt-in, visibly marked as
privileged, and gated behind a "do you actually need this?" reflex
check that points at `services:` first.

We choose **DinD over DooD** - not because DinD is clean (it is not),
but because DooD breaks two things Monoceros sells as guarantees
(atomic lifecycle, reproducible mounts), while DinD's costs are mostly
performance, disk, and an always-privileged container. The decision is
spelled out below so it is clearly a trade-off we reasoned through, not
a preference.

## Context

Some projects use Docker at development time - the typical case is an
`npm run dev` (or `make dev`, etc.) that calls `docker compose up
--build` or `docker build` in the background to build an app image or
start an app container. On the host this is unremarkable: the host's
Docker daemon does the building.

In Monoceros it is not. The builder works **inside** the Monoceros
container, which is itself a Docker container. By default that
container has no Docker daemon, no `docker` CLI, and no access to the
host socket. A `docker build` inside it fails. For builders whose dev
loop needs Docker, Monoceros is unusable today.

Three observations before deciding:

1. **The most common "local dev with Docker" case is already solved.**
   Postgres, Redis, MySQL, Keycloak via `docker-compose.yml` alongside
   the app is mainstream, and that is exactly what Monoceros already
   covers with `services:` in the container yml, more cleanly (yml
   schema, backups, atomic `remove`). The genuinely open case is
   narrower: the builder wants to **build images or start containers
   themselves** in the dev loop.
2. **Container isolation is a central Monoceros bet** (concept.md,
   "Container isolation as default"). Any mechanism that gives the
   container Docker control undermines this bet, because Docker control
   is equivalent to host root.
3. **Devcontainers have two established solutions.**
   `ghcr.io/devcontainers/features/docker-outside-of-docker` (DooD -
   host socket mount) and
   `ghcr.io/devcontainers/features/docker-in-docker` (DinD - daemon in
   the container, privileged). Both are mature; we do not have to
   invent the mechanism. The only questions are which one and how we
   embed it.

## The central tension (state it plainly)

Any mechanism that lets the dev loop drive Docker punctures the
isolation bet, because Docker control is host root. This holds for
**both** options and cannot be engineered away:

- **DinD** runs the inner daemon in a `--privileged` container.
  Privileged is not "a permission": it disables seccomp and AppArmor,
  grants all capabilities, and exposes host devices. The container is
  host-root-equivalent **at all times**, whether or not anyone runs a
  single `docker` command. A remote-code-execution bug in any dev-loop
  dependency is, from that moment, host root.
- **DooD** mounts the host's Docker socket into an otherwise
  **unprivileged** container. The container itself is not privileged;
  the escape requires reaching the socket. But anyone who can reach it
  can `docker run -v /:/host` and own the host.

So neither is "the secure one". The honest difference on the security
axis is subtle and, notably, slightly in DooD's favour: DooD's
container is unprivileged and the blast radius is gated behind socket
access, whereas DinD's container is unconditionally privileged. We pick
DinD anyway. The next section says why, and it is **not** a security
argument.

## Decision

Ship Docker support as an opt-in feature
`ghcr.io/getmonoceros/monoceros-features/docker-in-docker:1`, **DinD,
not DooD**. Steer toward `services:` first in the docs. Mark the
feature as privileged in the catalog so it never reads as an ordinary
tool.

### Why DinD wins despite a worse security profile

The decision turns on which failure modes each option forces onto
Monoceros's identity. Monoceros sells four things: local,
declarative/reproducible, atomic lifecycle, isolated. Both options
damage "isolated" (above), so that axis is a wash. The tiebreaker is
the other three, and there DooD fails hard:

| Dimension                          | DooD (host socket)                                                           | DinD (privileged inner daemon)                                 |
| ---------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Security worst case                | host root via socket, **gated** behind socket access; container unprivileged | host root, **unconditional**; container is `--privileged` 24/7 |
| `monoceros remove` atomicity       | broken: inner containers are host siblings, left as zombies                  | intact: inner containers die with the parent                   |
| `volumes: [.:/app]` in project yml | silently broken: `.` is `/workspaces/<name>`, unknown to host daemon         | works unchanged                                                |
| Host pollution                     | inner images/containers land in the host daemon                              | none: fully contained in the parent                            |
| Build performance                  | native                                                                       | slower: overlay-on-overlay, or `vfs` fallback (see risks)      |
| Image cache                        | shared with host, survives                                                   | per-container, **lost on every `apply`** (see risks)           |
| Disk footprint                     | shared, host `prune` reclaims it                                             | per-container, invisible to host `prune`, accumulates          |
| Traefik routing (ADR 0007)         | inner container is a host sibling, needs wiring into the proxy net           | inner ports publish to the parent, parent already routed       |

The two DooD rows that decide it:

- **Zombie containers break `remove`.** Inner containers are host
  siblings, so `monoceros remove` - built to be atomic - cannot see or
  clean them. We hit exactly this in M4 Task 9 (Linux walkthrough): an
  image-mode container left a zombie behind after `remove`, which is
  why the fourth container filter over
  `label=devcontainer.local_folder=…` exists at all. DooD reopens that
  wound deliberately.
- **The volume-mount footgun silently runs the wrong code.**
  `volumes: [.:/app]` is standard. Inside the container `.` is
  `/workspaces/<name>`, a path the host daemon does not know, so it
  mounts an empty dir and the dev server boots without the code. Not
  hypothetical: it is the first bug report.

Both are **correctness** failures, and both contradict guarantees
Monoceros makes by name (atomic `remove`, reproducible runs). DinD's
costs, by contrast, are **performance, disk, and an always-privileged
container**: serious, but they do not make the tool silently do the
wrong thing. For a product whose pitch is "reproducible and clean", a
loud opt-in security cost beats a quiet correctness footgun.

That is the whole argument. If a future builder's threat model cannot
tolerate an always-privileged container, the right answer for them is
not DooD, it is "do not run Docker in the container at all": use
`services:`.

## Known costs and risks of DinD (do not paper over these)

These are the real, in-practice problems. The docs page and the
feature `usageNotes` must surface them, not bury them.

1. **Always-privileged container.** The big one, restated: opting into
   this feature makes the whole dev container host-root-equivalent for
   its entire lifetime. This is the single largest deviation from the
   isolation bet in the entire product.
2. **Image cache does not survive `apply`.** `apply` rebuilds the
   container. The inner image store lives at `/var/lib/docker`
   (root-owned, outside `$HOME`), so `persistentHomePaths` cannot reach
   it - it only persists `.docker` (registry auth, not images). Every
   `apply` therefore starts the inner cache from zero: a real
   performance cliff. Persisting the inner store needs a dedicated
   named volume and carries its own corruption risk on storage-driver
   changes (deferred, see below).
3. **overlay-on-overlay may degrade to `vfs`.** Nested overlayfs is not
   merely slower; on some host filesystems the inner daemon falls back
   to the `vfs` storage driver, which copies every layer in full -
   pathologically slow and disk-hungry. Docker Desktop's
   VirtioFS-backed storage can break the inner daemon's storage
   outright.
4. **Disk bloat with no shared GC.** The inner cache is per-container
   and invisible to `docker system prune` on the host. Each container
   hoards its own images; nothing reclaims them but removing the
   container.
5. **Inner daemon lifecycle.** `dockerd` is a background daemon that
   must come up reliably on every container **start**, not just create,
   and before the dev loop races it. This is an init/ordering concern
   the feature install has to get right.
6. **Host-dependent behaviour.** DinD depends on cgroup v2 delegation
   and kernel specifics; it behaves differently across Docker Desktop,
   native Linux, WSL2, and colima. WSL2 in particular is fragile.
7. **Traefik is not "trivial".** ADR 0007 routing works only if the
   builder publishes the inner port into the Monoceros container (inner
   `docker run -p` / compose port mapping) **and** matches it to
   `routing.ports:`. An inner compose network with its own bridge is
   unreachable until ports are published to the parent. The docs must
   show this explicitly; it is a footgun, not a freebie.

## Documentation strategy (an active part of the decision)

The security implication must not vanish into boilerplate. Three
layers:

1. **`x-monoceros.usageNotes` in the manifest** - mirrored into the
   generated yml as a comment on `init --with-features=docker-in-docker`.
   Content: the `services:` reflex check, plus one blunt sentence on the
   always-privileged consequence.
2. **A docs page on getmonoceros.build** (reference/config or
   features), laid out as: "do you need this?" with a `services:`
   example first; then the costs/risks above; only then technical
   usage. Per the repo conventions, command and feature docs live on
   the website, not in a `docs/` tree here.
3. **Catalog marker in `monoceros list-components`** - a visible
   "privileged" warning so the feature never reads as an ordinary tool.

## Scope of the feature

- The install wraps upstream
  `ghcr.io/devcontainers/features/docker-in-docker` rather than
  reimplementing daemon setup.
- Option `version: 'latest' | <docker-version>` (default `latest`).
- Option `installDockerComposePlugin: boolean` (default `true`).
- `x-monoceros.persistentHomePaths: [.docker]` so registry-auth login
  survives `apply`. **Note the limitation:** this persists auth, not
  the image cache (risk 2).
- **Privileged is set by the scaffold, never by the builder.** When the
  feature is present in `features:`, the scaffold marks the container
  privileged in **both** code paths:
  - image mode: add `--privileged` to `runArgs` (today the array lives
    in `packages/cli/src/create/scaffold.ts`), and
  - compose mode: set `privileged: true` on the `workspace` service
    (generated in `packages/cli/src/devcontainer/compose.ts`).

  The builder must not be able to set `privileged` anywhere in the yml.

## Networking with Traefik

Inner containers live in the inner daemon and are invisible to the host
and the `monoceros-proxy` network. Traefik already routes to the
Monoceros container, which forwards internally to the inner container.
The builder declares the dev-server port in `routing.ports:` as usual
**and** must ensure, inside the container, that the inner container
publishes that port to the parent (inner `docker run -p 3000:3000` or
compose port mapping). From Traefik's side nothing changes. See risk 7:
this hand-off is the builder's job and must be documented, not assumed.

## Deliberately deferred

### Shipping DooD as a second curated option

Rejected. DooD's security profile is actually slightly better
(unprivileged container), but its **zombies** and **broken volume
mounts** are exactly the correctness footguns Monoceros stands against,
and a curated DooD variant with our name on it signals a recommendation
we do not mean. A builder who genuinely needs DooD can already pull the
raw upstream devcontainer feature via `add-from-url` today; that escape
hatch exists and is enough. We document the trade-off so the choice is
informed, not hidden.

### Persisting the inner image store across `apply`

The fix for risk 2 would be a dedicated named volume for
`/var/lib/docker`. Deferred: it adds lifecycle surface (the volume must
be created, attributed, and torn down with `remove` to keep that
atomic) and risks corruption when the storage driver changes between
runtime versions. Revisit once the feature is stable and the cache
cliff is shown to hurt in practice.

### Rootless Docker / Podman in the container

Would avoid the privileged cost in theory. Not mature enough:
Podman-in-Docker hits user-namespace conflicts, rootless Docker has
overlay-on-overlay performance problems. Re-evaluate when upstream
settles.

### Auto-detecting a repo `Dockerfile` / `docker-compose.yml`

Tempting, rejected for the first iteration: it would imply every
Docker-using dev loop needs DinD, which is false (the `services:`
path). Stabilize the feature first.

## Consequences

- **New feature** under `components/features/docker-in-docker/`:
  `component.yml` + `devcontainer-feature.json` + `install.sh` (wrapper
  over upstream DinD), with `x-monoceros.usageNotes`,
  `x-monoceros.optionHints`,
  `x-monoceros.persistentHomePaths: [.docker]`, and a catalog warning
  marker. (`catalog.json` regenerates from the component tree; it is
  not hand-edited.)
- **Scaffold change in two paths** - image-mode `runArgs` and
  compose-mode `workspace` service - to set privileged automatically
  when the feature is present, and only then. The builder cannot set
  it.
- **Docs** on getmonoceros.build: the "do you need this?" page plus
  catalog/reference cross-links.
- **e2e smoke stage**:
  `init --with-languages=node --with-features=docker-in-docker` →
  `apply` → inner `docker build` → inner `docker run` →
  `monoceros remove` leaves no zombie in the host `docker ps`.
- **GHCR release** via the existing `release-features.yml` pipeline on a
  feature version bump; no workflow change.

## Status reference

Still `proposed` and unimplemented. Sequence it as its own small item:
the always-privileged consequence means it should not slip in quietly
alongside unrelated work - it deserves its own review and its own docs
pass.
