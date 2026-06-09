# Monoceros

A **workbench for local, reproducible dev containers with AI-coding
tooling**. You describe in a yml profile what should live in the
container — language, services, AI tools, repos — and Monoceros
materializes it. Language- and stack-agnostic (Node, Python, Java,
Rust, Go, .NET all run).

How it differs from cloud Codespaces or Cursor Cloud:

- **local** — no SaaS, no rental, no unwanted data egress
- **declarative** — the yml is the source of truth, the container is
  derived from it; reproducible across machines
- **AI tools as first-class citizens** — Claude Code, Atlassian CLIs
  (Rovo Dev + Teamwork Graph), GitHub CLI are built-in devcontainer
  features; more to follow
- **container isolation by default** — everything runs in the Linux
  container, only a deliberately mounted workspace is exposed

## Requirements

- **Docker** — reachable as a daemon (Docker Desktop on macOS and
  Windows, Docker Engine on Linux)
- **Node ≥ 20** with `npm`
- **`curl`** — preinstalled on macOS; on Ubuntu Desktop/Server
  install via `sudo apt install curl`. Only needed to invoke the
  install script itself.

Docker + Node are checked by the install script; if one is missing it
tells you, with platform-specific guidance on where to get it. For the
Windows setup (WSL 2 + Docker Desktop, including the "Virtualization
support not detected" trap and the no-admin-rights path) see
[`docs/install-windows.md`](docs/install-windows.md); for Linux see
[`docs/docker-on-linux.md`](docs/docker-on-linux.md).

## Installation

Three paths, depending on what you're after.

### 1 — "I want to use Monoceros"

The install script checks Docker + Node, installs `monoceros`
globally via npm, and sets up shell completion for your shell (bash,
zsh):

```sh
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | bash
```

On Windows, Monoceros runs via WSL — see
[`docs/install-windows.md`](docs/install-windows.md) for the one-time
setup (WSL + Docker Desktop), after which the Linux path above applies
inside your WSL distro.

Continuing in the same terminal works as soon as the shell rebuilds
its PATH hash — zsh caches the startup PATH and only sees
newly-installed binaries after `rehash`:

```sh
rehash && compinit           # zsh
hash -r && source ~/.bashrc  # bash
```

This isn't Monoceros-specific but shell-standard for anything that
lands in an already-known PATH dir via `npm install -g`, `gem
install`, `cargo install` etc. The install script prints the matching
line at the end.

First container:

```sh
monoceros init hello --with-languages=node --with-features=claude
# enter tokens / defaults in ~/.monoceros/monoceros-config.yml
monoceros apply hello
monoceros shell hello
```

Full command reference at [getmonoceros.build/docs](https://getmonoceros.build/docs/).

When you first start `claude` in a project under `projects/` inside
the container, Claude Code asks once for approval of "external
CLAUDE.md file imports" — that's expected and safe. The imported files
(`AGENTS.md`, `.monoceros/commands.md`) are Monoceros-generated
briefings that describe the container stack to the AI tool. Accept,
and the briefing applies from the next response on. Details in
[`docs/ai-tools.md`](docs/ai-tools.md#container-briefing--agentsmd--claudemd).

The install script also sets up **tab completion**: it detects your
shell, places the completion script in the right spot and appends — if
not already present — the `fpath`/`source` lines to `.zshrc` /
`.bashrc` / `$PROFILE`. Idempotent.

Completed are the command name (`mono<TAB>` → `monoceros`), subcommands
(`monoceros <TAB>`) and container names from
`~/.monoceros/container-configs/` (e.g. `monoceros apply <TAB>`).
Details and manual re-installation in
[the completion reference](https://getmonoceros.build/docs/reference/utilities/completion/).

### 2 — "I'm developing on the workbench"

Clone, install, invoke the local CLI via `pnpm` (instead of the
globally installed `monoceros`):

```sh
git clone https://github.com/getmonoceros/workbench
cd workbench
pnpm install
pnpm cli init hello --with-languages=node --with-features=claude
pnpm cli apply hello
```

`pnpm cli` is a convenience wrapper around `tsx src/bin.ts` from
`packages/cli/`. Functionally identical to the globally installed
binary, but reads live from your checkout — changes take effect
immediately, no rebuild or reinstall needed.

If you also want to work on the runtime image or individual features
locally, see [`images/runtime/README.md`](images/runtime/README.md)
and [`images/features/README.md`](images/features/README.md). Both
describe the local build and how it's prioritized into `apply` via env
vars.

> **⚠️ Known issue — Traefik proxy with two homes.** As soon as you
> test with both `pnpm cli` (dev home `<checkout>/.local`) and a
> globally installed `monoceros` (prod home `~/.monoceros`), they
> collide on the machine-wide Traefik singleton `monoceros-proxy`.
> It's reused **by container name** — not per home and not per port.
> Whoever starts it first wins; the other context reuses the same
> container, which then watches the wrong `traefik/dynamic` directory
> → port routes return `404` (Traefik runs but doesn't know the
> route). A `routing.hostPort` change does **not** help as long as the
> container name is shared. Mitigation when switching context:
>
> ```sh
> docker rm -f monoceros-proxy   # then apply/add-port again in the new context
> ```
>
> Only affects developer machines with two homes; a normal builder has
> only `~/.monoceros` and never sees this.

### 3 — "I'm using an existing Monoceros solution"

A builder sent you a `<name>.yml`? Put it under
`~/.monoceros/container-configs/<name>.yml` (or
`%USERPROFILE%\.monoceros\container-configs\<name>.yml` on Windows)
and bring it up:

```sh
monoceros apply <name>
monoceros shell <name>
```

Prefer to curate the yml yourself? The individual fields are explained
in [the init reference](https://getmonoceros.build/docs/reference/lifecycle/init/), the available
components under
[`pnpm cli list-components`](https://getmonoceros.build/docs/reference/utilities/list-components/).

## Architecture

Monoceros is three independent release artifacts:

- **CLI** (`@getmonoceros/workbench` on npm) — this is what you
  install
- **Runtime image** (`ghcr.io/getmonoceros/monoceros-runtime`) — a
  thin layer over `mcr.microsoft.com/devcontainers/typescript-node`,
  multi-arch (linux/amd64 + linux/arm64), pulled by Docker on the
  first `monoceros apply`
- **Features** (`ghcr.io/getmonoceros/monoceros-features/<name>`) —
  one devcontainer feature tag per AI tool or platform CLI, each with
  its own release cycle

More details:
[ADR 0004 — Release model](docs/adr/0004-release-modell-m4.md) and
[ADR 0005 — CLI distribution via npm](docs/adr/0005-cli-distribution-via-npm.md).

## Layout of your `~/.monoceros/`

Created automatically on first use:

```
~/.monoceros/
├── monoceros-config.yml          ← global: git identity, default token, …
├── container-configs/
│   └── <name>.yml                ← yml profiles (init writes here)
└── container/
    └── <name>/                   ← materialized dev container
        ├── .devcontainer/        ← build recipe (apply rewrites it)
        ├── home/                 ← persistent tool state (login, .claude/, …)
        ├── projects/             ← your code (add-repo clones here)
        └── data/                 ← service data (Postgres, MySQL, Redis)
```

Updating or uninstalling the CLI **never** touches this path.

## Further docs

- [`docs/concept.md`](docs/concept.md) — the story of the workbench,
  what Monoceros does and explicitly does not do
- [getmonoceros.build/docs](https://getmonoceros.build/docs/) — user docs: command reference, guides, concepts
- [`docs/adr/`](docs/adr/) — architecture decisions

## Contributing

Issues, PRs, feature suggestions:
<https://github.com/getmonoceros/workbench>. For workbench
contributors, [`CLAUDE.md`](CLAUDE.md) is the first thing to read each
new session.

## License

MIT — see [`LICENSE`](LICENSE).

```

```
