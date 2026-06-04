# `monoceros add-language`

Adds a language toolchain to the container config. Idempotent,
shows a diff before writing.

```sh
monoceros add-language <name> <lang>[:version] [--yes]
```

## Purpose

Edits the yml at
`$MONOCEROS_HOME/container-configs/<name>.yml`. Adds `<lang>` (or
`<lang>:<version>`) to the `languages:` block. Afterwards the
container must be re-materialized with `monoceros apply <name>` so
that the language lands in the container as a devcontainer feature.

## Mechanics

1. **Schema validation** of the yml (catches a follow-up error early).
2. **Catalog check**: `<lang>` must be in the curated list
   `node, python, java, go, rust, dotnet`. Unknown values
   are rejected with a list of the allowed languages.
3. **Diff preview** before writing (skipped with `--yes`).
4. **AST mutation**: writes the `languages:` field comment-
   preserving; existing comments and layout are kept.

## Arguments

| Argument | Meaning                                                                          |
| -------- | -------------------------------------------------------------------------------- |
| `<name>` | Container name.                                                                  |
| `<lang>` | Language name from the catalog, optionally with a `:version` suffix (`java:17`). |

## Options

| Option      | Meaning                                          |
| ----------- | ------------------------------------------------ |
| `--yes, -y` | Skip the diff confirmation prompt (for scripts). |

## Version suffix

The `:version` suffix is passed through to the upstream
devcontainer feature as the `version` option during `apply`:

```sh
$ monoceros add-language sandbox java:17
$ monoceros apply sandbox
```

Produces in `devcontainer.json`:

```json
"features": {
  "ghcr.io/devcontainers/features/java:1": { "version": "17" }
}
```

Special case `node`: without a version (`node`) it stays a built-in
of the base image runtime (Node 22, no feature installation).
`node:<version>` switches over to the upstream feature.

## Idempotency

`add-language sandbox python` twice in a row → the second call
is a no-change (the file is not touched, the confirm prompt
states clearly that there is nothing to do).

If `python` is already in the yml without a version and you add
`python:3.12`: the first entry is replaced.

## Related commands

- [`remove-language`](./remove-language.md) — the inverse
- [`monoceros apply <name>`](./apply.md) — make the change effective
- [`monoceros init <name> --with-languages=<lang>:<version>`](./init.md) —
  add the language with a version already at init time

## Failure modes

- **`Unknown language: <name>`** — typo or a language not
  in the catalog. The error message lists the allowed values.
- **`No such config`** — the container yml at
  `container-configs/<name>.yml` does not exist. Run `monoceros init`
  first.
