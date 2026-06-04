# `monoceros port`

Lists a container's Traefik URLs — the default hostname plus an
explicit per-port hostname for each `routing.ports` entry.

```sh
monoceros port <name>
```

## Purpose

`monoceros add-port` writes the ports into the yml and lays down the
Traefik dynamic config — and when you then want to know **which URLs
the container is reachable at**, you call `port`. It saves you from
reconstructing the subdomain pattern from memory and correctly
reflects a host port that differs from the default in
`monoceros-config.yml`.

## How it works

1. Reads `routing.ports` from `$MONOCEROS_HOME/container-configs/<name>.yml`.
2. Reads `routing.hostPort` from `monoceros-config.yml` (default 80).
3. Computes the URL set:
   - `http://<name>.localhost[:<hostPort>]` → first port (default)
   - `http://<name>-<port>.localhost[:<hostPort>]` → each port individually
4. Prints an aligned table in TTY mode, and tab-separated lines when
   piped (`port<TAB>url<TAB>tag`, where the tag is either `default`
   for the default row or empty).

## Arguments

| Argument | Meaning                                                       |
| -------- | ------------------------------------------------------------- |
| `<name>` | Container name (yml in `$MONOCEROS_HOME/container-configs/`). |

## Examples

### Container with three ports, default host port 80

```sh
$ monoceros port sandbox
  3000  →  http://sandbox.localhost       (default)
  3000  →  http://sandbox-3000.localhost
  5173  →  http://sandbox-5173.localhost
  6006  →  http://sandbox-6006.localhost
```

### With `routing.hostPort: 8080` in `monoceros-config.yml`

```sh
$ monoceros port sandbox
  3000  →  http://sandbox.localhost:8080       (default)
  3000  →  http://sandbox-3000.localhost:8080
  5173  →  http://sandbox-5173.localhost:8080
  6006  →  http://sandbox-6006.localhost:8080
```

### Container without ports

```sh
$ monoceros port sandbox
ℹ No ports declared in sandbox.yml. Run `monoceros add-port sandbox -- <port>` to expose one.
```

### Machine-readable (piped)

```sh
$ monoceros port sandbox | head -2
3000	http://sandbox.localhost	default
3000	http://sandbox-3000.localhost
```

For `awk`/`grep` pipelines:

```sh
# URL only, no "default" duplicate
monoceros port sandbox | awk -F'\t' '$3 == "" { print $2 }'
```

## Related commands

- [`add-port`](./add-port.md) — add a port to the yml + dynamic config
- [`remove-port`](./remove-port.md) — remove a port again
- [`monoceros apply <name>`](./apply.md) — materialize the container
  with the current set of ports

## Failure modes

- **`No such config`** — the container yml does not exist. Run
  `monoceros init <name>` first.
- **`Invalid solution config`** — `routing.ports` contains an entry
  that violates the schema. The error message shows the location (dot
  path) and what was expected.
