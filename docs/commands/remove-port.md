# `monoceros remove-port`

Removes one or more ports from the container config. Idempotent,
shows a diff before writing.

```sh
monoceros remove-port <name> [--yes] -- <port> [<port> …]
```

## Purpose

The mirror image of [`add-port`](./add-port.md). Removes the named
entries from the `ports:` block of the container yml. If ports remain
after the mutation, the dynamic config at
`$MONOCEROS_HOME/traefik/dynamic/<name>.yml` is overwritten with the new
state. If all ports are gone, the file is deleted and Monoceros offers
to stop the Traefik singleton (`maybeStopProxy()` — stops only when no
other container is left in the proxy network).
See [ADR 0007](../adr/0007-port-management-traefik.md).

## Mechanics

1. **Validation** as with `add-port` (integer 1–65535).
2. **Matching** against short and long form: `remove-port sandbox -- 9229`
   removes both a `- 9229` entry and a `- port: 9229` entry.
3. **Diff preview** before writing (skipped with `--yes`).
4. **AST mutation**: removes the entries comment-preserving from
   `routing.ports`. If the list is then empty, the `ports:` field is
   pruned; if `routing:` is then completely empty (no `vscodeAutoForward`
   set), the entire block is removed.

## Arguments

| Argument           | Meaning                                     |
| ------------------ | ------------------------------------------- |
| `<name>`           | Container name.                             |
| `<port> [<port>…]` | One or more ports after `--`, each 1–65535. |

## Options

| Option      | Meaning                                          |
| ----------- | ------------------------------------------------ |
| `--yes, -y` | Skip the diff confirmation prompt (for scripts). |

## Idempotency

Ports that aren't in the yml at all are silently skipped (no-change).
This makes `remove-port` robust in scripts against the "did I already
remove this port?" case.

## Related commands

- [`add-port`](./add-port.md) — the inverse
- [`monoceros apply <name>`](./apply.md) — apply the change

## Failure modes

- **`Invalid port: <value>`** — the value isn't an integer or falls
  outside 1–65535.
- **`No ports given`** — the argument list after `--` is empty.
- **`No such config`** — the container yml doesn't exist.
