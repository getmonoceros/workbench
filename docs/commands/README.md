# Monoceros CLI — Command Overview

This overview is the starting point for all `monoceros …` commands.
Each command has (or is getting) its own detail file.
`monoceros <cmd> --help` shows the terse variant with arguments and
options; the MD files here add purpose, examples, related commands,
and failure modes.

Opening the docs from inside the container:

```sh
less /opt/monoceros-workbench/docs/commands/<name>.md
```

## The config model

All commands follow a single schema:

```sh
monoceros <command> <containername> [<args> …]
```

`<containername>` is always the first positional argument. cwd does
not matter — Monoceros finds everything by convention. The layout:

```
$MONOCEROS_HOME/
├── monoceros-config.yml               ← optional, personal defaults
├── monoceros-config.sample.yml        ← committed (marker + template)
├── container-configs/
│   └── <name>.yml                     ← container config (`monoceros init`)
└── container/
    └── <name>/                        ← materialized dev container
                                         (`monoceros apply`)
```

`MONOCEROS_HOME` is resolved in this order:

1. Env var `MONOCEROS_HOME`
2. Dev detection: search upward from the CLI module for
   `<dir>/.local/monoceros-config.sample.yml` → `<dir>/.local`
3. Fallback `~/.monoceros`

## Typical lifecycle

```sh
monoceros init <name> --with-languages=node --with-services=postgres \
  --with-features=github,claude                           # compose config
vim $MONOCEROS_HOME/container-configs/<name>.yml          # adjust (optional)
monoceros apply <name>                                    # materialize + start dev container
monoceros shell <name>                                    # work inside it
monoceros add-feature <name> <feature>                    # edit config
monoceros apply <name>                                    # rebuild, picks up the change
```

## Create a solution + lifecycle

| Command                                 | Purpose                                               | Docs                                       |
| --------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `monoceros init <name> [--with-*=…]`    | Compose config from category flags (or a              | [init.md](./init.md)                       |
|                                         | documented template when all --with-\* are omitted)   |                                            |
| `monoceros list-components`             | Show the component catalog                            | [list-components.md](./list-components.md) |
| `monoceros apply <name>`                | Materialize config + start the container              | [apply.md](./apply.md)                     |
| `monoceros start <name>`                | Start the devcontainer (`devcontainer up` + services) | [start.md](./start.md)                     |
| `monoceros stop <name>`                 | Stop compose services, data persists                  | [stop.md](./stop.md)                       |
| `monoceros status <name>`               | Show compose status                                   | [status.md](./status.md)                   |
| `monoceros logs <name> [...]`           | Follow compose logs                                   | [logs.md](./logs.md)                       |
| `monoceros remove <name> [--no-backup]` | Remove the container entirely (backup by default)     | [remove.md](./remove.md)                   |
| `monoceros restore <backup-path>`       | Restore a container from a remove backup              | [restore.md](./restore.md)                 |

## Working in the container

| Command                         | Purpose                                                 | Docs                   |
| ------------------------------- | ------------------------------------------------------- | ---------------------- |
| `monoceros shell <name>`        | Interactive bash session in the container               | [shell.md](./shell.md) |
| `monoceros run <name> -- <cmd>` | One-off command in the container (exit code propagated) | [run.md](./run.md)     |

## Changing the configuration

### Adding

| Command                                         | Purpose                                                                | Docs                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| `monoceros add-language <name> <lang>`          | Add a language toolchain as a devcontainer feature (curated list)      | [add-language.md](./add-language.md)         |
| `monoceros add-service <name> <svc>`            | Add a compose service (Postgres, Redis, MySQL — curated list)          | [add-service.md](./add-service.md)           |
| `monoceros add-apt-packages <name> -- …`        | Add arbitrary apt packages (no whitelist)                              | [add-apt-packages.md](./add-apt-packages.md) |
| `monoceros add-feature <name> <feature> [-- …]` | Add a devcontainer feature (catalog short name or OCI ref)             | [add-feature.md](./add-feature.md)           |
| `monoceros add-from-url <name> <url>`           | Register an HTTPS install script via `curl … \| sh`                    | [add-from-url.md](./add-from-url.md)         |
| `monoceros add-repo <name> <url> [--path=…]`    | Clone a git repo into `projects/<folder>/` (idempotent, post-create)   | [add-repo.md](./add-repo.md)                 |
| `monoceros add-port <name> -- <port>…`          | Register port(s) → Traefik routing via `<name>.localhost` (hot reload) | [add-port.md](./add-port.md)                 |

### Removing

| Command                                      | Purpose                                                               | Docs                                               |
| -------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| `monoceros remove-language <name> <lang>`    | Remove a language toolchain                                           | [remove-language.md](./remove-language.md)         |
| `monoceros remove-service <name> <svc>`      | Remove a compose service (volumes persist — manual cleanup)           | [remove-service.md](./remove-service.md)           |
| `monoceros remove-apt-packages <name> -- …`  | Remove apt packages                                                   | [remove-apt-packages.md](./remove-apt-packages.md) |
| `monoceros remove-feature <name> <feature>`  | Remove a devcontainer feature (catalog short name or OCI ref)         | [remove-feature.md](./remove-feature.md)           |
| `monoceros remove-from-url <name> <url>`     | Remove an install URL (install result stays in the current container) | [remove-from-url.md](./remove-from-url.md)         |
| `monoceros remove-repo <name> <url-or-name>` | Remove a repo entry (the local `projects/<folder>/` folder persists)  | [remove-repo.md](./remove-repo.md)                 |
| `monoceros remove-port <name> -- <port>…`    | Remove port(s) from the container yml                                 | [remove-port.md](./remove-port.md)                 |

## Discovery

| Command                                           | Purpose                                                              | Detail                   |
| ------------------------------------------------- | -------------------------------------------------------------------- | ------------------------ |
| `monoceros port <name>`                           | Show a container's Traefik URLs (default + per port)                 | [port.md](./port.md)     |
| `monoceros tunnel <name> <service-or-port> [...]` | TCP tunnel from host into the container (foreground, Ctrl+C ends it) | [tunnel.md](./tunnel.md) |

(`monoceros list-components` is listed above under "Create a solution + lifecycle" — conceptually it also belongs to Discovery.)

## Tooling

| Command                        | Purpose                                                            | Detail                           |
| ------------------------------ | ------------------------------------------------------------------ | -------------------------------- |
| `monoceros completion <shell>` | Print the shell completion script for bash, zsh, or pwsh to stdout | [completion.md](./completion.md) |

## Conventions for all config commands

Every `add-*`/`remove-*` command is **idempotent**: the same call
twice → no file change the second time. Before writing, each call
shows a unified-diff preview; `--yes` (or `-y`) skips the confirm
prompt for scripts.

The commands edit the yml at `container-configs/<name>.yml` —
comments and the file's layout are **preserved**. Container files
(devcontainer.json, compose.yaml, post-create.sh) are **not changed
directly**; they regenerate on the next `monoceros apply <name>` from
the yml.

```sh
monoceros add-feature sandbox ghcr.io/devcontainers/features/github-cli:1 --yes
monoceros add-apt-packages sandbox --yes -- htop tmux
monoceros apply sandbox
```

## Global defaults: `monoceros-config.yml`

Optional, at `$MONOCEROS_HOME/monoceros-config.yml`. Today it carries
exactly one field: the default git identity, which applies in every
materialized container when the container yml itself specifies nothing
and the host has no global `git config`. A sample template lives next
to it at `monoceros-config.sample.yml`.

Priority for git identity resolution (`monoceros apply`):

1. `git.user` in the container yml (highest priority)
2. `defaults.git.user` in `monoceros-config.yml`
3. `git config --global --get user.name|email` on the host
4. Value from an earlier apply in `.monoceros/gitconfig`
5. Interactive prompt (skipped in non-TTY environments)
