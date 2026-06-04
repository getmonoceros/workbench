# `monoceros shell`

Opens an interactive Bash session in the named container. Brings it
up automatically beforehand if needed.

```sh
monoceros shell <name>
```

## Purpose

The standard way to "be inside the container": a direct Bash prompt
with all the tools, features, and auth states that `monoceros apply`
materialized. Exits with `exit` or `Ctrl-D`.

## Mechanics

1. **Container check**: verifies that `<MONOCEROS_HOME>/container/<name>/.devcontainer/`
   exists. If not → `Run \`monoceros apply <name>\` first` error.
2. **Implicit startup**: `devcontainer up` runs quietly (output is
   only emitted on error). If the container is already running, this
   is a no-op.
3. **Exec**: `devcontainer exec … bash` starts an interactive Bash
   session. stdio is passed through directly (no masking, no
   buffering), so a real TTY is attached and Bash behaves
   interactively.

The exit code of the Bash session is propagated back.

## Arguments

| Argument | Meaning                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| `<name>` | Container name. Must have a yml under `container-configs/` and a materialized `container/<name>/`. |

## Example

```sh
$ monoceros shell sandbox
node ➜ /workspaces/sandbox $ ls projects/
api  web

node ➜ /workspaces/sandbox $ exit
$
```

On macOS/Windows with Docker Desktop: the bind-mount volume for the
workspace folder may need a few seconds for file-sharing negotiation
on the first call; after that it feels native.

## Related commands

- [`monoceros run <name> -- <cmd>`](./run.md) — one-off command instead
  of an interactive session
- [`monoceros apply <name>`](./apply.md) — build + bring up the container
- [`monoceros stop <name>`](./stop.md) — pause Compose services

## Failure modes

- **`No .devcontainer/ at <path>`** — container was never materialized.
  Run `monoceros apply <name>` first.
- **Container does not start** — the first few lines of the buffered
  `up` output are sent to stderr on error. Common causes: Docker
  Desktop not running, port conflict, image build failure after
  changed features.
- **Immediate exit without an error message** — Bash sees no TTY.
  This happens when the CLI is not invoked through a terminal (e.g.
  from a non-interactive shell script). Fix: use
  `monoceros run <name> -- <cmd>` for scripted calls.
