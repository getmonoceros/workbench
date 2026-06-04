# ADR 0009 — TCP Tunnels via a Foreground socat Sidecar

- Status: accepted
- Date: 2026-05-28

## Context

[ADR 0007](./0007-port-management-traefik.md) provides
**HTTP routing**: ports declared in the `routing.ports` block are
served by the Traefik singleton behind `<name>.localhost`,
persistent across `apply` runs. That is the right answer for web
apps the builder wants to reach permanently.

Three use cases remain unsolved:

1. **Reaching TCP services (postgres, mysql, redis, …)** from the
   host. Traefik is HTTP-only, but `psql -h localhost -p 5432`
   needs to hit the service port directly.
2. **Ad-hoc HTTP apps** that are _not_ listed in `routing.ports`,
   checked once — without an `apply` rebuild and without touching
   the yml.
3. **Per-container tooling** (`pgcli`, GUI DB clients, REST clients)
   without resorting to `monoceros shell`.

All three are situational — the builder wants them for the duration
of a task, not permanently. Recording them in the yml would be the
wrong kind of persistence.

## Rejected: Persistent sidecars recorded in the yml

The original backlog draft proposed managing tunnels as container
yml entries (`tunnels:` alongside `routing.ports`), starting them
with `monoceros tunnel <name>`, stopping them with `monoceros tunnel
<name> --stop`, and cleaning them up implicitly on `monoceros
stop`/`remove`. Sidecars would have come back up via `monoceros
start <name>`.

**Why rejected:**

- Two lifecycle models side by side (persistent for HTTP via
  Traefik, persistent for TCP via sidecar) is one concept too many.
  The builder would have to maintain two mental models.
- A listing subcommand (`monoceros status` with a tunnel column? A
  dedicated `tunnel --list`?) becomes necessary as soon as tunnels
  survive.
- Cleanup logic in `remove`/`stop` has to cover edge cases ("the
  tunnel points nowhere because the container is down — now what?").
- The mental model does not match the tooling precedent: `kubectl
port-forward` and `ssh -L` are foreground commands. Builders who
  know those expect the same.

## Rejected: SSH-based tunnel in the dev container

Start sshd in the container, key-based auth, an `ssh -L` call from
the host. Advantage: one tunnel can carry multiple ports at once.
Disadvantage: sshd + key management in the dev container is
over-engineering for local dev. The builder's workstation already
has Docker access — why detour through SSH? Worth revisiting if
remote dev containers (over the network) become a topic later.

## Decision

**One foreground process per tunnel, one tunnel per invocation,
Ctrl+C to stop.** Implemented via a short-lived `alpine/socat`
sidecar that joins the Docker network of the target container and
forwards a host port to the internal port.

### CLI form

```sh
monoceros tunnel <name> <service-or-port> [--local-port=<n>] [--local-address=<addr>]
```

- `<service-or-port>` is either a service name from the `services:`
  block of the container yml (`postgres`, `mysql`, `redis` — cf.
  `monoceros list-components`) or an internal port number (`8080`).
- `--local-port` sets the host port. The default is 1:1 (postgres →
  5432 → 5432, port 8080 → 8080). If the default port is already in
  use, the command aborts with a clear error; the builder remaps it
  explicitly.
- `--local-address` sets the listen interface on the host. The
  default is `127.0.0.1` (loopback only — reachable from the same
  machine, not from the LAN). `--local-address=0.0.0.0` binds on all
  interfaces; useful, for example, for testing from a mobile device
  on the same Wi-Fi. A deliberate opt-in, because LAN exposure has a
  security consequence.

### Lifecycle

1. **Start:** `monoceros tunnel hello postgres` blocks in the
   terminal with an info line
   (`Tunnel: localhost:5432 → hello/postgres:5432, Ctrl+C to stop`).
2. **Stop:** Ctrl+C signals the `docker run` subprocess; the socat
   container has `--rm` and disappears on exit.
3. **Multiple parallel tunnels:** multiple terminals (or `&`).
   Deliberately no `--for-services=postgres,mysql` collection in a
   single call — log multiplexing causes more confusion than the
   convenience is worth, and `--local-port` collisions would not be
   semantically resolvable in an unambiguous way.

### Topology

The sidecar joins the Docker network of the target container and
reaches the service by DNS name:

```
docker run --rm -i \
  --network=<container-network> \
  -p <local-address>:<local-port>:<internal-port> \
  alpine/socat:1.8.0.3 \
  TCP-LISTEN:<internal-port>,fork,reuseaddr \
  TCP:<target-host>:<internal-port>
```

The socat image is pinned to a concrete version
(`alpine/socat:1.8.0.3`) — reproducibility beats floating-latest. A
bump happens explicitly via an ADR update.

Network and target host depend on the container mode:

| Mode                                  | Network                   | Target host (DNS)          |
| ------------------------------------- | ------------------------- | -------------------------- |
| Compose, service name (`postgres`)    | `<projectName>_default`   | Compose service name       |
| Compose, port (workspace)             | `<projectName>_default`   | `workspace`                |
| Image mode with `routing.ports`, port | `monoceros-proxy`         | `<container-name>` (alias) |
| Image mode without `routing.ports`    | (bridge IP via `inspect`) | container IP               |

The last case is the fallback: without `routing.ports` the
container is on Docker's default bridge with no DNS, so we look up
the IP once at start and target it directly.

### What is deliberately left out

- **Listing command** — `ps`/terminal tabs are the listing.
- **`tunnel --stop`** — Ctrl+C is the stop.
- **yml persistence** — no `tunnels:` section in the container yml.
  Tunnel config is always the CLI invocation.
- **TLS** — this is the TCP layer; end-to-end encryption is the
  service protocol's job (postgres SSL, redis TLS, …).

## Consequences

- Tunnel code lives under `packages/cli/src/tunnel/` (its own module
  alongside `proxy/`), with no yml schema extension.
- `alpine/socat` is an additional image, pulled on the first
  `tunnel` call. Small (~5 MB), well maintained, single-purpose — a
  defensible footprint.
- A crashed `monoceros tunnel` process (kill -9 instead of Ctrl+C)
  leaves the socat container hanging briefly until Docker cleans it
  up via `--rm`. Worst case, the builder sees a
  `monoceros-tunnel-…` container in `docker ps` — no state leak,
  since `--rm` takes effect on the next exit signal.
- A precedent for future situational sidecar commands: if more
  "lives only while the command runs" tools show up, the pattern is
  documented.
