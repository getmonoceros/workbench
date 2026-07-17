# `@getmonoceros/workbench`

CLI for [Monoceros](https://github.com/getmonoceros/workbench) —
a workbench for local, reproducible dev containers with
AI coding tooling as first-class citizens (Claude Code, Atlassian
CLIs, GitHub CLI; more to come).

## Requirements

- **Docker** — reachable as a daemon, not just installed
- **Node ≥ 20** (with `npm`)

If you don't have one of these, you can't install Monoceros. The
install scripts (`install.sh`, `install.ps1`) in the repo root check
this up front and print platform-specific guidance.

## Installation

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/install.ps1 | iex
```

The script checks Docker + Node, installs the package globally via
`npm install -g`, and sets up shell completion for your shell.

## Getting started

```sh
monoceros init hello --with-languages=node --with-features=claude
# Add tokens / defaults to ~/.monoceros/monoceros-config.yml
monoceros apply hello
monoceros shell hello
```

Set up tab completion once:

```sh
monoceros completion zsh > ~/.oh-my-zsh/completions/_monoceros   # zsh
monoceros completion bash > ~/.bash_completion.d/monoceros       # bash
```

Full command reference at
[getmonoceros.build/docs](https://getmonoceros.build/docs/).

## License

Apache-2.0 - see `LICENSE`.
