# ADR 0007 — Port management via a Traefik singleton with hostname routing

- Status: accepted
- Date: 2026-05-24
- Updated: 2026-05-24 — Schema structure refined during
  implementation. The container-yml fields `ports:` (flat) and
  `ide.vscodeAutoForwardPorts` were consolidated into a single
  `routing:` block (`routing.ports`, `routing.vscodeAutoForward`).
  New in `monoceros-config.yml`: `routing.hostPort` (default 80,
  configurable when port 80 is permanently occupied). Hostname
  routing, lifecycle, and everything else unchanged.

## Context

Today `monoceros apply` generates a `devcontainer.json` in which
declared ports end up under `forwardPorts`. This only works when the
container is opened via the VS Code Devcontainers extension — VS Code
parses `forwardPorts` and sets up port forwards on its own. **When the
same container is started with the bare `@devcontainers/cli` (without
VS Code) — the path Monoceros takes — `forwardPorts` is ignored.**
Consequence: apps in the container are unreachable from the host
browser, in both image mode and compose mode.

For M5 Task 2 we need a solution that:

1. works without VS Code (the builder may only have `monoceros shell`
   - Claude Code in the terminal)
2. takes effect **on the fly** — no container restart, no `apply`
   rebuild when the builder wants to open another port
3. is **persisted in the container yml** — later `apply` runs restore
   the ports automatically
4. works with multiple running dev containers in parallel, without
   them fighting over host ports

Three obvious alternatives were rejected:

- **Writing `-p` mappings per container into the generated compose
  yaml / devcontainer.json**: requires a rebuild for each new port
  (violates #2), and N containers with the same internal port (e.g.
  two Vite apps on 5173) collide on the host (violates #4).
- **One reverse proxy per container**: each proxy occupies a host
  port → the same collision problem, just one layer up; plus N proxy
  images in RAM.
- **Local DNS setup via `hosts`-file manipulation**: needs root, is
  OS-specific, hard to reverse — not acceptable for a tool that bills
  itself as "your Docker, your data, no magic."

## Decision

**A single Traefik container Docker-wide, hostname routing over
`*.localhost`, hot reload via the file provider, lifecycle coupled to
the dev-container lifecycles.**

### Topology

- Docker network `monoceros-proxy` (external, managed by Monoceros).
  All dev containers that declare ports join it in addition to their
  own compose network.
- Singleton container `monoceros-proxy` (image `traefik:v3`), binds
  host port 80, listens on the `monoceros-proxy` network.
- Dynamic route configs under `$MONOCEROS_HOME/traefik/dynamic/
<container>.yml`. Traefik's file provider picks up changes within
  ~100 ms without a restart.

### Hostname scheme (RFC 6761 `*.localhost`)

- `<container>.localhost` → the container's default port (first entry
  in `ports:`)
- `<container>-<port>.localhost` → explicit internal port

Example: container `api` with `ports: [3000, 9229]`:

- `api.localhost` → `http://api:3000` (default)
- `api-3000.localhost` → `http://api:3000` (explicit)
- `api-9229.localhost` → `http://api:9229` (debug port)

Occupied host port: only 80 (Traefik entrypoint `web`). Multiple
containers in parallel are collision-free, because Traefik routes via
the HTTP Host header, not via port mapping.

### Lifecycle

Traefik is not permanent — it starts automatically when needed and
stops when nobody needs it anymore. No `--restart` policy, no
background daemon. Controlled through deterministic CLI commands:

- `monoceros apply <name>` with `ports:` in the yml → `ensureProxy()`
  before `devcontainer up`
- `monoceros start <name>` with `ports:` in the yml → `ensureProxy()`
  before the start
- `monoceros add-port <name> <port>` → `ensureProxy()` if the
  container is running + write the hot-reload file
- `monoceros stop <name>` / `remove <name>` → `maybeStopProxy()`:
  if no other dev container with ports is running, stop Traefik and
  tear down the network

`stop` and `remove` are treated the same (variant A from the
2026-05-24 discussion): the only criterion is "is a port container
still running in the `monoceros-proxy` network." Variant B (stop keeps
Traefik alive) would be 1–2 seconds faster on the next `start`, but
creates inconsistencies (why is Traefik alive when nothing is
running?).

`ensureProxy()` is idempotent — if the singleton is already running,
it's a no-op. The first call after a host reboot pays ~1 s for a
pull-cache check + start; later calls are no-ops.

### Persistence in the container yml

New fields in the container-yml schema:

```yaml
ports:
  - 3000 # short form
  - port: 9229 # long form, optional alias/path-prefix later
ide:
  vscodeAutoForwardPorts: false # default: false
```

`vscodeAutoForwardPorts` ends up as `"remote.autoForwardPorts": false`
in `customizations.vscode.settings`. Default `false`, because Traefik
should be the single source of truth for external reachability —
otherwise the builder gets two URLs for the same app
(`localhost:NNNNN` from VS Code + `<name>.localhost` from Traefik) and
has to remember which one is reliable. Reversible per container, if
the builder explicitly wants the VS Code forwards.

### Discovery

`monoceros port <name>` lists the container's current URLs, so the
builder doesn't have to construct the subdomain pattern themselves.
Without args: all ports of the named container. With the `--all` flag:
all container URLs at a glance.

### `add-port` / `remove-port`

- `monoceros add-port <name> <port> [<port>…]` — idempotent, writes
  to the container yml (comment-preserving via the existing AST
  mutator), writes the Traefik dynamic config in parallel (if the
  container is running), and prints the resulting URL(s).
- `monoceros remove-port <name> <port> [<port>…]` — the mirror image,
  removes the yml entry and dynamic-config block, calls
  `maybeStopProxy()` when the last port is gone.

Both follow the established `add-*` / `remove-*` pattern (diff
preview, `--yes` flag, idempotent).

## Deliberately deferred

### TLS / HTTPS

HTTP-only for now. Rationale:

- `*.localhost` is whitelisted as "potentially trustworthy" in the
  browser → service workers, `crypto.subtle`, etc. work even without
  TLS
- Real HTTPS would require installing an mkcert CA into the host's
  system trust store (macOS Keychain / Linux ca-certificates /
  Windows Cert Store — three paths, all with elevated permissions)
- The Traefik config is written so that `entryPoints: [web]` is
  explicitly declared — additively adding a `websecure` entrypoint +
  a `tls:` block per route is possible later without schema breaks

Re-evaluate when a builder names a concrete workflow that requires an
HTTPS origin (Vite HTTPS plugins, OAuth callbacks with a fixed
`https://` redirect, PWA installation on a custom host).

### TCP tunnel for services

Hostname routing only works over HTTP. Direct host access to TCP
services (Postgres client, Redis CLI) is explicitly **not** in scope
for this ADR — see **M5 Task 3 (`monoceros tunnel`)** for the sibling
solution via a socat sidecar container.

### Migration of existing containers

There is no auto-migration for containers materialized before M5
Task 2. Monoceros is in active development; the documented migration
path is `monoceros remove <name>` → `monoceros apply <name>`. The
README gets a corresponding status banner ("pre-1.x, breaking changes
possible without notice"), so this doesn't come as a surprise.

## Consequences

- **New yml schema** (`config/schema.ts`): `ports: (number | { port:
number; … })[]` and `ide.vscodeAutoForwardPorts: boolean`. Zod
  validation + comment-preserving write path.
- **New module block** `proxy/` in the CLI package: `ensureProxy()`,
  `maybeStopProxy()`, `writeDynamicConfig(name, ports)`,
  `removeDynamicConfig(name)`, `joinProxyNetwork(containerId)`,
  `listenersFor(name)`.
- **Scaffold extension** (`create/scaffold.ts` / compose generator):
  when `ports:` is non-empty, join `monoceros-proxy` as an external
  network in the generated compose.yaml, or
  `runArgs: ["--network", "monoceros-proxy"]` in image mode.
- **New CLI commands**: `add-port`, `remove-port`, `port`.
- **Docs**: `docs/commands/{add-port,remove-port,port}.md` plus an
  overview update in `docs/commands/README.md`.
- **Test-plan update** (M5 Task 4): the port path as a mandatory
  case — `add-port` + browser test via `<container>.localhost`, plus
  lifecycle tests (Traefik starts on the first port container, stops
  on the last).
- **README**: status banner "pre-1.x, breaking changes possible
  without notice" as a visible block at the top.

## Open mini-question for the implementation

The `monoceros-proxy` container bind-mounts the dynamic configs from
`$MONOCEROS_HOME/traefik/dynamic/` — this path must exist at the time
of `docker run`, otherwise Docker creates it as root-owned and the
subsequent file writes by the user fail. `ensureProxy()` creates the
directory explicitly as user-owned before the start. A trivial
detail, documented here only so it isn't forgotten in the code.
