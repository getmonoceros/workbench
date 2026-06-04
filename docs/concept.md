# Monoceros — Konzept

Was Monoceros ist, was es bewusst nicht ist, und wie die Werkbank
aufgebaut ist. Wenn du verstehen willst, wofür Monoceros gedacht ist
und wie die Teile zusammenspielen, bist du hier richtig. Die
konkreten Befehle stehen unter [`commands/`](./commands/), die
Architekturentscheidungen unter [`adr/`](./adr/).

## Die Positionierung

> **Monoceros ist eine Werkbank für lokale, reproduzierbare
> Dev-Container mit AI-Coding-Tooling. Builder beschreibt deklarativ
> was im Container liegen soll, Monoceros materialisiert das.
> Sprach- und Stack-agnostisch. Kein Cloud, kein SaaS, kein
> eingebauter Workflow-Zwang.**

Differenzierung gegenüber den naheliegenden Alternativen:

| Konkurrent         | Was sie anders machen                         | Was Monoceros besser kann                                                             |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| GitHub Codespaces  | Cloud-Only, Vendor-Lock-in, Kosten pro Stunde | Lokal, kein Mietzwang, Daten bleiben auf der Maschine                                 |
| Cursor Cloud       | Cloud-Workspace, fester Tooling-Stack         | Lokal, Tools sind eine Builder-Entscheidung                                           |
| Plain Devcontainer | Funktioniert; man baut alles selbst           | Wiederverwendbare yml-Profile, CLI-Boilerplate, kuratierte AI-Tool-Features           |
| Lokales Dev-Setup  | Voller Host-Zugriff für jedes Tool            | Container-Isolation: AI-Tools laufen in einem getrennten Linux, nicht auf deinem Host |

Die Dinge, die zusammen das Produkt machen:

1. **Deklaratives yml-Modell** — eine Datei beschreibt den Container,
   `monoceros apply` materialisiert ihn. Reproduzierbar zwischen
   Maschinen, versionierbar, diffbar.
2. **AI-Tools sind erstklassig** — Claude Code, OpenCode, Rovo Dev,
   Codex etc. landen als Devcontainer-Features im Container, vom
   Builder per yml ausgewählt.
3. **Container-Isolation als Default** — alles läuft in einem
   Linux-Container, nicht auf deinem Host. Ein bösartiges npm-Paket
   oder ein AI-Agent kommt nicht an deine `~/.ssh/`, deinen
   Browser-State oder Host-Dateien außerhalb des bewusst gemounteten
   Workspace.

## Die drei Bausteine

### 1. Werkbank-Runtime-Image

Lokales Docker-Image (Stand: `monoceros-runtime:dev`, später GHCR-
publiziert), aufgebaut auf
[`mcr.microsoft.com/devcontainers/typescript-node`](https://hub.docker.com/_/microsoft-vscode-devcontainers).
Inhalt:

- Debian Bookworm + Node 22 + pnpm + corepack
- `gosu` für sauberen User-Switch im Entrypoint
- Standard-Dev-Tools aus dem Base-Image: `git`, `curl`, `ssh`, `jq`,
  `make`

Ein opt-in Egress-Allowlist-Mechanismus (iptables-basiert, aktiviert
über `MONOCEROS_EGRESS=enforce`) liegt aus historischen Gründen noch
im Image, ist aber im Default-Workflow deaktiviert — die
Hostname-Snapshot-Variante ist mit rotierenden CDN-IPs (VS Code
Marketplace etc.) nicht kompatibel. Details in
[ADR 0002](./adr/0002-egress-whitelist-runtime-image.md). Sandboxing
ist heute **keine** beworbene Eigenschaft von Monoceros über die
normale Container-Isolation hinaus.

**Was nicht im Image liegt:**

- Keine AI-CLIs vorinstalliert. Claude Code, OpenCode, Rovo Dev,
  Codex etc. werden über Devcontainer-Features in den Container
  gezogen, nicht ins Image gebacken.
- Keine Sprach-Toolchains außer Node — Python, Java, Go etc.
  kommen ebenfalls über Features.

Dadurch bleibt das Image schlank und sprach-/tool-neutral. Der
Builder sieht im yml _explizit_ was im Container liegt.

### 2. Deklaratives yml-Modell

Eine Container-Konfig lebt unter
`$MONOCEROS_HOME/container-configs/<name>.yml`. Schema-validiert
(Zod), comment-preserving editierbar, mit klarem Lifecycle:

```yaml
schemaVersion: 1
name: sandbox

languages: [python]
services:
  - name: postgres
    image: postgres:18
    port: 5432
    env: # ${VAR} → aus sandbox.env; Dev-Defaults werden geseedet
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - data:/var/lib/postgresql
    restart: unless-stopped
    healthcheck:
      test:
        ['CMD', 'pg_isready', '-U', '${POSTGRES_USER}', '-d', '${POSTGRES_DB}']
      interval: 10s
      timeout: 5s
      retries: 5

features:
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
  - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1
    options:
      rovodev: true
      twg: true

repos:
  - url: https://github.com/your-org/api.git
```

`monoceros apply sandbox` materialisiert das nach
`$MONOCEROS_HOME/container/sandbox/` als Devcontainer mit allem
Drum und Dran. Ein zweiter Apply nach einer Edit überschreibt
deterministisch.

Container-Identity über die Konvention `<MONOCEROS_HOME>/container/<name>/`:
ein Konfig → ein Container, 1:1. cwd ist irrelevant; alle Befehle
funktionieren von überall mit `monoceros <command> <containername>`.

### 3. AI-Tools als Devcontainer-Features

Jedes AI-Tool ist ein Devcontainer-Feature unter
`ghcr.io/getmonoceros/monoceros-features/<tool>:1`. Builder wählt explizit
aus, was im Container liegt. Konsistenter mentaler Modell:

```yaml
features:
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
  - ref: ghcr.io/getmonoceros/monoceros-features/opencode:1
```

Geplanter Feature-Katalog:

| Feature       | Tool                                          | Status       |
| ------------- | --------------------------------------------- | ------------ |
| `claude-code` | Anthropic Claude Code CLI                     | erste Etappe |
| `atlassian`   | Atlassian-Stack — Rovo Dev (`acli`) + TWG-CLI | erste Etappe |
| `opencode`    | sst OpenCode (Multi-Model, OSS)               | Folge-Etappe |
| `codex`       | OpenAI Codex CLI                              | Folge-Etappe |
| `gh-copilot`  | GitHub Copilot CLI                            | Folge-Etappe |
| `aider`       | Aider (Python, OSS)                           | Folge-Etappe |

**Credentials für AI-Tools** werden direkt am Feature-Eintrag in der
Container-yml hinterlegt — dort, wo das Tool aktiviert wird:

```yaml
features:
  - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1
    options:
      email: you@example.com
      apiToken: ATATT3xFf… # Site/Instance fragt `acli rovodev run` einmalig selbst ab
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
    options:
      apiKey: sk-ant-… # optional → API-Modus statt OAuth/Subscription
```

Damit dieselben Atlassian/Anthropic-Daten nicht in jeder Container-yml
wiederholt werden müssen, hält `monoceros-config.yml` Defaults pro
Feature-Ref:

```yaml
defaults:
  features:
    ghcr.io/getmonoceros/monoceros-features/atlassian:1:
      email: you@example.com
      apiToken: ATATT3xFf…
```

`monoceros apply` merged Per-Container-Optionen über die globalen
Defaults — Container-yml gewinnt, fehlende Werte werden aus dem
globalen Block aufgefüllt.

**Der Container erklärt sich selbst.** Damit die AI-Tools wissen
welcher Stack tatsächlich im Container liegt (Sprachen, Services,
Feature-Tools), schreibt `monoceros apply` ein Briefing als `AGENTS.md`
mit `CLAUDE.md`-Import-Stub neben die `.code-workspace`-Datei im
Container-Workspace-Root. Claude Codes Walk-up vom Projekt-Verzeichnis
findet die Datei automatisch — keine Konfiguration pro Session nötig.
Eine Java-Werkbank erzählt Claude beim Start, dass sie Java liefert,
nicht Node. Details:
[ADR 0014](./adr/0014-ai-tool-briefing-im-workspace-root.md).

### Container-State überlebt apply

Jeder Container hat ein sichtbares Home-Verzeichnis auf der Host-Disk
unter `$MONOCEROS_HOME/container/<name>/home/`. Features deklarieren
über `x-monoceros.persistentHomePaths` welche Unterordner persistent
sein sollen (z.B. `.claude`, `.config/acli`). Beim Apply wird das als
Bind-Mount in die `devcontainer.json` eingetragen, sodass Login,
Session-History und tool-spezifischer State über `monoceros apply`
hinweg erhalten bleiben. Details: [ADR 0003](adr/0003-container-state-model.md).

## CLI-Shape

Alle Befehle folgen einem einheitlichen Schema:

```sh
monoceros <command> <containername> [<args> …]
```

Drei Familien:

```sh
# Konfig + Lifecycle
monoceros init <name> [--with-languages=… --with-features=… --with-services=… …]  # yml komponieren (oder dokumentierte Vorlage)
monoceros list-components                  # Komponenten-Katalog anzeigen
monoceros apply <name>                     # materialisieren + Container hochfahren
monoceros start|stop|status <name>         # Compose-Lifecycle
monoceros shell <name>                     # interaktive bash
monoceros run <name> -- <cmd>              # one-off-Befehl
monoceros logs <name> [<service>]          # tail
monoceros remove <name>                    # Container restlos abräumen (Backup default an)
monoceros restore <backup-path>            # Container aus Backup wiederherstellen

# Konfig editieren (yml-AST-Mutation, comment-preserving)
monoceros add-language|service|apt-packages|feature|from-url|repo <name> …
monoceros remove-… <name> …
```

cwd ist irrelevant — alles geht über Konvention.

## Code-Layout der Workbench

Die Workbench ist ein einziges Paket:

```
monoceros-workbench/
├── packages/
│   └── cli/                # die einzige Code-Komponente
├── images/
│   └── runtime/            # Dockerfile fürs Werkbank-Image
├── templates/
│   └── components/         # Komponenten-Katalog für `monoceros init --with-*`
└── docs/
```

## Was bewusst nicht ins Produkt gehört

- **Cloud-Hosting / SaaS-Variante** — gegen das Prinzip
  „dein Docker, deine Daten, kein Mietzwang"
- **Eigene Web-UI** — die CLI ist die UI, der Container-Workspace ist
  die Arbeitsumgebung
- **Eingebauter Iteration-Workflow** — `monoceros iterate` etc. sind
  raus, weil unklar war ob/wie sie Mehrwert über Claude Codes
  eigene Mechaniken liefern
- **Multi-User / Shared State** — jede:r Builder hat eigene
  Container-Configs unter `$MONOCEROS_HOME`. Synchronisation ist eine
  Frage von git-Repos und Team-Konventionen, nicht von Monoceros
- **Fixe Stack-Templates** (`vite-react-pg`, etc.) — die Vorlagen
  bleiben minimal; was im Container liegt, baut der Builder über
  `add-*`-Befehle oder Hand-Edits zusammen
- **Eigene Auth-Infrastruktur** — Bind-Mount von `~/.claude/` plus
  optional `monoceros-config.yml`-Defaults reichen
