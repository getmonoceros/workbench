# `monoceros run`

Runs a one-off command in the named container and returns its
exit code. Brings the container up automatically beforehand if
needed.

```sh
monoceros run <name> -- <cmd> [args …]
```

## Purpose

For anything that doesn't need an interactive bash: build scripts,
single CLI calls, health checks. Unlike `monoceros shell`, the
container is back to itself afterward, with no lingering session.

Common use cases:

- `monoceros run sandbox -- pnpm test`
- `monoceros run sandbox -- gh pr create`
- `monoceros run sandbox -- claude` (interactive is possible; see
  "Interactive inner commands" below)

## Mechanics

1. **Container check**: same as `shell`. If `.devcontainer/`
   doesn't exist → `Run \`monoceros apply <name>\` first` error.
2. **Implicit startup**: `devcontainer up` quiet (no-op if
   already running).
3. **Exec**: `devcontainer exec --workspace-folder … <cmd> [args]`.
   stdio inherit, so the inner command has direct TTY access.
   The exit code is propagated back.

## Arguments

| Argument     | Meaning                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>`     | Container name.                                                                                                                                                                           |
| `--in <dir>` | Run the inner command in `<dir>` inside the container. Relative to the workspace folder (`/workspaces/<name>`), or absolute. The directory must already exist — `run` does not create it. |
| `-- <cmd>`   | Everything after `--` is the inner command plus its arguments. The `--` is required so Monoceros doesn't try to interpret flags like `--help` itself.                                     |

Put `--in` (and any other monoceros flag) **before** the `--`; the
inner command and its arguments go after it.

## Examples

Simple:

```sh
$ monoceros run sandbox -- pnpm test
> @your-org/api@1.0.0 test
> vitest run
…
```

With your own flags:

```sh
$ monoceros run sandbox -- gh pr list --state open
```

## Interactive inner commands

`monoceros run` runs with `stdio: 'inherit'` and thereby passes
through a real TTY. Interactive inner commands like `claude`, `acli
rovodev run`, and `psql` work exactly as they do in a
`monoceros shell` session. Exiting the inner command also ends the
`run` call.

## Running in a sub-directory (`--in`)

By default the inner command runs in the workspace folder
(`/workspaces/<name>`), which holds `.devcontainer/`, `home/`,
`data/`, and `projects/`. To run somewhere else — typically a project
under `projects/` — pass `--in`:

```sh
$ monoceros run sandbox --in projects/web -- pnpm dev
$ monoceros run sandbox --in projects -- claude -p "scaffold a booking site"
```

`--in` wraps the command in a `cd` for you, so the inner command and
its arguments stay a plain array — no shell quoting of the arguments
is needed, even when an argument contains spaces or quotes. The
directory must already exist; a missing one fails with a clear
`cd: no such file or directory` instead of running in the wrong place.

## Shell builtins (`cd`, `export`, ...)

For a working directory, prefer `--in` above. For other bash builtins
(`export`, `source`, pipelines, `&&` chains), note that `monoceros run`
passes the argument array verbatim to `docker exec` — with no shell in
between — so the builtins themselves are not binaries on `$PATH` and
fail with `executable file not found`:

```sh
$ monoceros run sandbox -- export FOO=bar && env
OCI runtime exec failed: exec: "export": executable file not found
```

If you need a shell, invoke one explicitly:

```sh
$ monoceros run sandbox -- bash -lc 'export FOO=bar && env'
```

The single quotes matter; otherwise your host shell splits the
`&&` pipeline and the second half would run on the host side.

## Related commands

- [`monoceros shell <name>`](./shell.md) — interactive bash session
- [`monoceros apply <name>`](./apply.md) — build and start the container

## Failure modes

- **`No command provided`** — no `--` followed by a command was
  passed.
- **`No .devcontainer/ at <path>`** — container was never materialized.
- **`OCI runtime exec failed`** — the inner command doesn't exist
  in the container. Common with shell builtins (see above) or with
  a tool that wasn't installed by a feature.
