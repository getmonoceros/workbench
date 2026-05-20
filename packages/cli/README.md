# `@getmonoceros/workbench`

CLI für [Monoceros](https://github.com/getmonoceros/workbench) —
eine Werkbank für lokale, reproduzierbare Dev-Container mit
AI-Coding-Tooling als erstklassige Bürger (Claude Code, Atlassian
CLIs, GitHub CLI; weitere folgen).

## Voraussetzungen

- **Docker** — erreichbar als Daemon, nicht nur installiert
- **Node ≥ 20** (mit `npm`)

Wer eines davon nicht hat, kann Monoceros nicht installieren. Die
Install-Skripte (`install.sh`, `install.ps1`) im Repo-Root prüfen
das vorab und geben plattform-spezifische Anleitung aus.

## Installation

```sh
npm install -g @getmonoceros/workbench
```

Oder über das Install-Skript:

```sh
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | sh
```

Windows: das passende `install.ps1` über PowerShell.

## Erste Schritte

```sh
monoceros init hello --with=node,claude
# Tokens / Defaults in ~/.monoceros/monoceros-config.yml eintragen
monoceros apply hello
monoceros shell hello
```

Tab-Completion einmalig einrichten:

```sh
monoceros completion zsh > ~/.oh-my-zsh/completions/_monoceros   # zsh
monoceros completion bash > ~/.bash_completion.d/monoceros       # bash
```

Volle Befehlsreferenz unter
[docs/commands/](https://github.com/getmonoceros/workbench/tree/main/docs/commands).

## Lizenz

MIT — siehe `LICENSE` im Repository-Root.
