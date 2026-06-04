# `monoceros logs`

Tails the Compose logs of the named container. Default: all
services, with `-f` (follow). Use `--no-follow` for a one-shot
dump.

```sh
monoceros logs <name> [--service <svc>] [--no-follow]
```

## Purpose

When something goes wrong inside the container — `monoceros logs sandbox`
is the direct path to `docker compose logs`. No need to switch
to the Docker CLI.

## Mechanics

A `docker compose logs -f` using the container's Compose file and
project name. Follow mode (live) by default, or with `--no-follow`
a one-shot dump and exit.

## Arguments

| Argument | Meaning         |
| -------- | --------------- |
| `<name>` | Container name. |

## Options

| Option            | Meaning                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `--service <svc>` | Logs of a single Compose service only (e.g. `--service postgres`). Default: all services. |
| `--no-follow`     | One-shot dump instead of `tail -f` behavior. Useful in scripts or for a quick look.       |

## Examples

Live-tail all services:

```sh
$ monoceros logs sandbox
sandbox_devcontainer-postgres-1   | 2026-05-19 12:31:01.512 UTC [1] LOG:  starting PostgreSQL 18.0
sandbox_devcontainer-postgres-1   | 2026-05-19 12:31:01.524 UTC [1] LOG:  database system is ready to accept connections
sandbox_devcontainer-workspace-1  | (workspace ready)
^C
```

Postgres only, without follow:

```sh
$ monoceros logs sandbox --service postgres --no-follow
```

## Related commands

- [`monoceros status <name>`](./status.md) — which services are
  actually running
- [`monoceros start <name>`](./start.md) / [`stop`](./stop.md) —
  lifecycle

## Failure modes

- **`No compose.yaml at <path>`** — image-mode container. Use
  `docker logs <container-id>` for the image-mode equivalent.
- **Empty output** — the service never started, or the Compose
  project does not exist (see `status`).
