# `monoceros add-port`

Adds one or more ports to the container config.
Idempotent, shows a diff before writing.

```sh
monoceros add-port <name> [--yes] [--default] -- <port> [<port> …]
```

## Purpose

`add-port` writes the port into the yml at
`$MONOCEROS_HOME/container-configs/<name>.yml` **and** writes the
Traefik dynamic config alongside it at
`$MONOCEROS_HOME/traefik/dynamic/<name>.yml`. The singleton proxy is
started on demand (`ensureProxy()` — idempotent). Hot reload: Traefik
picks up the file within ~100 ms, **no** container restart, **no**
proxy restart. See
[ADR 0007](../adr/0007-port-management-traefik.md).

## Mechanics

1. **Validation**: every port must be an integer between `1` and
   `65535`. Typos (letters, floats, out-of-range values) are rejected
   with the offending input value.
2. **Dedup** at the CLI level: `add-port sandbox -- 3000 3000` becomes
   `[3000]`.
3. **Diff preview** before writing (skipped with `--yes`).
4. **AST mutation**: writes the `routing.ports` field while preserving
   comments. The `routing:` block is created on the first call (before
   that it is included, commented out, in the init output). Existing
   entries are matched against both short form (`- 3000`) **and** long
   form (`- port: 3000`), so idempotency holds regardless of which
   form the builder used by hand.

The resulting yml layout:

```yaml
routing:
  ports:
    # first entry = <name>.localhost
    - 3000
    - 5173
  # default false; set to true to enable VS Code's own forwards in
  # parallel to Traefik
  vscodeAutoForward: false
```

## Arguments

| Argument           | Meaning                                     |
| ------------------ | ------------------------------------------- |
| `<name>`           | Container name.                             |
| `<port> [<port>…]` | One or more ports after `--`, each 1–65535. |

## Options

| Option      | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `--yes, -y` | Skip the diff confirmation prompt (for scripts).                              |
| `--default` | Make the given port the default route target (position 0 in `routing.ports`). |

## Hostname scheme

- `<container>.localhost` → default port (first entry in
  `routing.ports`)
- `<container>-<port>.localhost` → explicit internal port

If the Traefik host port differs from 80 via `monoceros-config.yml`
(see `routing.hostPort`), it is appended to the URLs:
`http://<container>.localhost:<port>/`.

Example: after `monoceros add-port sandbox -- 3000 5173 6006`:

| URL                             | Routes to                            |
| ------------------------------- | ------------------------------------ |
| `http://sandbox.localhost`      | `http://sandbox:3000` (default port) |
| `http://sandbox-3000.localhost` | `http://sandbox:3000`                |
| `http://sandbox-5173.localhost` | `http://sandbox:5173`                |
| `http://sandbox-6006.localhost` | `http://sandbox:6006`                |

`*.localhost` resolves to 127.0.0.1 automatically on every modern OS
per RFC 6761 — no `hosts` file changes needed.

## Changing the default port

The first entry in `routing.ports` doubles as the
`<container>.localhost` route. To make a different port the default
without rebuilding the list:

```sh
monoceros add-port sandbox -y --default -- 5173
```

Effect:

- Port already in the list → moved to position 0, the rest of the
  order is preserved
- Port not yet in the list → inserted at the front
- Port is already the default → no change

More than one port with `--default` is an error — which of several
should be the default? If needed, use two calls: first `--default`,
then the rest without the flag.

## Idempotency

`add-port sandbox -- 3000` twice in a row → the second call is a
no-change. `add-port sandbox -- 3000 5173` after an initial
`add-port sandbox -- 3000` only adds the missing port 5173.

## Related commands

- [`remove-port`](./remove-port.md) — the inverse
- [`monoceros apply <name>`](./apply.md) — on the next apply, refreshes
  the routes to be consistent with the yml (state-driven)

## Failure modes

- **`Invalid port: <value>`** — value is not an integer or lies
  outside 1–65535.
- **`No ports given`** — the argument list after `--` is empty.
- **`No such config`** — the container yml does not exist. Run
  `monoceros init` first.
