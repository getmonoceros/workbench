# `monoceros stop`

Pauses the Compose services of the named container. Data and
container layers are preserved; a `monoceros start` brings the same
state back to life.

```sh
monoceros stop <name> [--service <svc>]
```

## Purpose

For when you're not currently working with the container and want to
give it back its CPU/RAM — but later want to pick up exactly where you
left off.

What `stop` does **not** do, importantly:

- Doesn't remove any containers (unlike `remove`)
- Doesn't remove any data
- Doesn't remove any Docker images
- Disk space savings: essentially none

If you really need space → [`monoceros remove`](./remove.md).

## Mechanics

`docker compose stop` underneath. The containers stay in `Exited`
status; their volumes and the Compose network remain unchanged. Data
lives as bind mounts under `container/<name>/data/` on the host disk
anyway (see [ADR 0003](../adr/0003-container-state-model.md)) and is
completely independent of the lifecycle.

## Arguments

| Argument | Meaning         |
| -------- | --------------- |
| `<name>` | Container name. |

## Options

| Option            | Meaning                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `--service <svc>` | Stop only one Compose service (e.g. `--service postgres`). Default: all services. |

## Examples

Pause everything:

```sh
$ monoceros stop sandbox
✔ Stopped sandbox_devcontainer
```

Only the DB container, leaving the workspace running:

```sh
$ monoceros stop sandbox --service postgres
✔ Stopped postgres
```

## Related commands

- [`monoceros start <name>`](./start.md) — bring it back up
- [`monoceros status <name>`](./status.md) — show which services are
  currently running or stopped
- [`monoceros remove <name>`](./remove.md) — remove it entirely
  (backup on by default)

## Failure modes

- **`No compose.yaml at <path>`** — the container is in image mode
  (no Compose services configured). `stop` then doesn't apply because
  there's nothing to stop; use Docker directly or add a service to
  the yml.
- **Unknown Compose service** — `--service foo` is reported by
  `docker compose` itself when `foo` is not in `compose.yaml`.
