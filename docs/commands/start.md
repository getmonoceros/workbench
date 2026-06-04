# `monoceros start`

Brings the named container up. In Compose mode this simultaneously
starts the workspace container and all Compose services
(`postgres`, `mysql`, `redis`).

```sh
monoceros start <name>
```

## Purpose

When you've paused the container with `monoceros stop` and need it
again — `start` turns it back on without rebuilding. Compared to
`monoceros apply`:

| Aspect                                   | `apply` | `start` |
| ---------------------------------------- | ------- | ------- |
| Reads the yml and rewrites the scaffold  | yes     | no      |
| Removes the old container first          | yes     | no      |
| Rebuilds the image when features changed | yes     | no      |
| Brings the container up                  | yes     | yes     |

In short: `start` is the cheap lifecycle wakeup. `apply` is the full
"apply yml changes" operation.

## Mechanics

Behind the scenes this is a `devcontainer up --workspace-folder <root>`.
In Compose mode that includes the `workspace` service plus all
`runServices` from the `devcontainer.json` (which was generated from
the `services:` in the yml).

## Arguments

| Argument | Meaning         |
| -------- | --------------- |
| `<name>` | Container name. |

## Example

```sh
$ monoceros start sandbox
ℹ Bringing up sandbox …
[+] Running 3/3
 ✔ Container sandbox_devcontainer-postgres-1   Started
 ✔ Container sandbox_devcontainer-workspace-1  Started
 ✔ Network sandbox_devcontainer_default        Created
✔ sandbox is up.
```

## Related commands

- [`monoceros stop <name>`](./stop.md) — pause Compose services
  without removing them
- [`monoceros status <name>`](./status.md) — show what's running
- [`monoceros apply <name>`](./apply.md) — apply yml changes + rebuild
  - bring up (instead of just bringing up)
- [`monoceros remove <name>`](./remove.md) — remove the container
  completely

## Failure modes

- **`No .devcontainer/ at <path>`** — the container was never
  materialized. Run `monoceros apply <name>` first.
- **Port conflict** — if another process or container occupies the
  forwarded ports (3000, 4000), the workspace start fails. Stop the
  blocking process or edit `forwardPorts` in the yml.
