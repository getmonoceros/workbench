# `monoceros remove`

Clears away everything that belongs to a container — Docker objects,
yml config, and the materialized directory. Writes a backup
beforehand, so nothing is lost irreversibly.

```sh
monoceros remove <name> [--no-backup] [-y]
```

## Purpose

The endpoint for "I don't need this container anymore." Unlike
`monoceros stop` (which only pauses), `remove` really clears away
everything:

- Docker containers of the Compose services + image-mode container
- Compose network
- yml source under `container-configs/<name>.yml`
- materialized container folder under `container/<name>/`
  including `home/`, `projects/`, `.monoceros/`, and `data/`
  (DB contents now land there as a bind mount, see
  [ADR 0003](../adr/0003-container-state-model.md))

What is **not** cleared away:

- Shared Docker images (`monoceros-runtime:dev`, the Postgres base,
  …) — other containers may still use them. Clean up via
  `docker image prune` if desired.

## Mechanics

In this order:

1. **Confirm prompt** shows what will happen. Skip with `-y`.
2. **Docker cleanup**: stops + removes all containers that belong to
   the project (by Compose label, by container name prefix,
   plus the image-mode `vsc-<name>-…` container). Cleans up the
   Compose network `<name>_devcontainer_default` as well.
3. **Backup** (on by default, off with `--no-backup`): copies
   `<name>.yml` and the entire `container/<name>/` directory
   to `$MONOCEROS_HOME/container-backups/<name>-<timestamp>/`.
   A plain directory tree — no tar, simply restorable with `cp -r`.
4. **Deletion**: yml + container directory from disk.

## Arguments

| Argument | Meaning                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>` | Container name. There must be a yml under `container-configs/` AND/OR a materialized `container/<name>/` directory — otherwise an error. |

## Options

| Option        | Meaning                                                           |
| ------------- | ----------------------------------------------------------------- |
| `--no-backup` | Skip the backup step. Host state is then gone for good afterward. |
| `-y, --yes`   | Skip the confirm prompt (for scripts).                            |

## Examples

Conservative — with backup and confirm:

```sh
$ monoceros remove sandbox
 ▲ About to remove 'sandbox'. A backup will be written to
   container-backups/ first, then docker objects, container-configs
   entry, and container directory will all be deleted.
Continue? [y/N] y
ℹ Backup written to container-backups/sandbox-2026-05-19T08-12-44-501Z.
✔ Removed 'sandbox': docker objects gone, container-configs entry deleted, container directory deleted.
```

For scripts or when you're sure:

```sh
$ monoceros remove sandbox --no-backup -y
✔ Removed 'sandbox': docker objects gone, container-configs entry deleted, container directory deleted.
 ▲ No backup created (--no-backup). The host-side state is gone for good.
```

## Related commands

- [`monoceros stop <name>`](./stop.md) — only pauses, everything stays
- `monoceros init <name>` + `apply <name>` — set up the container anew
  (see [init.md](./init.md), [apply.md](./apply.md))

## Failure modes

- **`Nothing to remove for '<name>'`** — neither yml nor
  container directory exists. Typo? Check with `ls container-configs/`.
- **`Invalid config name`** — `<name>` contains a slash, space, or
  shell metacharacters. Allowed: `[A-Za-z0-9._-]+`.
- **Docker cleanup exit code ≠ 0** — something in the Docker
  pipeline got stuck. The command aborts **before** the backup
  or the deletion happens — so no partial state.

## When the backup isn't enough

DB data today lives under `container/<name>/data/<service>/`
on the host disk and is automatically included in the backup. If
you want a logical backup (e.g. a SQL dump instead of a
file snapshot), plan for `pg_dump` or an equivalent **before**
`monoceros remove` — the container must still be running so there's
something to dump.
