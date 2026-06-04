# `monoceros status`

Shows which Compose services of the named container are currently
running, stopped, or have never been started.

```sh
monoceros status <name> [--service <svc>]
```

## Purpose

A quick answer to "is the container running?" without having to drop
into the Docker CLI. The output comes straight from
`docker compose ps`, so it is complete and honest.

## Mechanics

A `docker compose ps` against the container's Compose file with the
Compose project name `<name>_devcontainer`. Tabular:

| Column   | Content                                                  |
| -------- | -------------------------------------------------------- |
| `NAME`   | Container name (e.g. `sandbox_devcontainer-workspace-1`) |
| `IMAGE`  | the loaded image                                         |
| `STATUS` | `running (...)`, `exited (0)`, …                         |
| `PORTS`  | mapped ports (if published)                              |

## Arguments

| Argument | Meaning         |
| -------- | --------------- |
| `<name>` | Container name. |

## Options

| Option            | Meaning                                               |
| ----------------- | ----------------------------------------------------- |
| `--service <svc>` | Show only one Compose service. Default: all services. |

## Examples

Everything:

```sh
$ monoceros status sandbox
NAME                                  IMAGE                       STATUS              PORTS
sandbox_devcontainer-postgres-1       postgres:18                 Up 2 minutes        5432/tcp
sandbox_devcontainer-workspace-1      monoceros-runtime:dev       Up 2 minutes        0.0.0.0:3000->3000/tcp, 0.0.0.0:4000->4000/tcp
```

Only one service row:

```sh
$ monoceros status sandbox --service postgres
NAME                              IMAGE         STATUS              PORTS
sandbox_devcontainer-postgres-1   postgres:18   Up 2 minutes        5432/tcp
```

## Related commands

- [`monoceros start <name>`](./start.md) — start up
- [`monoceros stop <name>`](./stop.md) — pause
- [`monoceros logs <name>`](./logs.md) — follow Compose logs

## Failure modes

- **`No compose.yaml at <path>`** — the container is in image mode
  (no Compose services). `status` only makes sense in Compose mode;
  for pure image-mode containers, `docker ps` provides comparable
  info.
- **Empty table** — the Compose project does not exist (`start` or
  `apply` was never called, or it was cleaned up with `remove`).
