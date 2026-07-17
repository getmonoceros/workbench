# Monoceros

A **workbench for local, reproducible dev containers with AI-coding
tooling**. You describe in a yml profile what should live in the
container - language, services, AI tools, repos - and Monoceros
materializes it. Language- and stack-agnostic.

How it differs from cloud Codespaces or Cursor Cloud:

- **local** - no SaaS, no rental, no unwanted data egress
- **declarative** - the yml is the source of truth, the container is
  derived from it; reproducible across machines
- **AI tools as first-class citizens** - coding agents land in the
  container as devcontainer features, not as an afterthought
- **container isolation by default** - everything runs in the Linux
  container, only a deliberately mounted workspace is exposed
- **your editor, not theirs** - the container is attached over plain
  SSH, so you're not locked into VS Code's proprietary container attach.
  `monoceros open` launches VS Code or VS Codium for you; JetBrains
  (IntelliJ, WebStorm, … via the Toolbox App) and a plain terminal
  attach to the same endpoint, with Zed to follow
  ([ADR 0022](docs/adr/0022-ssh-universal-ide-attach-point.md))

> **Looking for how to use it?** The full command reference, guides, and
> config docs live at **[getmonoceros.build/docs](https://getmonoceros.build/docs/)**.
> This README is the repo's front door: what Monoceros is, how to get
> started, and where to go next.

## What goes in a container

You compose a container from a curated catalog. Today that is:

- **Languages** - Node, Python, Java, Go, Rust, .NET
- **Services** - Postgres, pgvector, MySQL, MongoDB, Redis, Keycloak,
  Mailpit, RustFS
- **AI tools & CLIs** - Claude Code, OpenCode, Atlassian (Rovo Dev +
  Teamwork Graph), GitHub CLI, GitLab CLI

`monoceros list-components` prints the live catalog. New components
arrive over time. Anything pulled from your project's own package
manifest (Spring Boot, Django, Next.js, …) is a dependency and stays
out of the catalog by design - see
[ADR 0019](docs/adr/0019-component-taxonomy-service-feature-dependency.md).

## Requirements

- **Docker** - reachable as a daemon (Docker Desktop on macOS/Windows,
  Docker Engine on Linux)
- **Node ≥ 20** with `npm` - on macOS and Linux. On Windows, Node comes
  with Monoceros's managed WSL distro, so you don't install it yourself.
- **`curl`** (macOS/Linux) - only to invoke the install script
  (preinstalled on macOS; `sudo apt install curl` on Ubuntu)

The install script checks your prerequisites and prints platform-specific
guidance if something is missing. Full setup for macOS, Linux, and Windows
is on the
[requirements page](https://getmonoceros.build/docs/start/requirements/).

## Get started

On **macOS and Linux** (checks Docker + Node, installs `monoceros`
globally, sets up shell completion for bash/zsh):

```sh
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/install.sh | bash
```

On **Windows**, in PowerShell (creates the managed `monoceros` WSL distro,
enables Docker Desktop's WSL integration, adds the `monoceros` command -
you never configure WSL by hand):

```powershell
irm https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/install.ps1 | iex
```

Your first container:

```sh
monoceros init hello --with-languages=node --with-features=claude
monoceros apply hello
monoceros shell hello
```

`init` writes a yml profile to `~/.monoceros/container-configs/`; tokens
and defaults go in `~/.monoceros/monoceros-config.yml`. Full workflow
and every flag at
[getmonoceros.build/docs](https://getmonoceros.build/docs/).

**Were you handed a `<name>.yml`?** Drop it into
`~/.monoceros/container-configs/`, then `monoceros apply <name>` and
`monoceros shell <name>`.

> If `monoceros` isn't found right after install, your shell hasn't
> refreshed its PATH yet - the install script prints the one-liner for
> your shell (`rehash` for zsh, `hash -r` for bash).

## Layout of your `~/.monoceros/`

Created automatically on first use:

```
~/.monoceros/
├── monoceros-config.yml          ← global: git identity, default token, …
├── container-configs/
│   ├── <name>.yml                ← yml profile (init writes here)
│   └── <name>.env                ← secrets for ${VAR} references (gitignored)
└── container/
    └── <name>/                   ← materialized dev container
        ├── .devcontainer/        ← build recipe (apply rewrites it)
        ├── home/                 ← persistent tool state (login, .claude/, …)
        ├── data/                 ← service data (Postgres, MySQL, Redis)
        └── projects/             ← your code (add-repo clones here)
```

Updating or uninstalling the CLI **never** touches this path.

## Architecture

Monoceros ships as three independent release artifacts:

- **CLI** (`@getmonoceros/workbench` on npm) - what you install
- **Runtime image** (`ghcr.io/getmonoceros/monoceros-runtime`) - a thin,
  multi-arch layer over `mcr.microsoft.com/devcontainers/typescript-node`,
  pulled on the first `monoceros apply`
- **Features** (`ghcr.io/getmonoceros/monoceros-features/<name>`) - one
  devcontainer feature tag per AI tool or platform CLI, each with its own
  release cycle

Rationale:
[ADR 0004 - Release model](docs/adr/0004-release-modell-m4.md) and
[ADR 0005 - CLI distribution via npm](docs/adr/0005-cli-distribution-via-npm.md).

## Documentation

- **[getmonoceros.build/docs](https://getmonoceros.build/docs/)** - user
  docs: command reference, guides, config
- [`docs/concept.md`](docs/concept.md) - the story of the workbench: what
  Monoceros does and explicitly does not do
- [`docs/adr/`](docs/adr/) - architecture decisions

## Contributing

Want to work on the workbench itself? See
[`CONTRIBUTING.md`](CONTRIBUTING.md). Issues, PRs, and feature
suggestions: <https://github.com/getmonoceros/workbench>.

## License

Apache-2.0 - see [`LICENSE`](LICENSE).
