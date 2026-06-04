# `monoceros restore`

Restores a container from a `monoceros remove` backup. Copies the yml
source and the container directory back into `$MONOCEROS_HOME`, so
`monoceros apply <name>` can bring the container back up afterward.

```sh
monoceros restore <backup-path>
```

## Purpose

`monoceros remove` writes a backup to
`container-backups/<name>-<timestamp>/` before deleting. `restore` is
the inverse command: it takes such a directory and puts it back into
the `$MONOCEROS_HOME` layout.

When will you need this?

- Container deleted by accident.
- Container paused for a different setup and reactivated later.
- Container moved from one machine to another (copy the backup
  directory, then run `monoceros restore` on the target machine).

## Mechanics

1. **Read the backup**: checks that `<backup-path>` is a directory,
   looks for a `*.yml` in the root, and derives the container name from
   it (file `<name>.yml`).
2. **Survival check**: refuses to clobber. Aborts with a clear error
   message if
   - `$MONOCEROS_HOME/container-configs/<name>.yml` already exists
   - or `$MONOCEROS_HOME/container/<name>/` already exists (and the
     backup contains a container folder). Fix: run
     `monoceros remove <name>` first.
3. **Copy**: `<backup>/<name>.yml` → `container-configs/<name>.yml`,
   `<backup>/container/` → `container/<name>/` (recursively). Including
   `home/`, `projects/`, `data/`, `.monoceros/`.
4. **Hint**: prints that `monoceros apply <name>` is the missing next
   step — restore does not create the Docker objects itself.

## Arguments

| Argument        | Meaning                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `<backup-path>` | Path to a backup directory (typically `<MONOCEROS_HOME>/container-backups/<name>-<timestamp>/`). |

## Example

```sh
$ ls ~/.monoceros/container-backups/
sandbox-2026-05-19T10-15-22-401Z
sandbox-2026-05-19T11-41-42-582Z

$ monoceros restore ~/.monoceros/container-backups/sandbox-2026-05-19T11-41-42-582Z
✔ Restored 'sandbox' from container-backups/sandbox-2026-05-19T11-41-42-582Z.
ℹ Run `monoceros apply sandbox` to bring the container back up.

$ monoceros apply sandbox
```

## Related commands

- [`monoceros remove <name>`](./remove.md) — tear down a container
  (writes the backup that `restore` reads)
- [`monoceros apply <name>`](./apply.md) — bring the restored
  container back up

## Failure modes

- **`Backup not found`** — path does not exist. Typo?
- **`Backup path is not a directory`** — path points to a file.
- **`Backup at … doesn't contain a *.yml`** — the backup is not from
  `monoceros remove`. Restore expects a single `<name>.yml` in the
  root.
- **`Refusing to restore: … already exists`** — a container with the
  same name already exists at the target. Run `monoceros remove`
  first, then `restore` again.
