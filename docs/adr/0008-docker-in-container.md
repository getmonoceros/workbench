# ADR 0008 — Docker-in-Container as an opt-in feature

- Status: proposed
- Date: 2026-05-26

## Context

Some projects use Docker at development time — the typical case is an
`npm run dev` (or a `make dev`, etc.) that calls `docker compose up --build`
or `docker build` in the background and builds an app image or starts an
app container. As long as the builder works directly on their host, this
is unremarkable: the host's Docker daemon does the building.

In Monoceros this is not the case. The builder works **inside** the
Monoceros container, which is itself a Docker container. In the default
setup, the Monoceros container has neither a Docker daemon nor a `docker`
CLI nor access to the host socket. A `docker build` inside the container
fails. For the share of builders whose dev loop needs Docker, Monoceros is
therefore unusable today.

Three observations about the context before we decide:

1. **The most common "local dev with Docker" case is already solved.**
   Postgres, Redis, MySQL, RabbitMQ, etc. via `docker-compose.yml`
   alongside the app is mainstream — but that is exactly what Monoceros
   already covers with `services:` in the container yml, even more
   cleanly (yml schema, backups, atomic `remove`). The case that is
   genuinely open under the heading "Docker in dev" is the narrower one:
   the builder wants to **build images or start containers themselves**
   in the dev loop.
2. **Container isolation is a central Monoceros bet** (see concept.md,
   "Container isolation as default"). Any mechanism that gives the
   container access to Docker undermines this bet, because in practice
   Docker daemon access is equivalent to host root.
3. **Devcontainers have two established solutions for the problem.**
   `ghcr.io/devcontainers/features/docker-outside-of-docker` (DooD —
   host socket mount) and `ghcr.io/devcontainers/features/docker-in-docker`
   (DinD — daemon in the container, privileged). Both are mature; we
   don't have to invent the mechanism ourselves — the only question is
   which one, and how we embed it in Monoceros.

## Decision

**We ship Docker support as an opt-in feature
`ghcr.io/getmonoceros/monoceros-features/docker-in-docker:1`. We
choose DinD (not DooD). In the docs we actively steer toward `services:`
first, before explaining the feature's consequences.**

### Why DinD and not DooD

Both break container isolation; that is common to both and unavoidable —
as soon as the dev loop is allowed to run Docker operations, there is a
path to host compromise. The question is which of the two breaks has the
smaller operational follow-up cost.

| Consequence                    | DooD (host socket)                   | DinD (daemon in container)             |
| ------------------------------ | ------------------------------------ | -------------------------------------- |
| Lifecycle: `remove` cleans up  | no, sub-containers are siblings      | yes, sub-containers are children       |
| Volume mount `$(pwd):/app`     | broken (host path doesn't exist)     | works without workaround               |
| Image cache shared with host   | yes                                  | no, one per container                  |
| Build performance              | native                               | noticeably slower (overlay-on-overlay) |
| Traefik integration (ADR 0007) | complex (sub-container in proxy net) | trivial (goes through parent)          |
| Security break                 | socket → host root                   | privileged → host root                 |

DooD is faster and cheaper on disk space; DinD is cleaner in its model.
The two points that tip the balance:

- **Zombie containers after `remove`** (DooD): sub-containers are
  siblings, not children — `monoceros remove` knows nothing about them,
  so they're left behind. We confirmed this exact problem in M4 Task 9
  (Linux walkthrough) as a serious UX finding, when an image-mode
  container left a zombie behind after `remove`; the fourth container
  filter over `label=devcontainer.local_folder=…` exists precisely to
  make `remove` _atomic_. DooD would deliberately reopen this path.
- **Volume-mount footgun** (DooD): a `docker-compose.yml` with
  `volumes: [.:/app]` is standard. Inside the Monoceros container, `.`
  expands to `/workspaces/<name>`, a path the host doesn't know. The
  host daemon mounts an empty folder, the dev server starts without
  code. This isn't abstract — it's the first bug report we'd get.

DinD costs us speed and disk space, but gives us an atomic lifecycle and
working mounts without changing the project compose file. That outweighs
the rest in the overall balance.

### Documentation strategy as an active part of the decision

The security implication must not disappear among boilerplate warnings.
Three layers:

1. **`x-monoceros.usageNotes` in the feature manifest** — mirrored into
   the generated yml as a comment on `init --with=docker-in-docker`
   (this mechanism has existed since M4). Content: a reflex check of
   whether `services:` suffices, plus one sentence on the privileged
   consequence.
2. **`docs/features/docker-in-docker.md`** — a structured detail page
   laid out as: first the question "do you need this?" with a
   `services:` example as the alternative; then the consequences
   (privileged, performance, disk); only then the technical usage.
3. **Manifest hint in `monoceros list-components`** — the feature gets a
   visible marker in the component list (e.g. "⚠ privileged"), so it
   doesn't accidentally look like a normal tool.

### Scope of the feature

- The installer wraps the upstream
  `ghcr.io/devcontainers/features/docker-in-docker` or its install
  script, rather than maintaining our own daemon-setup mechanism.
- Option `version: 'latest' | <docker-version>` analogous to other
  features (default `latest`).
- Option `installDockerComposePlugin: boolean` (default `true`), so that
  `docker compose` works directly.
- State under `home/.docker/` via `x-monoceros.persistentHomePaths`, so
  that login state (registry auth) survives across `apply`.
- On the container-yml side, the container is automatically marked as
  `privileged: true` when this feature is set. This happens in the
  scaffold, not in the builder yml — the builder must not be able to set
  `privileged: true` accidentally somewhere else.

### Networking with Traefik

Sub-containers live inside the inner Docker of the Monoceros container
and are invisible to the host and to the `monoceros-proxy` network. This
is not a problem: Traefik already routes to the Monoceros container
today, which in turn forwards internally to the sub-container — the
builder declares their dev server port as usual in `routing.ports:`, and
ensures _inside the container_ that the sub-container listens on that
port (e.g. via `docker run -p 3000:3000` in the inner daemon, or compose
port mapping). From Traefik's point of view, nothing changes.

## Deliberately not decided / deferred

### Shipping DooD as a second option

The obvious reflex: offer both features and let the builder choose.
Rejected, because the DooD consequences (zombies, broken volume mounts)
are exactly the kind of footgun Monoceros otherwise stands against. If a
builder really needs DooD, they can already pull in a raw devcontainer
feature ref via `add-from-url` today — that path exists. A curated DooD
variant with our name on it, by contrast, signals that we recommend it.
We don't.

### Rootless Docker / Podman in the container

Interesting in theory — rootless Docker or Podman in the container would
avoid the privileged cost. Not mature enough in practice today:
Podman-in-Docker regularly runs into user-namespace conflicts, and
rootless Docker has performance problems with overlayfs on overlayfs.
Re-evaluate when the upstream situation settles down.

### Auto-detection of existing `Dockerfile`/`docker-compose.yml` in the repo

Tempting: `monoceros init --with-repo=…` sees a `Dockerfile` and
suggests the feature. Rejected for the first iteration — it would
suggest that every dev loop with a Docker file also needs DinD, which
isn't true (see the `services:` path). Stabilize the feature first, then
maybe a detection heuristic.

## Consequences

- **New feature** under `images/features/docker-in-docker/` with
  `devcontainer-feature.json` + `install.sh` (wrapper over the upstream
  DinD feature), `x-monoceros.usageNotes`, `x-monoceros.optionHints`,
  `x-monoceros.persistentHomePaths: [.docker]`.
- **Scaffold extension** — when the feature is included in `features:`
  of the yml, the scaffold adds `privileged: true` to the generated
  devcontainer.json or the corresponding service block in the compose.
  The builder cannot set this themselves.
- **Component** under `templates/components/docker-in-docker.yaml` with
  `displayName` + `description` + `category: tooling` plus a warning
  marker, so that `init --with=docker-in-docker` and `list-components`
  display the feature consistently.
- **Docs** — `docs/features/docker-in-docker.md` (new, focused on the
  "do you need this?" reflex check) and a reference from
  `docs/ai-tools.md` or the component catalog.
- **Test plan** (M5 Task 4 rewrite) — a stage for "init
  `--with=node,docker-in-docker` → apply → `docker build` in the
  container → `docker run` in the container → `monoceros remove` cleans
  everything up, no zombie in the host `docker ps`".
- **GHCR release** — via the existing `release-features.yml` pipeline
  (M4 Task 3), no workflow change needed.

## Status reference

The implementation does not belong in M5 (the test plan + AI library
extension are already a lot there) — but as its own small item after M5,
in parallel with or following "Extend the AI tool library". Backlog
entry under "Earmarked for later (beyond M5)".
