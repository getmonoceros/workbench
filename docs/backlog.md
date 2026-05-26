# Monoceros Workbench — Backlog

Reihenfolge nach Milestones. Innerhalb eines Milestones sind die Tasks
in der Bauphase-Reihenfolge nummeriert. Erledigte Tasks bekommen ein
✅ vorgestellt und dürfen mit einem kurzen Hinweis auf das Ergebnis
ergänzt werden.

Konzeptioneller Überbau: [`konzept.md`](konzept.md).

## Überblick

| Milestone    | Inhalt                                                         | Status                    |
| ------------ | -------------------------------------------------------------- | ------------------------- |
| M0           | Bootstrap (pnpm-Workspace, Tooling)                            | ✅ 2026-05-10             |
| M1           | DevContainer-CLI (`create`, `shell`, `run`, Compose-Lifecycle) | ✅ 2026-05-11             |
| ~~M2~~       | Iteration-Pipeline + Plugin                                    | ❌ ausgelagert 2026-05-17 |
| M2.5         | yml-Profile-Modell (`init`/`apply <name>`, AST-Mutationen)     | ✅ 2026-05-17             |
| ~~M3 (alt)~~ | Externe Tracking-Adapter                                       | ❌ ausgelagert 2026-05-17 |
| **M3 (neu)** | AI-Tool-Feature-Library                                        | ✅ 2026-05-19             |
| M4           | Distribution / Go-Live                                         | 🚧 ab 2026-05-19          |
| M5           | Stabilisierung + Doku                                          | 🚧 ab 2026-05-23          |

---

## ✅ M0 — Bootstrap

**Ziel:** Das Repo ist arbeitsfähig — pnpm-Workspace, Linting,
Formatting, Husky, Basis-CI-Hygiene. **Abgeschlossen 2026-05-10.**

- ✅ pnpm-Workspace, TypeScript-Basis, Prettier + ESLint (Flat-Config),
  Husky + lint-staged, Vitest-Basis
- ✅ `.editorconfig` / `.gitignore` / `.gitattributes` aus älteren
  Archiven übernommen

CI-Skeleton (GitHub-Actions) ist live als `precheck.yml` (siehe
M4 Task 2). Zusätzlich drei Release-Workflows für Features,
Runtime-Image und CLI.

---

## ✅ M1 — DevContainer-CLI

**Ziel:** `monoceros create my-app` erzeugte einen lauffähigen
Devcontainer mit Linux + Docker + Claude Code, optionalen Services und
Sprach-Toolchains. **Abgeschlossen 2026-05-11.**

Tasks (historisch, alle erledigt):

- ✅ Default-Template + `monoceros create` (Image-Mode, Compose-Mode mit
  Postgres/MySQL/Redis)
- ✅ `monoceros shell` / `run` / `start` / `stop` / `down` / `status` /
  `logs`
- ✅ Runtime-Image-Setup (dünner Layer über Microsoft typescript-node).
  Eine opt-in iptables-Egress-Allowlist liegt aus historischen Gründen
  noch im Image, ist im Default-Workflow aber deaktiviert — siehe
  [ADR 0002](./adr/0002-egress-whitelist-runtime-image.md) für den
  vollständigen Hintergrund.
- ✅ `add-service` / `add-language` / `add-apt-packages` / `add-feature` /
  `add-from-url` / `add-repo` (alle imperativ, Diff-Preview,
  idempotent)
- ✅ Auth-Infrastruktur: SSH-Agent-Forwarding, HTTPS-Credential-Fetch
  pro Apply, Git-Identity-Persistierung

Bauplan-ADR: [`adr/0001-m1-bauplan-cli-zuerst.md`](./adr/0001-m1-bauplan-cli-zuerst.md).

---

## ❌ M2 — Iteration-Pipeline (ausgelagert)

War: Claude-Code-Plugin mit `/monoceros:iterate`/`findings`/`triage`/`defer`,
Plan/Generate/Review-Workflow, Side-Topic-Memory unter `.monoceros/`.

**Pivot 2026-05-17:** Die Iteration-Pipeline-Bausteine sind ausgelagert
nach [`../monoceros-iterate_archive-2026-05-17/`](../../monoceros-iterate_archive-2026-05-17/).
Die offenen Designfragen (autonomer Loop ja/nein, Side-Topic-Memory
wertvoll oder nicht, Tracking-Adapter sinnvoll?) bleiben dort und
werden erst beantwortet, wenn die Iteration als eigenständiges Projekt
neu aufgesetzt wird — möglicherweise auf Basis von Claude Code's
`/goal`-Mechanik.

Grund für die Auslagerung: die Werkbank-Roadmap an ungelösten
Designfragen festzunageln hätte einen zweiten Reset riskiert. Heute
fokussiert die Workbench auf den shippable Teil — Dev-Container plus
AI-Tooling.

---

## ✅ M2.5 — yml-Profile-Modell

**Ziel:** Die Container-Konfig liegt **außerhalb** des Dev-Container-
Verzeichnisses, ist wiederverwendbar, und alle Befehle folgen der Form
`monoceros <command> <containername>`. **Abgeschlossen 2026-05-17.**

Phasen (alle erledigt):

- ✅ **Phase 1** — Imperative `add-*`-Befehle + `apply`
- ✅ **Phase 2** — `monoceros create` mit `projects/`-Layout
- ✅ **Phase 3** — yml als externe Wahrheit:
  - ✅ Zod-Schema + comment-preserving yml-Reader/Writer
  - ✅ Initial-Templates: `bare`, `nodejs-github`, `python`, `reference`
  - ✅ `monoceros init <template> <name>` — Template kopieren, name
    rewriten
  - ✅ `monoceros apply <name>` — materialisiert nach
    `$MONOCEROS_HOME/container/<name>/`, kein cwd, kein path
  - ✅ `add-*` / `remove-*` editieren die yml, comment-preserving
  - ✅ `shell` / `run` / `start` / `stop` / `down` / `status` / `logs` mit
    `<containername>` positional
  - ✅ `monoceros-config.yml` für globale Defaults (heute: Git-Identity)
  - ✅ `monoceros create` retired — `init` + `apply` ersetzt es vollständig

CLI-Tests am Ende von M2.5: **124/124 grün.**

Auth-Mechanik aus M1 (SSH-Forwarding, HTTPS-Credentials-Fetch) blieb
intakt und wurde an das neue Modell angepasst.

---

## ❌ M3 (alt) — Externe Tracking-Adapter (ausgelagert)

War: Findings/Concerns/Risks aus der Iteration-Pipeline in GitHub
Issues / Jira / Linear / Notion spiegeln, Markdown bleibt Source of
Truth.

**Pivot 2026-05-17:** Mit dem Auslagern der Iteration-Pipeline (siehe
M2) verliert M3 sein Subjekt. `packages/adapter-local/` ist im Archiv;
die Adapter-Pakete `adapter-github`/`-jira`/`-linear`/`-notion` wurden
nie gebaut.

Falls die Iteration-Pipeline später als eigenes Projekt zurückkommt,
gehört M3 dort hin, nicht in die Werkbank.

---

## ✅ M3 (neu) — AI-Tool-Feature-Library

**Ziel:** AI-Tools sind erstklassige Bürger in der Container-yml.
Builder schreibt `features: [- ref: …/claude-code:1]` und kriegt das
Tool sauber installiert. Eigene Feature-Library unter
`ghcr.io/getmonoceros/monoceros-features/<tool>:1`.

### Voraussetzung

- Konzept klar (siehe `konzept.md`, „Die drei Bausteine" → AI-Tools)
- Runtime-Image abgerüstet: Claude Code raus aus dem Image (heute
  noch drin), wird Feature

### Tasks

1. **Feature-Library-Verzeichnis** — Layout unter `images/features/<tool>/`
   mit `devcontainer-feature.json` + `install.sh`. Publish-Pipeline
   skizzieren (anfangs manuell via `devcontainer features publish`,
   später GH Action). _(erledigt)_

2. **Feature `claude-code`** — installiert `@anthropic-ai/claude-code`
   via npm global. Options:
   - `version: 'latest' | <semver>` (Default `latest`)
   - `apiKey: '<sk-ant-…>'` (optional) → schreibt
     `ANTHROPIC_API_KEY` per `/etc/profile.d/` → Claude Code im
     API-Modus statt OAuth/Subscription
   - State (Login, Sessions, Skills) unter `home/.claude/` via
     `x-monoceros.persistentHomePaths`. _(erledigt)_

3. **Runtime-Image abrüsten** — `npm install -g @anthropic-ai/claude-code`
   aus dem Dockerfile entfernen. Image-Rebuild. Alle bestehenden
   Templates ergänzen um `features: [- ref: …/claude-code:1]`. _(erledigt)_

4. **Container-State-Modell** — pro Container ein eigenes
   `home/`-Verzeichnis unter `<container-dir>/home/`, bind-gemountet
   nach `/home/node/` für die in `x-monoceros.persistentHomePaths`
   genannten Subpfade. Apply lässt `home/` und `projects/` bei
   re-Apply unangetastet. `.gitignore` am Container-Root schließt
   `/home/` und `/.monoceros/` aus. Siehe
   [ADR 0003](adr/0003-container-state-model.md). _(erledigt)_

5. **Feature `atlassian`** — installiert `acli` (mit Rovo Dev Agent)
   und/oder `twg` (Teamwork Graph CLI) als gebündeltes Feature, weil
   beide Tools denselben Atlassian-Account nutzen.
   Options:
   - `rovodev` (boolean, Default `true`) — installiert acli + dropt
     Post-Create-Hook `atlassian-rovodev.sh` ab, der bei gesetztem
     `email`/`apiToken` non-interaktiv einloggt. Hook re-läuft bei
     jedem Apply, damit Token-Rotation in der yml propagiert. Die
     Site fragt `acli rovodev run` beim ersten Lauf selbst ab.
   - `twg` (boolean, Default `true`) — installiert twg via
     official-install-Script (mit Flags
     `--install-dir /usr/local/bin --skip-login --skip-skills`,
     Consent via Heredoc). Dropt Post-Create-Hook
     `atlassian-twg.sh` ab, der via
     `TWG_USER` / `TWG_SITE` / `TWG_TOKEN` / `TWG_BBC_TOKEN` und
     `twg login --force` einloggt und danach
     `twg skills install --global --yes` ausführt.
   - `instance`, `email`, `apiToken` — geteilte Credentials für
     beide Tools.
   - `bitbucketToken` — optional, nur für twg's Bitbucket-Pfad.
   - State unter `home/.config/acli/`, `home/.rovodev/`,
     `home/.config/twg/`, `home/.agents/` via
     `x-monoceros.persistentHomePaths`.
   - VS-Code-Extension `Atlassian.atlascode` über
     `customizations.vscode.extensions`. _(erledigt)_

5b. **Feature `github-cli`** — installiert die offizielle GitHub
CLI (`gh`) aus dem Upstream-apt-Repo und automatisiert den
Login.
Options:

- `apiToken` (string, optional) — GitHub Personal Access Token.
  Wenn gesetzt, schreibt das install.sh ein
  `/etc/profile.d/github-cli.sh` mit `export GH_TOKEN=…` →
  `gh` ist in jeder Login-Shell automatisch authentifiziert,
  kein expliziter `gh auth login`-Schritt nötig. Name `apiToken`
  bewusst konsistent mit dem atlassian-Feature.
- State unter `home/.config/gh/` via
  `x-monoceros.persistentHomePaths`, damit ein optionales
  interaktives `gh auth login` (SSH-Key-Upload, Protocol-Switch)
  über apply hinweg erhalten bleibt.
- VS-Code-Extension `github.vscode-pull-request-github` über
  `customizations.vscode.extensions`. _(erledigt)_

6. **`monoceros-config.yml`-Schema erweitern** — neuer Block
   `defaults.features: Record<ref, Record<option, value>>` mit
   Zod-Validierung; Apply merged Per-Container-Optionen über die
   globalen Defaults (Per-Container gewinnt). _(erledigt)_

7. **Post-Create-Hook-Mechanik im Scaffold** — generierte
   `post-create.sh` ruft alle Skripte unter
   `/usr/local/share/monoceros/post-create.d/*.sh` in lexikographischer
   Reihenfolge auf. Damit kann jedes Feature seinen eigenen
   First-Run-Login einbringen, ohne dass der Scaffold feature-Wissen
   braucht. _(erledigt)_

8. **Init-Komponentenmodell** — Templates (`bare`, `nodejs-github`,
   `python`, `reference`) sind komplett rausgenommen; stattdessen
   gibt es einen Komponenten-Katalog unter
   `templates/components/` (eine yaml pro Sprache / Service /
   Feature mit `displayName` + `description` + `category` +
   `contributes`). `monoceros init <name> --with=node,…` komponiert
   die Komponenten zu einer fertigen yml; `monoceros init <name>`
   ohne `--with` schreibt eine dokumentierte Vorlage. Boolean-
   Options aus mehreren Komponenten mergen per OR (`true` gewinnt),
   damit Sub-Komponenten wie `atlassian/twg` allein opt-out für
   `rovodev` machen können, kombiniert aber beide einschalten.
   Feature-Optionen mit Auth-Bezug werden über
   `x-monoceros.optionHints` im Feature-Manifest deklariert und
   tauchen kommentiert unter der `options:`-Zeile auf. Plus neuer
   Befehl `monoceros list-components` als Discovery-Hilfe.
   _(erledigt)_

9. **Doku** — `docs/commands/init.md` neu geschrieben gegen das
   `--with`-Modell; `docs/commands/list-components.md` ergänzt;
   `docs/ai-tools.md` als Library-Übersicht + Cookbook für neue
   Tool-Features. Alle vorher noch mit `_TODO_` markierten
   command-Docs (`shell`, `run`, `start`, `stop`, `status`,
   `logs`, `add-language`, `add-service`) sind ausgefüllt.
   `CLAUDE.md` und `docs/konzept.md` zeigen die neuen CLI-Shapes.
   _(erledigt)_

10. **Tests** — Schema-Tests für die neuen Config-Felder + Apply-
    Verhalten (defaults.features-Merge, .gitignore, persistente
    Home-Pfade + -Files inkl. Seed-Content) sind in
    `apply-yml.test.ts` / `global-config.test.ts` ergänzt. Plus
    Tests für Komponenten-Reader/-Merge in `components.test.ts`,
    für beide Init-Modi in `init.test.ts`, für `remove`/`restore`,
    und für den Secret-Masker (`mask-secrets.test.ts`). 170/170
    Tests grün. Stage C des Test-Plans für den „Feature im
    Container materialisiert sich"-Pfad ist auf M5 verschoben.
    _(erledigt, Stage-C-Update als M5-Task umgehängt)_

### Zusätzliche Arbeiten die im Verlauf von M3 dazukamen

Diese waren nicht im Original-M3-Plan, fielen aber während der
Iterationen als notwendig auf und sind alle live:

- **`monoceros remove <name>`** — restloses Abräumen (Docker-
  Objekte + yml + Container-Dir), Backup default an, `--no-backup`
  zum Skippen, `-y` für Scripts. Ersetzt den nicht mehr sinnvollen
  `down`-Befehl, der raus ist.
- **`monoceros restore <backup-path>`** — Inverse zu remove. Plain
  Filesystem-Operation, kein Docker-Touch. Anschließend
  `monoceros apply` weckt den Container.
- **Compose-Service-Daten als Bind-Mount unter
  `container/<name>/data/<svc>/`** — Named Volumes raus, DB-Daten
  liegen auf der Host-Disk und sind teil eines Backups bzw.
  Removals (siehe ADR 0003 Update).
- **Secret-Masking auf Build-Output-Streams** — Atlassian/GitHub/
  Anthropic-Token-Shapes werden in apply/start-Logs als
  `ATATT…abcdef` maskiert. Dev-Konventionspasswörter
  (postgres/mysql `monoceros`) bewusst NICHT.
- **`--with=<lang>:<version>`-Syntax** — `java:17`, `node:20`
  werden an die upstream-Devcontainer-Features als `version`-
  Option durchgereicht. `node` ohne Version bleibt Built-in.
- **Custom Help-Renderer** — `monoceros <cmd> --help` zeigt
  `<NAME> [OPTIONS]` statt der citty-Default-Reihenfolge.

### Bewusst nicht in M3

- Weitere AI-Tools (OpenCode, Codex, GitHub Copilot, Aider) — kommen
  später in einer eigenen Etappe, jeweils mit demselben Muster wie
  `claude-code`
- VS-Code-Server / browser-IDE als Feature — siehe „Vorgemerkt für
  später"
- `monoceros duplicate <a> <b>` — Klon-Befehl für Container, der
  `home/` mitkopiert (Login bleibt erhalten) aber `projects/` und
  `.devcontainer/` zurücksetzt. Idee aus dem M3-Designgespräch,
  vorgemerkt für später

### Definition of Done

- ✅ `monoceros init sandbox --with=claude,github,atlassian/rovodev`
  gefolgt von `monoceros apply sandbox` installiert die genannten
  Tools als Features (nicht aus dem Image), inkl. Auto-Login via
  Container-yml-Optionen oder `monoceros-config.yml`-Defaults.
- ✅ Container-Login (Claude, Rovo Dev, twg, gh) überlebt
  `monoceros apply`, Token-Rotation in der yml propagiert
  automatisch.
- ✅ Compose-Service-Daten (postgres, mysql, redis) liegen
  bind-gemountet unter `container/<name>/data/<svc>/` auf der
  Host-Disk und sind teil von remove-Backups.
- ✅ `monoceros remove` + `restore` decken den Lifecycle-Endpoint
  ab, Backup default an.
- ✅ Secret-Masking in apply/start-Output verhindert dass echte
  Tokens auf dem Terminal landen.

Der GHCR-Publish der Feature-Library war ursprünglich in der M3-DoD
mitgeführt, gehört aber sauber in M4 (Distribution). Heute reicht
die Local-Source-Auflösung im Scaffold — jeder Workbench-Checkout
findet die Features unter `images/features/<name>/`. Externe Builder
ohne Checkout kriegen sie mit M4 Task 2 über GHCR.

---

## 🔜 M4 — Distribution / Go-Live

**Ziel:** Die Workbench wird benutzbar **ohne** dass der Builder das
Workbench-Repo selbst klont.

Architekturentscheid für M4 steht in
[ADR 0004 — Release-Modell: N unabhängige Deployments, Version-getriggert](./adr/0004-release-modell-m4.md).
Kernpunkte: drei Artefakt-Typen (CLI, Runtime-Image, Feature), heute
fünf Deployments und wachsend, version-getriggerte Pipelines (Bump
einer Versionsnummer im jeweiligen Manifest = Release), keine
Staging-Umgebung, Windows als gleichwertige Zielplattform.
Builder, die mit bestehenden Containern auf den neuen Namespace
umziehen, finden in [`docs/MIGRATION-M4.md`](./MIGRATION-M4.md) das
sed-Snippet und den Hinweis auf die Apply-Warnung.
[`docs/m4-brief.md`](./m4-brief.md) ist mit ADR 0004 **superseded**
und liegt nur noch als historische Hand-Over-Notiz vom 2026-05-19
auf der Platte; gilt nicht mehr als operativ.

### Tasks

1. **Code & Docs auf `getmonoceros` umstellen** — Feature-Refs,
   Paket-Name, Templates, Tests, Docs. Plus Migration-Hint im
   Apply für alte Refs und
   [`docs/MIGRATION-M4.md`](./MIGRATION-M4.md) für bestehende
   yml's. _(erledigt 2026-05-19, 171/171 Tests grün.)_

2. **Precheck-Workflow (`precheck.yml`)** — GitHub-Actions mit
   lint + typecheck + vitest bei jedem PR und Push auf `main`.
   Source-Hygiene, kein Build, keine Integration. Ist
   Voraussetzung für alle weiteren Tasks und ersetzt zusammen mit
   der SemVer-Pre-Release-Konvention die „Staging-Umgebung", die
   wir bewusst nicht bauen (siehe ADR 0004). _(erledigt 2026-05-20.)_

3. **Features-Release-Workflow (`release-features.yml`)** —
   Pfad-Trigger `images/features/**`, iteriert über alle
   Unterordner mit `devcontainer-feature.json`, publisht jedes
   Feature dessen Version noch nicht in GHCR liegt. Generisch über
   N Features, neue Features brauchen keine Workflow-Änderung.
   Auth via `GITHUB_TOKEN` mit `packages: write`.
   _(erledigt 2026-05-20; alle drei Features (`claude-code:1.1.0`,
   `atlassian:1.0.0`, `github-cli:1.0.0`) liegen auf GHCR und sind
   public.)_

4. **Runtime-Image-Release-Workflow (`release-runtime.yml`)** —
   `images/runtime/VERSION`-Datei einführen, Pfad-Trigger
   `images/runtime/**`, multi-arch (amd64 + arm64) Buildx-Push
   nach `ghcr.io/getmonoceros/monoceros-runtime:<version>` + `:<major>`.
   `BASE_IMAGE` in `create/catalog.ts` von `monoceros-runtime:dev`
   auf den GHCR-Tag umstellen, plus optionalem
   `MONOCEROS_BASE_IMAGE_OVERRIDE` für Contributors am Image.
   _(erledigt 2026-05-20; `monoceros-runtime:1.0.0` multi-arch
   live, BASE_IMAGE zeigt auf den floating major tag `:1`.)_

5. **CLI-Release-Workflow (`release-cli.yml`) + Install-Skripte** —
   nach [ADR 0005](./adr/0005-cli-distribution-via-npm.md):
   Pfad-Trigger `packages/cli/**`, liest Version aus
   `packages/cli/package.json`, vergleicht gegen die npm-Registry,
   bei neu `npm publish --access public`. Plus `install.sh`
   (macOS/Linux) und `install.ps1` (Windows) im Repo-Root als
   Bouncer: prüft `docker info` + `node --version` (≥ 20), gibt
   bei fehlender Voraussetzung plattform-spezifische
   Installations-Hinweise (System-Pakete + Per-User-Manager) +
   exit 1, sonst `npm install -g @getmonoceros/workbench`.
   Auth via **npm Trusted Publishing** (OIDC) — kein Secret im Repo.
   Bootstrap-Sequenz: erst lokal `npm login` + `npm publish` für
   den ersten Publish (claimt den Scope), dann Trusted Publisher
   auf <https://www.npmjs.com/package/@getmonoceros/workbench/access>
   konfigurieren (Org `getmonoceros`, Repo `workbench`, Workflow
   `release-cli.yml`). Folge-Releases laufen vollautomatisch über
   den Workflow.
   `packages/cli/package.json` braucht Publish-Setup (`private`
   raus, `description`, `repository`, `homepage`, `license`,
   `files`, `bin`, `prepublishOnly`, tsup-Build auf `dist/`).
   _(erledigt 2026-05-20; `@getmonoceros/workbench@1.0.0` Bootstrap
   lokal, ab `1.0.1` via OIDC-Workflow. Aktueller Stand npm:
   `1.4.1` mit allen UX-Iterationen aus 2026-05-20/21.)_

6. **`MONOCEROS_HOME`-Default schärfen** — sicherstellen, dass ein
   per Install-Skript installiertes Tool out-of-the-box auf
   `~/.monoceros/` (bzw. `%USERPROFILE%\.monoceros\` auf Windows)
   landet und das Layout bei Bedarf beim ersten Aufruf automatisch
   angelegt wird. _(verifiziert 2026-05-20 via Sandbox-Install des
   gerade publishten `@getmonoceros/workbench@1.0.1` in einer
   frischen tempdir mit `MONOCEROS_HOME` auf eine andere tempdir —
   `init` legt das Layout selbst an, kein Workbench-Checkout im
   Pfad nötig.)_

7. **Install-Doku im Workbench-Root** — `README.md` mit drei
   Pfaden für „Ich will nutzen / Ich entwickle / Ich nutze eine
   bestehende Solution". _(erledigt 2026-05-20.)_

8. **`pnpm cli`-Notiz** — README erwähnt, dass `pnpm cli`
   weiterhin Dev-Convenience für Contributors ist, neben dem
   global installierten `monoceros`-Binary. _(erledigt 2026-05-20
   als Teil von Task 7.)_

9. **End-to-End-Walkthrough von außen** — auf einer frischen VM
   oder zweitem Rechner: Install via `install.sh` oder
   `install.ps1` →
   `monoceros init hello --with=node,postgres,claude` →
   `monoceros-config.yml` mit Claude-API-Key füllen →
   `monoceros apply hello` → `monoceros shell hello` und Claude
   tippen lassen. Wenn das ohne Checkout durchläuft, ist M4
   durch.
   - **macOS** ✅ — Maintainer-Mac, mehrere Iterationen über
     1.0.0 → 1.4.1.
   - **Linux** ✅ — Ubuntu 24.04 LTS Desktop ARM in Parallels auf
     M4 Max, 2026-05-22. Walkthrough komplett durch
     (install.sh → init → apply → shell → Claude im Container).
     Sieben signifikante Funde unterwegs entdeckt + gefixt, alle
     in 1.5.x ausgeliefert:
     1. `install.sh` shebang wird bei `| sh` ignoriert →
        `set -o pipefail` crasht auf dash. Bash-Check + README-
        Korrektur auf `| bash`. ([2b3cf0e](https://github.com/getmonoceros/workbench/commit/2b3cf0e))
     2. `curl` ist auf Ubuntu Desktop nicht vorinstalliert →
        Prereq-Hinweis ergänzt. ([2b3cf0e](https://github.com/getmonoceros/workbench/commit/2b3cf0e))
     3. Docker-Hint enthielt `apt/dnf/pacman install …` als
        unausführbare Sketch-Zeile → in copy-paste-fähige
        Per-Distro-Zeilen aufgeteilt, später auf den Convenience-
        Script-Oneliner getrimmt. ([45fbb2f](https://github.com/getmonoceros/workbench/commit/45fbb2f), [575293e](https://github.com/getmonoceros/workbench/commit/575293e), [733011e](https://github.com/getmonoceros/workbench/commit/733011e))
     4. Prereq-Hints zeigten macOS + Linux gemischt → OS-Detection
        via `uname -s`, getrennte Blöcke. Auch der versteckte
        Node-Hint-Bug („`apt install nodejs npm`" gibt auf
        Ubuntu 24.04 nur Node 18) auf NodeSource umgestellt. ([de046e0](https://github.com/getmonoceros/workbench/commit/de046e0), [c440cf7](https://github.com/getmonoceros/workbench/commit/c440cf7), [0982964](https://github.com/getmonoceros/workbench/commit/0982964))
     5. `npm install -g` brauchte sudo, weil NodeSource Node als
        root installiert → install.sh routet jetzt automatisch
        auf einen per-User-Prefix unter `~/.local` (mit `--prefix`,
        nicht `npm config set prefix` — andere Tools bleiben
        unbeeinflusst). ([81c34ac](https://github.com/getmonoceros/workbench/commit/81c34ac))
     6. `monoceros-config.yml` wurde auf Linux gar nicht ausgeliefert
        (`npm root -g` zeigt System-Prefix, wir installierten zu
        `~/.local`) + die alte Sample-File hatte aktive
        Placeholder-Werte mit Footgun-Potential. Ship direkt als
        `monoceros-config.yml`, alles auskommentiert, `defaults`
        akzeptiert `null` damit das Template eine zusammenhängende
        Bearbeitung erlaubt. ([8ae2d7a](https://github.com/getmonoceros/workbench/commit/8ae2d7a), [fb5e5da](https://github.com/getmonoceros/workbench/commit/fb5e5da))
     7. `monoceros remove` ließ Image-Mode-Container als Zombies
        zurück — `@devcontainers/cli` lässt Docker zufällige Namen
        vergeben (`kind_cerf`, `thirsty_bartik`), unser Name-Filter
        ging ins Leere. Vierter Filter über
        `label=devcontainer.local_folder=<containerPath>` ergänzt. ([f409d9d](https://github.com/getmonoceros/workbench/commit/f409d9d))
   - **Windows** ⏸ — aktuell **nicht testbar**. Apple-Silicon-
     Parallels supportet nested virtualization für Windows-ARM-
     Gäste nicht (offiziell von Parallels bestätigt: [KB 129234](https://kb.parallels.com/129234),
     [KB 129497](https://kb.parallels.com/129497)). Docker Desktop in der
     Windows-VM kann darum WSL2 nicht hochfahren, der eigentliche
     `apply`-Pfad ist von dort aus unerreichbar. Cloud-Windows-VMs
     (Azure Dsv5, AWS m6i) wären ein Ausweg, sind aber an Lizenz-/
     Kosten-Fragen geknüpft, die noch offen sind. Bis eine Lösung
     gefunden ist, bleibt der Windows-Walkthrough ungetestet — das
     `install.ps1`-Rendering wurde immerhin verifiziert (zwei
     Render-Bugs gefunden + gefixt: exit-in-iex killt Host, UTF-8-
     Glyphen kaputt unter PowerShell 5.1 / conhost — [c88e95d](https://github.com/getmonoceros/workbench/commit/c88e95d),
     [994ad34](https://github.com/getmonoceros/workbench/commit/994ad34)), aber der echte `apply hello`-Lauf steht aus.

### Zusätzliche Arbeiten die während M4 dazukamen

Nicht im Original-Plan, fielen während Stage E auf und sind alle
live in den 1.x-Releases:

- **Custom Help-Renderer mit Gruppen** — die 23 Subcommands sind nach
  Kategorie gruppiert (Container lifecycle / Run + inspect / Edit
  container yml / Tooling), Beschreibungen wrappen auf Terminal-
  Breite, USAGE-Zeile zeigt `<command>`-Platzhalter statt
  Pipe-Liste. ANSI-Palette via neuer `util/format.ts`.
- **Shell-Completion** für bash, zsh, PowerShell. `monoceros
completion <shell>` druckt das Skript; Completion versteht
  Subcommand-Namen + Container-Namen aus
  `$MONOCEROS_HOME/container-configs/`. Install-Skripte richten
  die Completion automatisch ein (OMZ/vanilla zsh, bash, pwsh).
- **Strukturierte Installer-Ausgabe** — `install.sh` und
  `install.ps1` rendern vier Sektionen (Prerequisites / Installing
  CLI / Shell completion / User home / Next steps) mit konsistenter
  Cyan/Grey/Bold-Palette. `npm install -g --silent` ausgeblendet,
  eigene `monoceros <version> → <path>` Bestätigungszeile.
- **Strukturierte Apply-Ausgabe** — vier Sektionen (Configuration
  / Scaffold / Container / Next steps) mit denselben visuellen
  Markern wie Installer. Pre-Announce der Features vor dem
  devcontainer-cli-Stream, dim-grauer Hinweis auf den ~1–2-min
  First-Apply-Pull, finaler `monoceros shell <name>`-Hinweis.
- **`prettyPath`-Helper** — alle Lifecycle-Ausgaben (init / apply
  / remove / restore) zeigen `~/.monoceros/...` statt
  Relativ- oder Voll-Pfaden.
- **Manifest-Hints im Init-Output** — beim `init --with=…` werden
  Option-Beschreibungen und `x-monoceros.usageNotes` aus den
  Feature-Manifesten als Kommentar-Blöcke in die generierte yml
  eingesetzt. Manifeste werden via `pnpm manifests:sync` als
  prebuild-Step mit dem npm-Tarball ausgeliefert; in Prod liegen
  sie unter `<workbenchRoot>/features/<name>/`.
- **User-Home-Setup im Installer** — install.sh / install.ps1
  legen `~/.monoceros/` an und kopieren
  `monoceros-config.sample.yml` aus dem npm-Paket dorthin
  (no-clobber). Sample erklärt das Schema für Git-Identität +
  Feature-Defaults; reale `monoceros-config.yml` bleibt
  User-Verantwortung.

### Bewusst nicht in M4

- Eigene Web-UI / Hub
- Multi-User-Hosting
- Cloud-Variante
- Staging-Umgebung (siehe ADR 0004 — wird durch Precheck +
  SemVer-Pre-Release-Konvention ersetzt)
- Brew-Tap, WinGet-Manifest, Scoop-Bucket (Wrapper über die
  GitHub-Releases — kommen später falls echte Nachfrage)
- Auto-Update der installierten CLI

### Definition of Done

- ✅ Ein Builder ohne Workbench-Checkout kann sich Monoceros über
  `install.sh` (Unix) oder `install.ps1` (Windows) installieren
  und mit `monoceros init hello --with=claude && monoceros apply hello`
  einen Container hochfahren — Runtime-Image **und** Features
  werden aus GHCR gezogen, keine lokalen `images/...`-Files nötig
- ✅ `ghcr.io/getmonoceros/monoceros-features/{claude-code,atlassian,github-cli}`
  via `docker pull` / `devcontainer features info` von außen
  erreichbar
- ✅ Stage-E-Walkthrough von außen (Test-Plan) auf macOS, Linux und
  Windows durchgespielt
- ✅ README erklärt, was Monoceros ist und wie man's installiert

---

## 🚧 M5 — Stabilisierung + Doku

**Ziel:** Was M2.5 + M3 + M4 geliefert haben, ist robust und gut
beschrieben.

### Tasks (Skizze)

Reihenfolge ist absichtlich Features-zuerst-Doku-danach: Test-Plan,
AI-Library und Command-Doku kommen NACH den drei neuen CLI-
Oberflächen (init --with-repo, add-port, tunnel), damit Doku und
Tests die finale Surface abdecken und nicht zwischenzeitliche
Zustände dokumentieren.

1. ✅ **`init --with-repo` — Repo direkt in init reinziehen** —
   erledigt 2026-05-23, ausgeliefert in 1.6.x. Im Verlauf deutlich
   über das Original-Scope erweitert (siehe Abschnitt
   „Zusätzliche Arbeiten" weiter unten):
   - `--with-repo=<url>` wiederholbar, akzeptiert nur kanonische
     Hosts (github.com / gitlab.com / bitbucket.org); andere Hosts
     müssen über `monoceros add-repo --provider=…` rein
   - Branch-Suffix aus der URL gedroppt — `git checkout` im Container
     ist der richtige Hebel, nicht ein yml-Feld
   - `add-repo` neu strukturiert: `--path` (mit Subfolder-Support)
     statt `--as`, `--git-name`/`--git-email` als Pair für per-Repo
     Identität, `--provider`-Flag
   - Schema-Umbau: `repos[].name` → `repos[].path`, `branch`
     entfernt, neues `provider`-Feld, neues `git.user`-Override pro
     Repo
   - HTTPS-only festgeklopft via [ADR 0006](./adr/0006-https-only-repo-auth.md);
     SSH-Code komplett raus
   - Offene Frage „Duplikat-Behandlung" durch C (Idempotenz)
     materialisiert: gleicher URL + gleicher Path → no-op,
     unterschiedlicher Path → zweiter Eintrag (zwei Klone), gleicher
     Path + andere URL → Validierungsfehler beim Apply

2. ✅ **`add-port` / Port-Management via Reverse-Proxy mit
   Hostname-Routing** — erledigt 2026-05-25, ausgeliefert in 1.7.x.
   Designentscheidung in
   [ADR 0007](./adr/0007-port-management-traefik.md): Singleton-Traefik
   im Docker-Network `monoceros-proxy`, Hostname-Routing über
   `*.localhost` (RFC 6761), Hot-Reload via File-Provider unter
   `$MONOCEROS_HOME/traefik/dynamic/<name>.yml`.

   **Was live ist** (1.7.0):
   - Schema umgebaut zu einem `routing:`-Block (`routing.ports`,
     `routing.vscodeAutoForward`); `ide.vscodeAutoForwardPorts` aus
     früherem Zwischenstand verworfen zugunsten der konsolidierten
     Struktur.
   - `monoceros-config.yml` erweitert um `routing.hostPort`
     (Default 80, konfigurierbar wenn 80 dauerhaft belegt ist).
   - Neuer Modul-Block `proxy/` mit `ensureProxy()`,
     `maybeStopProxy()`, `writeDynamicConfig()`, `removeDynamicConfig()`,
     `proxyUrlsFor()`.
   - Pre-Flight-Port-Check (`proxy/port-check.ts`) vor `apply`/
     `start`/`add-port`: erkennt belegten Host-Port (oder Traefik
     selbst als Halter), gibt im Konflikt-Fall einen klaren
     Hint und bricht ab.
   - Neue Befehle: `add-port`, `remove-port` (yml-Mutation + Hot-Reload),
     `port` (Discovery — listet die Traefik-URLs).
   - Scaffold joint `monoceros-proxy`-Network bei nicht-leerer
     `routing.ports`-Liste mit stabilem DNS-Alias (`--network-alias=<name>`
     in Image-Mode, `networks.monoceros-proxy.aliases: [<name>]` in
     Compose), damit Traefik via `http://<name>:<port>` routen kann.
   - Lifecycle: `apply` und `start` rufen `ensureProxy()` vor dem
     Container-Up; `stop` und `remove` rufen `maybeStopProxy()` —
     letzteres ist no-op wenn noch ein anderer Container am
     Proxy-Network hängt (Variante A aus der Designdiskussion).
   - Beispiel-Skript `docs/examples/serve-ports.mjs` für manuelle
     Browser-Smoketests.

   **Im Verlauf dazugekommen** (1.7.1 – 1.7.4):
   - `--default`-Flag für `add-port` — promoted einen Port an
     Position 0 in `routing.ports` (= `<name>.localhost`-Default),
     ohne Liste neu aufzubauen. Move bei vorhandenem Port, insert
     bei neuem; mehrere Ports + `--default` ist ein expliziter
     Usage-Error.
   - `--with-ports`-Flag für `init` — pre-seeded `routing.ports`
     beim init (`monoceros init <name> --with-ports=3000,5173,6006`),
     beide CLI-Formen (`=value` + two-token) plus
     Shell-Tokenization mit Leerzeichen. Aktiver `routing:`-Block
     in der generierten yml inkl. Container-Name-Substitution im
     Default-Kommentar und sichtbarem `vscodeAutoForward`-Hint.
   - **Pre-Flight Connect-statt-Bind** (1.7.3) — der Pre-Flight
     versuchte ursprünglich selbst auf Host-Port 80 zu binden, was
     unter Linux EACCES wirft (Port <1024 = privilegiert; Node-
     Prozess ist unprivilegiert, anders als der Docker-Daemon).
     Umgestellt auf TCP-Connect-Probe — connects brauchen keine
     Privileg, und „belegt" wird sauber erkannt.
   - **Builder-facing Output ohne `docs/`-/ADR-Refs** (1.7.4) —
     sechs Stellen leakten interne Doku-Anker (`docs/konzept.md`,
     `ADR 0007` etc.) in generierte yml's und Error-Messages.
     Bereinigt; Regression-Guard
     (`test/builder-facing-no-docs-refs.test.ts`) testet alle
     Output-Pfade per Pattern-Match.
   - **Test-Disziplin**: Live-Integration-Tests für `realPortProbe`
     (echter TCP-Listener) und CLI-Parser-Tests für `--with-ports`
     ergänzt, nachdem zwei Bugs durch stub-only-Tests gerutscht
     waren (Linux-EACCES, OOM-Loop). Jetzt 373/373 grün.

   **Bewusst aufgeschoben** (nicht Teil von Task 2):
   - TLS / HTTPS — `entryPoints: [web]` ist so verdrahtet, dass ein
     `websecure`-Entrypoint später additiv reingeht.
   - Auto-Migration bestehender Container — pre-1.x-Brechung
     akzeptiert; `monoceros remove <name>` + `apply <name>` ist
     der dokumentierte Pfad. Alte yml-Header mit ADR-Verweisen
     werden von `add-port` nicht angefasst (comment-preserving) —
     Cleanup ist Hand-Edit oder remove+init.
   - TCP-Tunnel für DB-Services — separates Geschwister-Item
     (Task 3 unten).
   - Test-Plan-Update für die Port-Strecke — Teil von Task 4
     (Test-Plan-Rewrite).

3. **`monoceros tunnel <name>` — TCP-Tunnel zu Container-Services** —
   Geschwister-Lösung zu Task 2 (HTTP via Traefik). Für TCP-Services
   (PostgreSQL, MySQL, Redis, …), die der Builder vom Host aus
   erreichen will, ohne `-p`-Mappings in die yml zu schreiben oder
   einen `apply`-Rebuild auszulösen.

   **Default-Verhalten**: `monoceros tunnel hello` ohne weitere Args
   öffnet Tunnel für **alle** Services, die in der Container-yml
   deklariert sind, auf deren jeweils default-Host-Port (postgres →
   5432, mysql → 3306, redis → 6379, …). Eine Zeile, und alles was
   compose-seitig konfiguriert ist, ist vom Host aus reachable.

   **Refinements**:
   - `--for-services=postgres,mysql` — nur die genannten Services
     aus der yml-Service-Liste tunneln
   - `--for-ports=8080,3000` — beliebige _interne_ Container-Ports
     forwarden, nicht nur deklarierte Services. Das ist gleichzeitig
     der **Escape-Hatch für HTTP-Tunneling**: wenn der Builder einen
     spezifischen Host-Port für eine HTTP-App braucht (statt der
     Traefik-Subdomain aus Task 2), funktioniert das auch hierüber.
   - Beide Flags kombinierbar.

   **Implementierung — α (socat-Sidecar-Container)**: pro Tunnel ein
   winziger `alpine/socat`-Container im Docker-Network des Ziel-
   Containers, mit `-p`-Mapping vom Host-Port auf den internen
   Service-Port. SSH-Variante (sshd im Dev-Container, key-basierte
   Auth, ein Tunnel mit `-L` für alles) ist verworfen für lokales
   Dev-Setup — Over-Engineering für den Use-Case. Re-aufrufbar wenn
   Remote-Dev-Container später Thema werden sollten.

   **Kollisions-Behandlung**: zwei Container wollen beide Host-Port
   5432 für ihre postgres-Tunnel. Default: klarer Fehler ("port 5432
   already in use by tunnel `<other>`"), Builder löst explizit via
   `--host-port=5433`. Vorhersagbar, keine implizite Port-Schiebung.

   **Lifecycle**:
   - `monoceros tunnel hello` startet die Sidecars
   - `monoceros tunnel hello --stop` (oder `monoceros tunnel-stop`)
     räumt sie weg
   - `monoceros stop hello` räumt sie implizit mit weg (Sidecars
     zeigen sonst ins Leere)
   - `monoceros start hello` startet sie **nicht** automatisch —
     Tunnels sind explizit ad-hoc, nicht persistent. HTTP via
     Traefik aus Task 2 ist die persistente Lösung, Tunnels sind
     situative TCP-Bridges.
   - `monoceros remove hello` räumt sie mit weg.

   **Scope**: primär Compose-Mode-Container mit deklarierten
   Services (für `--for-services`). `--for-ports` greift auch auf
   Image-Mode-Container — alles was im Container lauscht.

   **Offene Detail-Fragen**:
   - **Tunnel-Persistenz**: doch in der Container-yml mitschreiben,
     damit `monoceros start hello` automatisch re-establishes?
     Lean: nein, ad-hoc bleibt die ehrlichere Semantik. Builder ruft
     `monoceros tunnel hello` bewusst auf wenn er das braucht.
   - **Tunnel-Listing**: separates `monoceros tunnel hello --list`
     oder in `monoceros status hello` integrieren? Lean: Letzteres,
     dann sieht der Builder Tunnels neben Container-State.
   - **Host-Port-Default**: 1:1 (5432 für postgres). Bei Kollision
     forderbar via `--host-port=<other>`. Akzeptabel? Alternative
     wäre Ephemeral-Default ("Docker, such einen freien"), Builder
     hätte dann nie Kollisionen aber müsste den Port immer
     nachschlagen. Lean: 1:1 mit expliziter Override.

4. **Test-Plan neu schreiben** — der heutige `docs/test-plan.md` ist
   noch komplett auf das Pre-M4-Modell verdrahtet (`monoceros create`,
   keine yml-Profile, keine Init-Komponenten) und ist damit so weit
   weg vom aktuellen Stand, dass eine Aktualisierung Zeile-für-Zeile
   sich nicht lohnt — kompletter Rewrite ist sinnvoller. Setzt
   Tasks 1–3 voraus, damit die Neufassung die finale Surface testet.
   Mindest-Anforderungen an die Neufassung:
   - **CLI-Surface (Stage A)** auf das aktuelle Subcommand-Set
     ausrichten (`init`, `apply`, `add-feature`, `remove`, `restore`,
     `list-components`, `completion`, neu: `add-port`, `port`,
     `tunnel`, …); Subcommands nach Kategorien strukturieren wie im
     Help-Renderer.
   - **Scaffolding (Stage B)** auf `monoceros init <name> --with=…
--with-repo=…` plus `monoceros list-components` umstellen.
     Idempotenz + `add-*`-Mutator-Tests bleiben relevant, aber gegen
     das neue yml-Modell formuliert. Duplikat-Behandlung bei
     `--with-repo` + späterem `add-repo` (Lean C aus Task 1)
     explizit als Test-Fall mit drin.
   - **End-to-End-Strecke pro Komponenten-Bündel** als neue Stage C —
     ein realistischer Bündel-Mix (z. B. `node,postgres,claude`,
     `python,redis`, `node,github,atlassian/twg`) jeweils komplett
     durch `init → apply → run → remove`. Plus Port-Strecke:
     `add-port` + Browser-Test via `<container>.localhost`,
     `tunnel` + DB-Connection vom Host.
   - **Image-Mode-Pfad explizit testen** — bei M4 Task 9 ist ein
     Image-Mode-Container nach `remove` als Zombie übrig geblieben,
     weil die Test-Coverage bis dahin fast immer Compose-Mode war.
     Mindestens ein dezidierter Fall „`--with=node,claude` (ohne
     Services) → apply → remove → `docker ps -a` muss leer sein".
   - **SSH-Repo-Strecke explizit testen** — `init --with-repo` plus
     ein nachträgliches `add-repo git@github.com:<user>/<repo>.git`
     auf einen Repo bei dem der Builder Push-Rechte hat. Im
     Container: `git clone` (durch post-create.sh), Änderung machen,
     `git commit`, `git push`. Beweist dass das SSH-Agent-Forwarding
     funktioniert (Docker-Desktop-Proxy auf macOS, direkter
     Socket-Mount auf Linux). HTTPS-Repos via M3-Auth-Pfad sind
     separat abgedeckt — der SSH-Pfad braucht eine eigene
     Test-Strecke weil er andere Failure-Modes hat (siehe M4-Task-9-
     Fund: macOS Docker Desktop launchd-Socket-Sandboxing).
   - **Cross-OS-Sweep (Stage E)** als systematischer Pfad: install.sh
     auf macOS + Linux, install.ps1 auf Windows, jeweils mit dem
     M4-DoD-Walkthrough (init/apply/shell/Claude). Findet die
     plattform-spezifischen Bugs die heute durchschlüpfen (UTF-8
     in PowerShell, exit-in-iex, dash-vs-bash, npm-prefix-EACCES,
     curl-fehlt-auf-Ubuntu, …).

5. **AI-Tool-Library erweitern** — OpenCode, Codex, GitHub Copilot,
   Aider als Features dazu, jeweils nach dem Cookbook in
   [`docs/ai-tools.md`](./ai-tools.md). Unabhängig von Tasks 1–3,
   kann auch parallel laufen.

6. **`docs/commands/`-Lücken füllen** — neue Detail-Seiten für die
   Befehle aus Tasks 1–3 (`add-port`, `port`, `tunnel`, ggf.
   `tunnel-stop`). Plus den `--with-repo`-Flag in der `init.md`
   ergänzen. CLAUDE.md-Konvention: pro neuem CLI-Befehl eine
   MD-Datei im selben Commit wie der Code.

7. **Beispiel-Workflows** — kurze how-to-Dokumente für die häufigsten
   Stacks (Node-API mit DB-Tunnel, Python-Pipeline, Atlassian-Forge-
   Setup). Setzt Tasks 1–3 voraus, damit die Workflows die finalen
   Befehle nutzen können.

8. **Image-Aufräumen** — entscheiden, ob die dormant Egress-iptables-
   Mechanik im Image bleibt (opt-in für CI/headless) oder ganz raus
   kann. Heute beides möglich, kein akuter Druck. Unabhängig von
   Tasks 1–3.

### Zusätzliche Arbeiten die während M5 dazukamen

Nicht im Original-Plan (Task 1 war eine schlanke „init --with-repo"-
Erweiterung). Im Verlauf der Linux-rootful-E2E-Strecke + Diskussionen
über Provider-Modell und Docker-Setup-Quirks deutlich gewachsen.
Alle live in den 1.6.x-Releases:

- **HTTPS-only Repo-Modell** ([ADR 0006](./adr/0006-https-only-repo-auth.md))
  — SSH-Style-URLs (`git@host:…`, `ssh://…`) werden auf Schema-Ebene
  abgelehnt. Cross-Plattform-SSH-Agent-Forwarding (macOS launchd-
  Sockets, Windows Named Pipes, Multi-Identity-Wiring, Passphrase-
  Edge-Cases) entfällt damit komplett. SSH-Code aus
  `create/scaffold.ts` rausgenommen, ContainerEnv + mounts sind
  SSH-frei.

- **Provider-Modell** — neues `repos[].provider`-Feld mit Enum
  `github | gitlab | bitbucket | gitea` (gitea deckt Forgejo).
  Kanonische Hosts (github.com / gitlab.com / bitbucket.org) werden
  auto-detected; alles andere (self-hosted GitLab, GitHub Enterprise,
  Bitbucket Data Center, Gitea) braucht explizites `provider:` im
  yml, sonst bricht der Apply-Pre-Flight ab. Hintergrund: Hostname-
  Heuristiken wie `startsWith('gitlab.')` haben self-hosted Cases
  übersehen — explizite Deklaration ist die saubere Lösung.

- **Apply-Pre-Flight Stage 1 — Credentials** —
  `devcontainer/credentials.ts`. Host-side `git credential fill` pro
  unique HTTPS-Host. Bei missing creds: provider-spezifische
  Setup-Hints (gh auth login / glab auth login mit `--hostname` bei
  Self-Hosted / Atlassian-API-Token für Bitbucket Cloud / Gitea-UI-
  Token-Flow). Linux: brew als install-Empfehlung für gh + glab
  (Linuxbrew supportet beide first-class).

- **Apply-Pre-Flight Stage 2 — Reachability** —
  `devcontainer/repo-reachability.ts`. `git ls-remote` pro deklariertem
  Repo nach Credential-Fetch. Stderr-Klassifikation in vier Kinds
  (`not-found-or-no-access` / `auth-failed` / `dns` / `unknown`) mit
  per-Kind Actionable Advice. Fängt „Repo gibt's nicht / Token kann's
  nicht sehen / DNS broken" ab, bevor Docker auch nur startet —
  spart 1–2 min Docker-Build-Zeit bei Fail-Fast.

- **Init-Generator-Repos-Block** — in `documented mode` zeigt der
  generator jetzt einen kompletten `# repos:`-Hint-Block mit allen
  optionalen Feldern (path, provider, git.user) als kommentierte
  Beispiele. Bei `--with-repo` aktiv mit kommentierten Hint-Lines
  pro Entry. „Alle verfügbaren Optionen sichtbar"-Regel — gleiche
  Behandlung wie der features-Block.

- **Partial-Apply-Remnant Recovery** —
  `assertSafeTargetDir`-Anpassung in `apply/index.ts`. Wenn der
  Container-Dir genau `.monoceros/` enthält (Pre-Flight-Remnant von
  einem abgebrochenen Apply) aber kein state.json → recoverable, wir
  applyien drüber. Wenn unrelated Files dazu kommen: bleibt strikt.

- **Docker-Group-Bootstrap** —
  `devcontainer/docker-group-bootstrap.ts`. Auf Linux: wenn
  `docker info` mit Permission-Denied scheitert UND der User in
  `/etc/group`s docker-Zeile steht, re-execed sich monoceros
  transparent via `sg docker -c "node …"`. Effekt: nach
  `usermod -aG docker $USER` braucht der Builder **kein** newgrp /
  logout / relog — jedes `monoceros …` in jedem Terminal funktioniert
  sofort. Selbe Recovery in `install.sh` (Re-Download in tmpfile +
  `exec sg docker -c "bash tmpfile"`, weil `curl | bash` stdin
  bereits konsumiert hat).

- **Identity-Prompt nur wenn nötig** — `collectGitIdentity` läuft
  jetzt nur wenn `createOpts.repos` nicht leer ist ODER `git.user`
  irgendwo gesetzt ist (yml / monoceros-config defaults). Sandbox-
  Container ohne Repos: kein Prompt.

- **CLI_VERSION aus package.json injizieren** — tsup substituiert
  beim Build den `__CLI_VERSION__`-Platzhalter in `version.ts`.
  Vorher hatte version.ts einen hardcodierten String, der mehrfach
  desync zu package.json geriet (1.6.0 / 1.6.1 / 1.6.2 / 1.6.3 alle
  ausgeliefert mit `--version` → 1.5.0). Jetzt ein Bump-Ort.

- **macOS bash 3.2 install.sh-Fix** — `"${arr[@]}"` für leere Arrays
  unter `set -u` crasht auf macOS-Default-bash. Portable Form
  `${arr[@]+"${arr[@]}"}` ersetzt.

- **install.sh Docker-Hinweise** — Linux-Blöcke neu strukturiert:
  paste-fertiger 3-Befehl-Block (sudo -v + curl + usermod), Hinweis
  dass die Tail-Notiz von get.docker.com ignoriert werden kann, kein
  newgrp/logout-Geschwätz mehr in der Error-Box (gehört in die
  separate Doku `docs/docker-on-linux.md`).

- **Idmap-Rabbit-Hole + Revert** — kurzer Ausflug in den Versuch,
  rootless-Docker mit `,idmap=true`-Mount-Option zu unterstützen.
  Docker exponiert das Feature **nicht** über `--mount` (Podman ja,
  Docker nein — verifiziert in [Docker bind-mounts docs](https://docs.docker.com/engine/storage/bind-mounts/)).
  Revert in 1.6.6 zurück. Rootless Docker bleibt als Use-Case
  „nicht unterstützt" — der dokumentierte Pfad ist rootful Docker
  via `get.docker.com | sudo sh`.

- **monetization.md** — `docs/private/monetization.md` als
  gitignored Sammlung für Premium-Feature-Kandidaten angelegt;
  erster Eintrag: Commit-Signing im Container.

---

## Vorgemerkt für später (jenseits M5)

- **VS-Code-Server als Feature** — `code-server` als optionales
  Feature, sodass Builder den Container per Browser erreicht. Erst
  wenn echtes Nutzerinteresse sichtbar wird (siehe konzept.md →
  „VS-Code-Server-Frage").
- **Re-Eröffnung der Iteration-Pipeline** — entweder als eigenes
  Projekt das auf der Werkbank aufsetzt, oder als Adapter auf Claude
  Code's `/goal`-Mechanik. Siehe `../monoceros-iterate_archive-2026-05-17/`
  für den Snapshot und die offenen Fragen.
- **Optionaler Secret-Manager-Hook** — heute liegen Credentials in
  `monoceros-config.yml` (gitignored). Für Teams später ggf. ein
  Hook auf 1Password CLI, AWS Secrets Manager, etc.
- **Compose-Service-Katalog erweitern** — heute: `postgres`, `mysql`,
  `redis`. Denkbar: `mongodb`, `elasticsearch`, `kafka`, je nach
  Nachfrage.
- **Sprach-Toolchain-Katalog erweitern** — heute via Devcontainer-
  Features genug abgedeckt; nur falls häufig nachgefragte Tools
  außerhalb der offiziellen Sets auftauchen, eigene Wrapper anlegen.
- **Docker-im-Container als opt-in Feature** — manche Projekte bauen
  zur Dev-Zeit Docker-Images (`npm run dev` → `docker compose up
--build`). Plan: ein Feature `ghcr.io/getmonoceros/monoceros-features/docker-in-docker:1`,
  das einen Daemon im Monoceros-Container hochzieht. DinD bevorzugt
  über DooD wegen sauberem Lifecycle (kein Zombie nach `remove`),
  funktionierender `$(pwd)`-Bind-Mounts und natürlicher Traefik-
  Integration über den Parent-Container — den Privileged-Cost und
  die langsameren Builds akzeptieren wir. Doku-Strategie aktiv:
  zuerst auf `services:` in der Monoceros-yml umlenken, dann erst die
  Konsequenzen. Details: [ADR 0008](./adr/0008-docker-in-container.md).
