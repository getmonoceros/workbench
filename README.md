# Monoceros

Eine **Werkbank für lokale, reproduzierbare Dev-Container mit
AI-Coding-Tooling**. Du beschreibst in einem yml-Profil, was im
Container liegen soll — Sprache, Services, AI-Tools, Repos — und
Monoceros materialisiert das. Sprach- und Stack-agnostisch (Node,
Python, Java, Rust, Go, .NET laufen alle).

Der Unterschied zu Cloud-Codespaces oder Cursor-Cloud:

- **lokal** — kein SaaS, kein Mietzwang, keine ungewollten
  Datenabflüsse
- **deklarativ** — das yml ist die Wahrheit, der Container leitet
  sich daraus ab; reproduzierbar zwischen Maschinen
- **AI-Tools als erstklassige Bürger** — Claude Code, Atlassian-CLIs
  (Rovo Dev + Teamwork Graph), GitHub CLI sind eingebaute
  Devcontainer-Features; weitere folgen
- **Container-Isolation als Default** — alles läuft im Linux-
  Container, nur ein bewusst gemounteter Workspace ist exponiert

## Voraussetzungen

- **Docker** — erreichbar als Daemon (Docker Desktop auf macOS und
  Windows, Docker Engine auf Linux)
- **Node ≥ 20** mit `npm`

Beide werden vom Install-Skript geprüft; fehlt eines, sagt's dir
mit plattform-spezifischer Anleitung wo du's holst.

## Installation

Drei Pfade, je nachdem was du vorhast.

### 1 — „Ich will Monoceros nutzen"

Das Install-Skript prüft Docker + Node, installiert `monoceros`
global via npm, und richtet die Shell-Completion für deine Shell
(bash, zsh oder PowerShell) ein:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
iwr -useb https://raw.githubusercontent.com/getmonoceros/workbench/main/install.ps1 | iex
```

Nach dem Skript einmal neues Terminal öffnen (oder `exec zsh` /
`source ~/.bashrc` / neue PowerShell-Session) — danach completed
`mono<TAB>` auf `monoceros`, `monoceros <TAB>` auf die Subcommands.

Erster Container:

```sh
monoceros init hello --with=node,claude
# Tokens / Defaults in ~/.monoceros/monoceros-config.yml eintragen
monoceros apply hello
monoceros shell hello
```

Volle Befehlsreferenz unter [`docs/commands/`](docs/commands/).

Die **Tab-Completion** richtet das Skript automatisch mit ein:
erkennt deine Shell, legt das Completion-Skript an passender Stelle
ab und hängt — falls noch nicht vorhanden — die `fpath`/`source`-
Zeilen in `.zshrc` / `.bashrc` / `$PROFILE`. Idempotent.

Completed werden der Befehlsname (`mono<TAB>` → `monoceros`),
Subcommands (`monoceros <TAB>`) und Container-Namen aus
`~/.monoceros/container-configs/` (z. B. `monoceros apply <TAB>`).
Details und manuelle Re-Installation in
[`docs/commands/completion.md`](docs/commands/completion.md).

### 2 — „Ich entwickle am Workbench"

Klonen, installieren, lokales CLI per `pnpm` aufrufen (statt global
installiertem `monoceros`):

```sh
git clone https://github.com/getmonoceros/workbench
cd workbench
pnpm install
pnpm cli init hello --with=node,claude
pnpm cli apply hello
```

`pnpm cli` ist ein Convenience-Wrapper auf `tsx src/bin.ts` aus
`packages/cli/`. Identisch zum global installierten Binary
funktional, aber liest live aus deinem Checkout — Änderungen
sofort wirksam, kein Re-Build oder Re-Install nötig.

Wenn du auch lokal das Runtime-Image oder einzelne Features
anfassen willst, siehe
[`images/runtime/README.md`](images/runtime/README.md) und
[`images/features/README.md`](images/features/README.md). Beide
beschreiben den lokalen Build und wie er via Env-Vars in `apply`
hochpriorisiert wird.

### 3 — „Ich nutze eine bestehende Monoceros-Solution"

Ein Builder hat dir ein `<name>.yml` geschickt? Lege es unter
`~/.monoceros/container-configs/<name>.yml` ab (bzw.
`%USERPROFILE%\.monoceros\container-configs\<name>.yml` auf
Windows) und fahr's los:

```sh
monoceros apply <name>
monoceros shell <name>
```

Lieber die yml selbst kuratieren? Die einzelnen Felder sind unter
[`docs/commands/init.md`](docs/commands/init.md) erklärt, die
verfügbaren Komponenten unter
[`pnpm cli list-components`](docs/commands/list-components.md).

## Architektur

Monoceros ist drei unabhängige Release-Artefakte:

- **CLI** (`@getmonoceros/workbench` auf npm) — das ist das, was du
  installierst
- **Runtime-Image** (`ghcr.io/getmonoceros/monoceros-runtime`) —
  schmale Schicht über `mcr.microsoft.com/devcontainers/typescript-node`,
  multi-arch (linux/amd64 + linux/arm64), wird beim ersten
  `monoceros apply` von Docker gezogen
- **Features** (`ghcr.io/getmonoceros/monoceros-features/<name>`) —
  pro AI-Tool oder Plattform-CLI ein eigener Devcontainer-Feature-
  Tag, jeder mit eigenem Release-Zyklus

Mehr Details:
[ADR 0004 — Release-Modell](docs/adr/0004-release-modell-m4.md) und
[ADR 0005 — CLI-Distribution via npm](docs/adr/0005-cli-distribution-via-npm.md).

## Layout deines `~/.monoceros/`

Wird beim ersten Aufruf automatisch angelegt:

```
~/.monoceros/
├── monoceros-config.yml          ← global: Git-Identität, Default-Token, …
├── container-configs/
│   └── <name>.yml                ← yml-Profile (init schreibt hier rein)
└── container/
    └── <name>/                   ← materialisierter Dev-Container
        ├── .devcontainer/        ← Build-Rezept (apply schreibt neu)
        ├── home/                 ← persistente Tool-States (Login, .claude/, …)
        ├── projects/             ← dein Code (add-repo klont hier rein)
        └── data/                 ← Service-Daten (Postgres, MySQL, Redis)
```

Update oder Deinstallation der CLI fasst diesen Pfad **niemals**
an.

## Weiterführende Doku

- [`docs/konzept.md`](docs/konzept.md) — die Story der Werkbank, was
  Monoceros macht und ausdrücklich nicht macht
- [`docs/backlog.md`](docs/backlog.md) — Roadmap und Milestone-Stand
- [`docs/commands/`](docs/commands/) — Detail-Seite pro CLI-Befehl
- [`docs/adr/`](docs/adr/) — Architekturentscheidungen
- [`docs/MIGRATION-M4.md`](docs/MIGRATION-M4.md) — Migrations-Hinweise
  für Bestandscontainer aus Pre-M4-Stand

## Mitmachen

Issues, PRs, Feature-Vorschläge: <https://github.com/getmonoceros/workbench>.
Für Workbench-Beitragende ist [`CLAUDE.md`](CLAUDE.md) der
Reset-Kontext, der für jede neue Session als erstes gelesen wird.

## Lizenz

MIT — siehe [`LICENSE`](LICENSE).
