# `monoceros tunnel`

Opens a **TCP tunnel** from the host into the container — for DB clients,
ad-hoc port forwards, or tooling that needs to reach a container-internal
port from the host. Foreground process: Ctrl+C stops the tunnel.

```sh
monoceros tunnel <name> <service-or-port> [--local-port=<n>] [--local-address=<addr>]
```

## Purpose

[`add-port`](./add-port.md) + Traefik cover **HTTP routing** via
`<name>.localhost` — that's the persistent solution for web apps.
For anything **TCP-based** (Postgres, MySQL, Redis, arbitrary
server sockets), you need a different mechanism, because Traefik is
HTTP-only and a `psql -h localhost -p 5432` has to hit the service
port directly.

`tunnel` is the situational bridge: ad-hoc, for the duration of a
task, with no yml record, no `apply` rebuild. The model is
`kubectl port-forward` / `ssh -L`.

Background + rejected alternatives: [ADR 0009](../adr/0009-tcp-tunnels-foreground-sidecar.md).

## Mechanics

1. Reads the container yml at `$MONOCEROS_HOME/container-configs/<name>.yml`.
2. Resolves the target (yml-first — the configured services in the
   container yml are the source, not a fixed catalog):
   - **Service name** (`postgres`) → must appear in the `services:` block
     of the yml. The internal port comes from the service's `port:` field
     (for curated services from the catalog default). A custom service
     without `port:` → clear error (or use `service:port`, see below).
   - **`Service:Port`** (`rustfs:9001`) → the same service, but on an
     **explicit** port. For a second port (e.g. a console UI on 9001
     alongside the API on 9000) — works even when the service
     declares no `port:`.
   - **Port number** (`8080`) → internal port directly, target is the
     workspace container.
3. Pre-flight: is the local port free? If not → clear error with a
   `--local-port` hint.
4. Starts `docker run --rm -i --network=<container-network>
-p <local-address>:<local-port>:<internal-port> alpine/socat:1.8.0.3
TCP-LISTEN:… TCP:<target>:<internal-port>` in the foreground.
5. Ctrl+C → docker run signals socat, the container exits, `--rm`
   cleans up.

## Arguments

| Argument            | Meaning                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>`            | Container name (yml in `$MONOCEROS_HOME/container-configs/`).                                                                            |
| `<service-or-port>` | Configured service name (`postgres`), `service:port` for an explicit port (`rustfs:9001`), or a bare internal port number (→ workspace). |

## Options

| Flag                     | Default         | Effect                                                                                                         |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `--local-port=<n>`       | = internal port | Host-side listen port. Override when the default port is taken.                                                |
| `--local-address=<addr>` | `127.0.0.1`     | Host interface. `0.0.0.0` exposes on all interfaces (visible on the LAN). The default guards against mistakes. |

## Examples

### Query Postgres from the container, on the host

```sh
$ monoceros tunnel sandbox postgres
ℹ Tunnel: 127.0.0.1:5432 → sandbox/postgres:5432 (Ctrl+C to stop)
```

In a second terminal:

```sh
$ psql postgresql://monoceros:monoceros@localhost:5432/monoceros
```

### Multiple DBs at once — one terminal per tunnel

```sh
# Terminal 1
$ monoceros tunnel sandbox postgres

# Terminal 2
$ monoceros tunnel sandbox redis

# Terminal 3 — the actual tooling
$ pgcli postgresql://…@localhost:5432/monoceros
$ redis-cli -h localhost -p 6379
```

### Resolve a port collision

```sh
$ monoceros tunnel sandbox postgres
✖ Local port 5432 on 127.0.0.1 is already in use.

  Identify the holder, then either stop it or pick a different
  port for the tunnel:

    sudo lsof -iTCP:5432 -sTCP:LISTEN -n -P

  Re-run with an explicit local port:
    monoceros tunnel … --local-port=5433

$ monoceros tunnel sandbox postgres --local-port=5433
ℹ Tunnel: 127.0.0.1:5433 → sandbox/postgres:5432 (Ctrl+C to stop)
```

### Ad-hoc HTTP app, not in `routing.ports`

An internal test app listens on `8080` but isn't registered in
`routing.ports` (the builder wants no apply rebuild, no yml entry):

```sh
$ monoceros tunnel sandbox 8080
ℹ Tunnel: 127.0.0.1:8080 → sandbox:8080 (Ctrl+C to stop)
```

→ http://localhost:8080/ goes through. For **persistent** HTTP
routes, [`add-port`](./add-port.md) is the right solution.

### Test from a mobile device on the same Wi-Fi

```sh
$ monoceros tunnel sandbox 3000 --local-address=0.0.0.0
ℹ Tunnel: 0.0.0.0:3000 → sandbox:3000 (Ctrl+C to stop)
```

From the phone: `http://<machine-IP>:3000/`. The default `127.0.0.1`
would block this — a deliberate opt-in, because LAN exposure is a
security step.

## Related commands

- [`add-port`](./add-port.md) / [`port`](./port.md) — persistent
  HTTP routing via Traefik. First choice when the port should stick around.
- [`add-service`](./add-service.md) — add a Compose service before
  accessing it via `tunnel <name> <service-name>`.
- [`shell`](./shell.md) — when the tooling is allowed to live in the
  container, that's often the simpler answer. Tunnel is for the cases
  where the builder explicitly wants to work from the host.

## Failure modes

- **`No yml profile`** — the container yml doesn't exist. Run `monoceros
init <name>` first.
- **`Container is not materialised`** — the yml is there, but `apply`
  hasn't run yet. `monoceros apply <name>`.
- **`No running container`** (image mode without `routing.ports`) —
  the container is stopped. `monoceros start <name>` (or
  `monoceros shell <name>`) first.
- **`Service '…' is not configured in this container's yml`** — the
  name isn't in the `services:` block. The message lists the
  configured services. `monoceros add-service <name> <svc>` +
  `monoceros apply`.
- **`Service '…' declares no port`** — bare service name, but the
  (custom) service has no `port:`. Either add `port:` to the yml and
  re-apply, or pass the port explicitly:
  `monoceros tunnel <name> <svc>:<port>`.
- **`Invalid target '…'`** — `service:port` form with a non-numeric
  or out-of-range port (1–65535).
- **`Local port … is already in use`** — pre-flight check. Another
  app is listening on the default port; redirect with `--local-port=<n>`.
- **`image-mode (no compose.yaml)` + service name** — services
  need Compose mode. Add at least one service to the yml and
  re-apply.
