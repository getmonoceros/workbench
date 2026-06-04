# Monoceros Workbench — Backlog

Reihenfolge nach Milestones. Innerhalb eines Milestones sind die Tasks
in der Bauphase-Reihenfolge nummeriert. Erledigte Tasks bekommen ein
✅ vorgestellt und dürfen mit einem kurzen Hinweis auf das Ergebnis
ergänzt werden.

Konzeptioneller Überbau: [`konzept.md`](konzept.md).

## Überblick

| Milestone    | Inhalt                                                           | Status                    |
| ------------ | ---------------------------------------------------------------- | ------------------------- |
| M0           | Bootstrap (pnpm-Workspace, Tooling)                              | ✅ 2026-05-10             |
| M1           | DevContainer-CLI (`create`, `shell`, `run`, Compose-Lifecycle)   | ✅ 2026-05-11             |
| ~~M2~~       | Iteration-Pipeline + Plugin                                      | ❌ ausgelagert 2026-05-17 |
| M2.5         | yml-Profile-Modell (`init`/`apply <name>`, AST-Mutationen)       | ✅ 2026-05-17             |
| ~~M3 (alt)~~ | Externe Tracking-Adapter                                         | ❌ ausgelagert 2026-05-17 |
| **M3 (neu)** | AI-Tool-Feature-Library                                          | ✅ 2026-05-19             |
| M4           | Distribution / Go-Live                                           | 🚧 ab 2026-05-19          |
| M5           | Stabilisierung + Doku                                            | 🚧 ab 2026-05-23          |
| M6           | Service-Config-Modell, Secrets & init-Redesign                   | ✅ 2026-06-02             |
| M6.1         | Kuratierte Services: `${VAR}`-env + `.env`-Seeding + Healthcheck | ✅ 2026-06-03             |
| M6.2         | Git-Identity via `${VAR}` (Repo + Container) mit Kaskade         | ✅ 2026-06-03             |
| M6.3         | AI-Tool-Briefing am Container-Workspace-Root (Claude Code)       | 🚧 ab 2026-06-04          |

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
   - **Windows** ✅ — auf einer x86-Windows-Box (pictor-win) Ende
     Mai/Anfang Juni 2026 durchgespielt. Erst auf dem Windows-Host-
     Pfad, dabei ~12 plattform-spezifische Bugs in 1.11.1 – 1.11.11
     gefunden + gefixt. Dann mit 1.12 strategisch auf WSL umgestellt
     (siehe [ADR 0011](./adr/0011-wsl-only-auf-windows.md) und die
     1.12-Notiz am Ende von M5): die e2e-Suite (`monoceros-e2e`)
     läuft inside WSL Ubuntu jetzt komplett durch, 7/7 Szenarien
     grün. Die Apple-Silicon-Parallels-Beschränkung von oben ist
     damit auch egal — der Windows-Pfad ist auf einer realen x86-
     Box validiert.

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

Reihenfolge ist absichtlich Features-zuerst-Doku-danach: E2E-Tests
und Command-Doku kommen NACH den drei neuen CLI-Oberflächen
(`init --with-repo`, `add-port`, `tunnel`), damit Doku und Tests die
finale Surface abdecken und nicht zwischenzeitliche Zustände
dokumentieren.

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
   - Beispiel-Skript `serve-ports.mjs` für manuelle Browser-Smoketests
     (inzwischen ausgelagert ins eigene Fixture-Repo
     [getmonoceros/monoceros-e2e-fixture](https://github.com/getmonoceros/monoceros-e2e-fixture),
     damit es als `--with-repo`-Ziel + E2E-Fixture taugt).

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
   - Automatisierte E2E-Abdeckung für die Port-Strecke — Teil von
     Task 4 (E2E-Testmodul).

3. ✅ **`monoceros tunnel <name> <service-or-port>` — TCP-Tunnel zu
   Container-Services** — erledigt 2026-05-28, ausgeliefert in 1.10.0.
   Im Verlauf des Designs deutlich vereinfacht gegenüber dem
   Original-Entwurf: aus dem persistenten Sidecar-Lifecycle wurde
   ein Foreground-Prozess (Ctrl+C beendet) nach Vorbild von
   `kubectl port-forward` / `ssh -L`. Ein Tunnel pro Aufruf, kein
   yml-Mitschrieb, kein Listing, kein `--stop`.

   **Was live ist**:
   - `monoceros tunnel <name> <service-or-port> [--local-port=<n>]
[--local-address=<addr>]`
   - Service-Name aus dem `services:`-Block (postgres/mysql/redis;
     Default-Ports aus dem `SERVICE_CATALOG`) ODER bare interne
     Port-Nummer
   - **`<service>:<port>`-Form** (nachgezogen 2026-06-02) — derselbe
     Service auf einem expliziten Port (z. B. `rustfs:9001` für eine
     Konsolen-UI neben der API auf 9000); funktioniert auch, wenn der
     Service kein `port:` deklariert. Resolver yml-first nach dem
     Service-Modell-Umbau.
   - `--local-port` default = interner Port, mit `<port>+1`-Hint
     bei Kollision; Pre-Flight via TCP-Connect-Probe
   - `--local-address` default `127.0.0.1` (nur Loopback), opt-in
     `0.0.0.0` für LAN-Exposition
   - socat-Sidecar gepinnt auf `alpine/socat:1.8.0.3`
   - Topologie pro Mode dokumentiert (Compose-Default-Network,
     `monoceros-proxy`-Alias, Bridge-IP-Fallback) — siehe
     [ADR 0009](./adr/0009-tcp-tunnels-foreground-sidecar.md)
   - 464/464 Tests grün (Resolver + Run + Port-Check)

   **Bewusst verworfen** (gegenüber dem Original-Backlog-Entwurf):
   - Persistente Sidecars mit yml-Mitschrieb
   - „alle Services in einem Aufruf"-Variante (Logs würden
     multiplexen, `--local-port`-Kollisionen unauflösbar)
   - `--stop` / Listing / Integration in `monoceros stop`/`remove`
   - SSH-basierter Tunnel-Pfad

4. **E2E-Testmodul aufbauen** — siehe
   [ADR 0010](./adr/0010-e2e-tooling-eigenes-repo.md) für die
   Architektur-Entscheidung. Kurzform: kein CI-Matrix-Sweep, sondern
   ein **maintainer-facing Tool** in einem eigenen Repo
   ([`getmonoceros/monoceros-e2e`](https://github.com/getmonoceros/monoceros-e2e)),
   das auf der echten Builder-Maschine läuft und Monoceros
   ausschließlich über die CLI-Schnittstelle ansteuert.

   **Externes Repo — Hauptarbeit, alle ✅:**
   - Szenarien-Framework (TypeScript, Funktions-Shape), Helper für
     Pre-Flight-Cleanup, Pretty + GH-Annotations-Output, Timestamp-
     Naming. Container-Namenskonvention `e2e-<scenario>-<timestamp>`.
     `--keep` / `--interactive`-Flags zum Stehenlassen für manuelle
     Inspektion.
   - Sieben Szenarien (zwei mehr als Originalplan):
     1. ✅ `minimal` — `init --with=node → apply → run → remove`
     2. ✅ `with-services` — Compose + Service-TCP-Probe (Bash-builtin
        `/dev/tcp/postgres/5432` aus dem Workspace)
     3. ✅ `with-port` — `init --with-repo=getmonoceros/monoceros-e2e-fixture`
        - `serve-ports.mjs` + HTTP-Probe vom Host gegen
          `<name>.localhost`
     4. ✅ `with-tunnel` — `monoceros tunnel <name> postgres` im
        Hintergrund + Node-TCP-Probe vom Host (keine `psql`-
        Host-Dep)
     5. ✅ `image-mode-zombie` — `--with=node,claude` ohne Services
        → apply → remove → `docker ps -a` muss leer sein
        (M4-Task-9-Fund)
     6. ✅ `add-repo` — on-the-fly Clone in laufenden Container
     7. ✅ `with-mutations` — add-feature / remove-feature /
        add-repo Round-Trips
   - Suite läuft auf macOS / Linux / WSL identisch durch
     (7/7 grün Stand 1.12).

   **Sub-Tasks ursprünglich geplant, bewusst nicht gemacht:**
   - ~~Git-style Plugin-Dispatch (`monoceros e2e …`)~~ — e2e ist
     maintainer-internes Dev-Tool, kein End-User-CLI. `node
dist/bin.js` aus dem Checkout reicht für die 1-2 Personen die
     das überhaupt anfassen.
   - ~~`monoceros-e2e` in der ALL_COMMANDS-Completion-Liste~~ —
     hängt am Dispatch, fällt mit weg.
   - ~~`install.sh` / `install.ps1` analog zur Workbench~~ —
     `git clone && pnpm install && pnpm build && node dist/bin.js`
     ist der Maintainer-Workflow. Distribution-Layer hätte nur
     Wartungskosten ohne User-Mehrwert.
   - ~~npm-Publish `@getmonoceros/e2e`~~ — siehe oben.

   **Was stattdessen gemacht wird:**
   - ✅ **CI-Smoketest** — GH-Actions-Workflow
     [`e2e-smoke.yml`](../.github/workflows/e2e-smoke.yml) im
     **Workbench-Repo** der auf jedem PR + push to main `--all`
     gegen das aktuell gebaute monoceros laufen lässt — sofern die
     Änderung `packages/cli/**` betrifft (Path-Filter, kein Lauf bei
     reinen Doc/Backlog/ADR-Edits). `concurrency`-Block canceled
     in-flight Runs wenn ein neuer Commit auf den gleichen Ref
     landet, also nur der jeweils letzte Stand läuft komplett durch.
     Plus `workflow_dispatch` für Ad-hoc-Triggern.

     Aufbau: workbench wird per `npm pack` + `npm install -g` aus
     dem Tarball installiert (exakt der Weg den End-User via
     `install.sh` auch gehen — der Shim auf PATH, das bin-Mapping,
     die globale Module-Resolution werden alle exerziert).
     GitHub-Credentials per Inline-`credential.helper`-Script aus
     dem auto-bereitgestellten `GITHUB_TOKEN` (Job-Level-Env, damit
     spätere git-Subprozesse den Token noch sehen). e2e per
     `actions/checkout@v4` aus dem externen Repo geholt.

     Live seit 2026-06-01, Laufzeit ~3:30 für `--all` auf
     ubuntu-latest. Bug-Vorfilter pre-Release. ✓

5. **`docs/commands/`-Lücken füllen** — neue Detail-Seiten für die
   Befehle aus Task 3 (`tunnel`, ggf. `tunnel-stop`). CLAUDE.md-
   Konvention: pro neuem CLI-Befehl eine MD-Datei im selben Commit
   wie der Code.

6. **Beispiel-Workflows** — kurze how-to-Dokumente für die häufigsten
   Stacks (Node-API mit DB-Tunnel, Python-Pipeline, Atlassian-Forge-
   Setup). Setzt Task 3 voraus, damit die Workflows die finalen
   Befehle nutzen können.

7. **Image-Aufräumen** — entscheiden, ob die dormant Egress-iptables-
   Mechanik im Image bleibt (opt-in für CI/headless) oder ganz raus
   kann. Heute beides möglich, kein akuter Druck. Unabhängig von
   Task 3.

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

#### yml-UX + Shell-Completion-Welle (1.8.0 – 1.9.7)

Nicht im Original-M5-Plan. Entstanden aus Builder-Tests an den
generierten yml's und der Tab-Completion; iterativ über viele
kleine Releases ausgeliefert. Keine Schema-Brüche — `schemaVersion`
bleibt 1, alle Änderungen sind additiv oder rein kosmetisch am
Output.

- **yml-Format-Overhaul** (1.8.0) — `monoceros-config.sample.yml` und
  der container-config-Generator (`init/generator.ts`) auf einen
  konsistenten Stil umgestellt: eine `#`-Ebene durchgängig (kein
  `# # foo`-Nesting), Builder-Sprache in den Section-Headern (wozu,
  nicht wie), Container-Name in routing/repos-Prosa substituiert.
  Per-Feature-Doku (Tagline + Beschreibung, Options-Summary,
  `See <documentationURL>`) kommt ausschließlich aus dem
  Feature-Manifest — keine Fallback-Prosa mehr im Generator. Feature-
  Manifeste (`images/features/*/devcontainer-feature.json`) auf kurze
  Taglines + Ein-Satz-Option-Beschreibungen getrimmt.

- **Robuste Comment-Round-Trips** — yaml-lib parkt column-0-
  Section-Header (`# Container ports…`, `# Repos cloned…`) gerne am
  vorigen Leaf statt am nächsten Pair. `relocateLeakedSectionComments`
  (in `mutate()` zentral, läuft nach JEDER add-_/remove-_-Mutation)
  splittet am `\n\n`-Trenner und schiebt den Header zur richtigen
  Section zurück. Symmetrisch: `setContainerGitUserInDoc` setzt neues
  `git:` an die Spitze (nach `name:`) mit Header; `writeGlobalDefaultGitUser`
  setzt `defaults.git` an den Anfang von `defaults` und strippt alte
  commented-out `# git:`-Skelette; `removeFeatureFromDoc` schneidet
  den am Vor-Sibling geparkten Feature-Header mit weg.

- **Feature-Kurznamen** (1.8.x/1.9.4) — `add-feature` und
  `remove-feature` akzeptieren Katalog-Kurznamen (`atlassian`,
  `atlassian/twg`, `claude`) zusätzlich zur vollen OCI-Ref; Kurzname
  bringt die Katalog-Default-Optionen mit, `-- key=value` überschreibt.
  Fehlermeldungen echoen die getippte Form. `add-feature` injiziert
  denselben Manifest-Header-Block den `init` erzeugt (geteiltes
  `init/feature-doc.ts`).

- **Schema/Transform-Anpassungen** — `FeatureOptionValueSchema`
  akzeptiert `null` → `""` (bare `apiKey:` parst sauber);
  `transform.ts` behandelt leere Option-Werte als „nicht gesetzt",
  damit der globale `defaults.features`-Wert greift statt mit `""`
  überschrieben zu werden.

- **Shell-Completion neu** (1.9.0 – 1.9.3) — internes
  `monoceros __complete --line --point` als Engine
  (`completion/resolve.ts`, kontextsensitiv aus einer COMMAND_SPECS-
  Tabelle); bash/zsh/pwsh-Wrapper sind jetzt dünne Forwarder.
  Vervollständigt Befehle, Container-Namen, Flags, Flag-Werte
  (`--with=<katalog>`, `--provider=<enum>`), komma-getrennte Listen
  und Feature-Option-Keys nach `--` (inkl. `true`/`false` für
  Boolean-Optionen). Value-Flags kommen mit Trailing-`=` damit der
  Shell-Wrapper das Auto-Space unterdrückt (kein `--with-ports =3000`
  mehr). `install.sh` schreibt für zsh `menu select` +
  `unsetopt LIST_AMBIGUOUS`, damit das erste Tab direkt die Liste
  zeigt.

- **Identity-Persistenz** (aus dem 1.6/1.7-Strang fortgeführt) —
  apply/init-Prompt schreibt nach Scope `g`/`c`/`b`/`n` in
  monoceros-config und/oder container-yml; Re-Prompt wenn nur
  `.monoceros/gitconfig` Werte trägt und keine Defaults gesetzt sind.

#### 1.12 — Windows-Pfad konsolidiert auf WSL ([ADR 0011](./adr/0011-wsl-only-auf-windows.md))

Zwei Tage am Stück Windows-Host-Bugs auszubügeln (Drive-Letter-Case
in Docker-Labels, cmd.exe-Quoting in bash-Cleanups, npm's `.ps1`-Shim
vs. PowerShell-Komma-Operator, Traefik-File-Watch-Defekt auf
gRPC-FUSE-Bind-Mounts, GCM-`fill`-ohne-`store`, taskkill statt SIGINT,
PATHEXT-Lookup für `.cmd`-Spawn, e2e-spawn-Shim-Parsing, etc.) hat
gezeigt: der Windows-Host-Pfad war eine fortlaufende Bug-Quelle ohne
echten User-Mehrwert — WSL ist auf Windows ohnehin Pflicht für
Docker Desktop, der „direkt-aus-PowerShell"-Komfort sparte einzig
einen Terminal-Tab-Wechsel.

Mit 1.12 ist **WSL der einzige unterstützte Windows-Pfad**:

- `install.ps1` entfernt
- `docs/install-windows.md` dokumentiert WSL-Setup als Standardweg
- Windows-spezifischer Code aus workbench und e2e-repo entfernt
  (−547 Zeilen im workbench, −170 im e2e); ein einziger WSL-Quirk
  bleibt (`.localhost`-Auflösung im e2e-with-port-Probe via
  Host-Header-Trick)
- e2e-Suite läuft auf macOS / Linux / WSL identisch durch

Sieh ADR 0011 für die volle Begründung + Liste der entfernten
Stellen.

#### 1.14 — `monoceros apply` UX-Polish ([ADR 0013](./adr/0013-apply-progress-und-log.md))

Das `▸ Container`-Section zwischen `▸ Scaffold` und `▸ Next steps`
war ein ungesorteter Block aus ISO-Timestamps, dem vollständigen
`docker run`-Aufruf mit metadata-JSON und postCreate-Output. Diagnose
schwierig, scanbar nicht. In drei Schritten umgebaut:

- **Step 1** — pro Apply ein vollständiges Transkript nach
  `<home>/container/<name>/logs/apply-<name>-<ISO>.log`,
  Pfad-Pointer am Ende. ANSI gestrippt, Header mit Befehl + Zeit +
  CLI-Version + Konfig + Host.

- **Step 2** — Spinner mit Phasen-Beschriftung
  (`starting container…` / `running postCreate…`) statt rohem Stream.
  Auf Erfolg: `✔ container ready (Xs)` + Inventar-Block (Languages,
  Services, Features, Repositories, Ports, APT packages, Install URLs;
  Kurznamen statt voller Refs). Im Fehlerfall: `✘ apply failed` mit
  den letzten ~15 Zeilen des `@devcontainers/cli`-Streams + Logpfad.
  `--verbose` streamt wie früher; non-TTY (CI / Pipe) fällt
  automatisch dahin zurück.

- **Step 3** — sauberes SIGINT-Handling: Ctrl+C stoppt den Spinner,
  schließt das Log, exit 130. Cursor sauber, Log vollständig.

Schafft nebenbei den Pfad `container/<name>/logs/` für künftige
Audit-Logs (siehe „Vorgemerkt").

---

## ✅ M6 — Service-Config-Modell, Secrets & init-Redesign

**Ziel:** Eine reale Test-Solution (logoscraper) brauchte Postgres
**und** RustFS als Services mit Custom-Env, init.sql-Mount und
Secrets. Das deckte mehrere Lücken auf, die in einem Bogen geschlossen
wurden. **Abgeschlossen 2026-06-02**, end-to-end gegen logoscraper
validiert (App läuft, Browser-erreichbar, Postgres + rustfs zusammen).
Design-Diskussion: 2026-06-01/02.

Alle Commits lokal auf `main`:

1. **Generisches Service-Modell** (`feat(services)`) — `services:` ist
   objekt-only (`{ name, image, port?, env?, volumes?, healthcheck?,
restart?, command? }`); kuratierte Namen sind Init-Sugar, die zum
   vollen Block expandieren, beliebige Images werden mit Scaffold
   eingetragen. `healthcheck.test` als String **oder** `["CMD", …]`,
   `data:`-Volume-Kurzform → Bind-Mount, `./`-Prefix geschluckt, Docker
   Named Volumes abgelehnt. `port:` ist Tunnel-Metadaten, kein
   Host-Mapping. Die App/webapp ist **kein** Service, sondern der
   Workspace.

2. **Secrets via `<name>.env`** — `${VAR}` in der yml löst beim Apply
   aus `container-configs/<name>.env` (gitignored) auf — in
   Service-Feldern **und** Feature-Optionen (`apiKey`/`apiToken`), damit
   die yml ohne Tokens teilbar ist. Fehlende Variable → harter Fehler
   mit `location`-Pfad. `init`/`add-feature` seeden die `.env`-Keys
   (Var-Regel `<FEATURE>_<OPTION>`) + rendern `${VAR}`-Platzhalter;
   `remove-*` fasst die `.env` nicht an. `remove`/`restore` sichern die
   `.env` mit.

3. ~~**Host-seitiges Repo-Klonen** ([ADR 0012](./adr/0012-host-side-repo-clone.md))~~
   — **2026-06-03 zurückgenommen.** Der host-seitige Clone + der
   host-seitige `git ls-remote`-Reachability-Pre-Flight verlagerten Netz/
   Auth auf den Host und brachen plattformübergreifend falsch ab (VS-Code-
   `GIT_ASKPASS` macOS; github.com-DNS Linux-VM). Repos werden wieder nur
   **in-container** geklont. Der init.sql-vor-`compose up`-Fall bleibt
   offen → container-seitig lösen (siehe „Vorgemerkt").

4. **init-Flag-Umbau** (`feat(init)`) — `--with` raus; explizite
   Kategorie-Flags `--with-languages` / `--with-features` /
   `--with-services` / `--with-apt-packages` / `--with-repos` /
   `--with-ports`. Features + Services nehmen beliebige Refs/Images.
   `init` legt die `<name>.env` (gitignored, einzeilen-Header) gleich an.

5. **`tunnel <service>:<port>`** — expliziter Port für einen zweiten
   Service-Port (rustfs-Konsole 9001 neben API 9000).

**Bewusst offen / nicht gemacht:** ~~Services seeden keine `.env`-Vars~~
(in **M6.1** nachgezogen); Reachability-Probe ist seit dem
Host-Clone weitgehend redundant (könnte später warn-only werden); ein
e2e-Szenario für den Custom-Image+`.env`+init.sql-Pfad fehlt noch.
Bekannter Punkt: aus dem VS-Code-Terminal kann der Repo-Auth-Pre-Flight
sporadisch fehlschlagen (VS Codes `GIT_ASKPASS`-Injektion) — dokumentiert
in [apply.md](./commands/apply.md) mit Workaround, bewusst nicht blind
gepatcht.

E2E-Repo (`getmonoceros/monoceros-e2e`): alle 7 Szenarien auf die neuen
`--with-*`-Flags migriert.

---

## ✅ M6.1 — Kuratierte Services: `${VAR}`-env, `.env`-Seeding, Healthcheck

**Ziel:** Die in M6 bewusst offen gelassene Lücke schließen — Services
und Features verhalten sich jetzt **gleich**. Damit ist die yml auch für
Service-Credentials teilbar, und der Builder hat ein einheitliches
mentales Modell: yml + `.env` kopieren, `.env` anpassen → neuer Container
mit gleicher Struktur, anderem Geheimnis (das Ansible-Template-Prinzip).
**Abgeschlossen 2026-06-03**, end-to-end durch die Dev-CLI validiert
(`init --with-services` + `add-service`).

1. **Kuratierte Services rendern `${VAR}`-Platzhalter.** Regel:
   Platzhalter-Var = der env-Key selbst (`POSTGRES_USER →
${POSTGRES_USER}`) — maximal vorhersagbar, kein Mapping. Gilt
   catalog-weit (postgres/mysql/redis), kein Postgres-One-off.

2. **`.env`-Seeding mit Dev-Defaults.** Die literalen Katalog-Defaults
   (`POSTGRES_USER=monoceros`, …) werden via `curatedServiceEnvDefaults`
   in `<name>.env` geseedet — uniform in `init` **und** `add-service`
   über denselben `ensureEnvVars`-Pfad wie Feature-Credentials (der jetzt
   neben Blank-Keys auch Default-Werte kennt). redis hat keine env → kein
   Seed. Custom-Images seeden nichts (Monoceros kennt ihre Vars nicht).
   Connection-String-Default bleibt unverändert (`monoceros`).

3. **Healthcheck + `restart: unless-stopped` für alle kuratierten
   Services.** `pg_isready` / `mysqladmin ping` / `redis-cli ping`. Der
   Workspace gated via `depends_on` damit auf `service_healthy` statt nur
   `service_started` — schließt die „connection refused beim ersten
   `npm run dev`"-Lücke.

Apply-Pfad unverändert: `buildComposeYaml` + `interpolateServices`
rendern env/healthcheck/restart bereits seit M6, die `${VAR}` lösen beim
Apply aus der `.env` auf. Docs: add-service.md + init.md aktualisiert.

**Offen geblieben (wie M6):** `--as`-Zweitinstanz desselben Service-Typs
teilt die `${VAR}` (z. B. zwei Postgres → beide `${POSTGRES_USER}`) — der
seltene Fall; wer das braucht, benennt den Platzhalter von Hand um. Kein
Grund, den 99-%-Fall dafür hässlich zu machen.

---

## ✅ M6.2 — Git-Identity via `${VAR}` (Repo + Container) mit Kaskade

**Ziel:** Die Git-Committer-Identität soll genauso aus `<name>.env`
auflösbar sein wie Service-/Feature-Werte — damit die yml auch hier
teilbar bleibt — **aber** mit der bestehenden Kaskade als Fallback statt
hartem Fehler. **Abgeschlossen 2026-06-03**, durch die Dev-CLI validiert
(`add-repo` mit Platzhalter vs. kaputter Literal-Mail).

1. **`${VAR}` in `git.user.{name,email}`**, auf **beiden** Ebenen:
   per-Repo (`repos[].git.user`) und Container-Level (`git.user`).
   Aufgelöst beim Apply aus `<name>.env`.

2. **Weiche Auflösung statt hartem Fehler.** Fehlt eine Var:
   - **Repo-Ebene**: alles-oder-nichts — der ganze per-Repo-Override
     fällt weg, das Repo erbt die Container-Identität (keine
     Misch-Identität aus env-Name + Kaskaden-Mail).
   - **Container-Ebene**: pro Feld — das aufgelöste Feld greift, das
     unaufgelöste fällt in die Kaskade (monoceros-config → Host →
     persisted → Prompt; die löst name/email ohnehin getrennt auf).

3. **Format-Check nach der Auflösung, nicht beim Parsen.** `GitUserSchema`
   prüft nur noch die Form (nicht-leerer String); die email-Regex wandert
   in den Apply (`isValidEmail`, nach Interpolation). Ein aufgelöster,
   aber kaputter Wert → harter Apply-Fehler mit klarer Meldung. Der
   Flag-Eingang (`add-repo --git-email`) validiert literale Werte weiter
   sofort, lässt aber `${VAR}` durch. Die globale `monoceros-config`
   `defaults.git.user.email` bleibt **streng** beim Laden validiert (kein
   `.env` löst sie auf → kein Platzhalter sinnvoll).

4. **Leerer Wert = unset → Kaskade.** Ein in der `.env` vorhandener, aber
   **leerer** Key (`GIT_USER_NAME=`) löst zu „kein Wert" auf — genau wie
   ein fehlender — und lässt die Kaskade hochlaufen, statt eine leere
   Identität zu setzen (oder bei der Email hart zu fehlern). Spiegelt,
   wie das Schema einen leeren _literalen_ Wert schon immer als unset
   behandelt hat.

5. **Scaffold + Seeding (statt nur Mechanik).** Sind Repos vorhanden,
   schreibt **init** einen Container-`git.user` mit
   `${GIT_USER_NAME}`/`${GIT_USER_EMAIL}`-Platzhaltern und seedet die
   leeren Keys in `<name>.env`; **add-repo** macht beim ersten Repo
   dasselbe (vorhandene `git.user` bleibt unangetastet). init **fragt
   nicht mehr** nach der Identität — der frühere init-Prompt entfällt, die
   Auflösung passiert beim Apply (inkl. „global speichern?"-Prompt dort).
   Die Repos erben den Container-`git.user`; der per-Repo-Block bleibt als
   auskommentierter Override-Hinweis. (Container-Ebene gewählt, nicht
   per-Repo — sonst stünden dieselben Platzhalter pro Repo doppelt da.)

Bewusst **nicht** gemacht: Identität wird nicht aus dem Host vor-befüllt
(leer geseedet, bewusst — Kaskade greift beim Apply).

---

## 🚧 M6.3 — AI-Tool-Briefing am Container-Workspace-Root

**Ziel:** Claude Code im Container weiß, welcher Stack tatsächlich
materialisiert wurde (Sprachen, Services, Feature-Tools, verfügbare
Erweiterungs-Befehle), ohne dass der Builder das pro Session erklären
muss. Heute startet jede Claude-Code-Session "blind" — Risiko: Claude
schlägt z. B. ein Node-Backend vor, obwohl der Container Java liefert.

Designentscheid: [ADR 0014 — AI-Tool-Briefing im Container-Workspace-Root](./adr/0014-ai-tool-briefing-im-workspace-root.md).
Kurzform: `AGENTS.md` neben der `.code-workspace`-Datei im
Container-Workspace-Root, `CLAUDE.md` enthält `@AGENTS.md` als
Import-Stub, `.monoceros/commands.md` enthält die Command-Referenz und
wird von `AGENTS.md` via `@`-Import gezogen. Marker-Blöcke
(`<!-- monoceros:begin/end -->`) erlauben User-Ergänzungen die apply
überleben. Claude Codes Walk-up vom cwd findet die Datei aus jedem
Projekt unter `projects/<name>/` automatisch.

Fokus dieses M6.3 ist **Claude Code als Primärziel**. Die anderen
AI-Tools (OpenCode, Codex, Gemini CLI, GitHub Copilot) bleiben heute
außerhalb des Scope — Behandlung in "Vorgemerkt für später".

### Tasks

1. ✅ **Briefing-Generator** — neues Modul `packages/cli/src/briefing/`
   mit fünf Dateien: `markers.ts` (HTML-Kommentar-Marker für
   user-edit-safe Rewrite), `agents-md.ts` (Stack-Manifest aus yml),
   `claude-md.ts` (Stub `@AGENTS.md`), `commands-md.ts` (Subcommand-
   Referenz aus den citty-defs — keine Refactoring von COMMAND*SPECS
   nötig, citty hatte alles schon), `index.ts` (Orchestrator mit
   marker-aware Rewrite und dynamic-import Cycle-Break gegen apply).
   21 Tests, alle grün. *(erledigt 2026-06-04)\_

2. ✅ **`apply`-Integration** — `writeBriefing` läuft direkt nach
   `writeStateFile` in `apply/index.ts`. Failure wird geloggt aber
   bricht apply nicht ab (Container bleibt funktional, nur AI-UX
   degradiert). Komponenten-Katalog wird für Feature-DisplayName-
   Mapping geladen; unbekannte Feature-Refs fallen auf den letzten
   Pfad-Segment-Namen zurück. _(erledigt 2026-06-04)_

3. ✅ **`.gitignore`-Ergänzung** am Container-Root — `/AGENTS.md` und
   `/CLAUDE.md` ergänzt im `writeScaffold`-Pfad (`/.monoceros/` war
   schon drin und deckt `commands.md` automatisch ab). _(erledigt
   2026-06-04)_

4. ✅ **Doku** — neuer Abschnitt "Container-Briefing —
   `AGENTS.md` / `CLAUDE.md`" in `docs/ai-tools.md` (Mechanismus,
   Marker-Verhalten, External-Imports-Approval-Hinweis,
   Credentials-Linie, `x-monoceros.briefing`-Schema für Feature-
   Manifeste); Cookbook-Eintrag in derselben Datei erweitert. Kurze
   Sektion in `docs/commands/apply.md` direkt nach "Log-Datei"
   verweist auf die `ai-tools.md`-Details. README-Block im
   "Erster Container"-Pfad nimmt den Approval-Hinweis vorweg.
   _(erledigt 2026-06-04)_

5. **E2E-Szenario** im `monoceros-e2e`-Repo: `init --with-languages=node
--with-services=postgres --with-features=claude → apply` und
   verifizieren, dass `AGENTS.md` im Container-Workspace-Root den
   Node-Stack, die Postgres-Connection und das Claude-Feature
   reflektiert; aus einem Projekt-Verzeichnis muss Claude die Datei via
   Walk-up sehen. (CLI-seitig durch `apply-yml.test.ts` schon abgedeckt;
   E2E-Repo schließt die Browser-/Tool-seitige Lücke.)

6. **Briefing-Inhalt in der Praxis schärfen** — die heute generierte
   Form ist v0 (siehe `docs/private/agents-md-draft.md` für den
   Working-Draft mit Begründungen). Iteration erfolgt durch reale
   Nutzung, nicht durch Vorab-Perfektionierung.

### Definition of Done

- Claude Code im Container findet aus jedem Projekt-Verzeichnis das
  Stack-Briefing via Walk-up.
- Der Inhalt reflektiert den realen Container-Stand nach allen
  `add-*`-Mutationen, nicht den yml-Stand bei init.
- Re-Apply nach `add-feature` / `add-service` aktualisiert die Datei
  und lässt User-Notizen außerhalb der Marker-Blöcke unberührt.

## Vorgemerkt für später (jenseits M6)

- **Audit-Logging unter `container/<name>/logs/`** — der Pfad steht
  seit ADR 0013 (siehe M5-Abschnitt „1.14"). Folge-Commands (`remove`,
  `add-feature`, `restore`, `add-service`, …) können dort jeweils
  `<command>-<name>-<ISO>.log` ablegen. Eigene ADR/Spec dann, wenn
  klar ist, was rein soll (was wird wirklich nachgefragt: „warum
  ist der Container weg?", „wann wurde Feature X dazugeschaltet?")
  und ob es darüber hinaus einen zentralen Index braucht.

- **Repo-Datei als Service-Bind-Mount vor `compose up`** — _für den
  DB-Seed-Fall per Konvention gelöst (2026-06-03), Rest geparkt._
  Anlass war: ein Service mountet `init.sql` aus einem geklonten Repo und
  braucht die Datei, bevor der Service startet — Repos werden aber
  in-container (post-create, nach Container-Start) geklont, liegen also
  nicht vor `compose up` auf dem Host. (Der host-seitige Clone aus
  ADR 0012 war der falsche Fix → zurückgenommen.)
  **Entscheidung:** DB-Schema/Seed gehört in eine **Migration**, die der
  Workspace gegen den Service fährt, **nachdem** dieser `service_healthy`
  ist (M6.1 wartet bereits darauf) — nicht in einen
  `docker-entrypoint-initdb.d`-Bind-Mount. Das löst die Abhängigkeit
  vollständig, ohne Monoceros-Infrastruktur. Dokumentiert in
  [add-service.md](./commands/add-service.md).
  **Geparkt (kein YAGNI-Bau):** der allgemeinere Fall „ein Service
  braucht eine **Config-Datei** aus einem Repo beim Start" (nginx.conf
  o. ä.) hat kein Migrations-Äquivalent. Falls das real auftaucht: ein
  container-seitiger Clone-Init-Schritt im Compose, von dem die Services
  per `depends_on: service_completed_successfully` abhängen (Clone im
  Container-Netz, schreibt in `projects/`) — **erst** das Docker-Timing
  (wann legt `compose up` das leere Bind-Mount-Verzeichnis an?) per
  Experiment klären. Nicht spekulativ bauen.
- **AI-Tool-Library erweitern** — OpenCode, Codex, GitHub Copilot,
  Aider als Features dazu, jeweils nach dem Cookbook in
  [`docs/ai-tools.md`](./ai-tools.md). Im Original-M5-Plan, aber
  aus dem aktuellen Block rausgenommen — die heute vorhandenen
  Features (Claude Code, Rovo Dev) decken den Bedarf, weitere
  Tools kommen on demand.

- **AI-Tool-Briefing für weitere Tools** — M6.3 hat Claude Code als
  primäres Ziel; das in [ADR 0014](./adr/0014-ai-tool-briefing-im-workspace-root.md)
  beschriebene Setup deckt **OpenCode** mit ab, weil dessen Walk-up
  und der `CLAUDE.md`-Fallback denselben Pfad lesen — real verifizieren
  sobald das OpenCode-Feature gebaut ist. **Codex** sieht das Briefing
  heute nicht (bounded by git root, walkt nach unten); naheliegender
  Workaround ist eine zusätzliche Kopie/Symlink unter
  `~/.codex/AGENTS.md` im Container-Home. **Gemini CLI** analog via
  `~/.gemini/GEMINI.md` plus Klärung was "trusted root" beim Walk-up
  bedeutet. **GitHub Copilot** ist echter Sonderfall — braucht eine
  Per-Projekt-`.github/copilot-instructions.md` mit `applyTo`-
  Frontmatter, plus `chat.useAgentsMdFile`-Schalter in
  `.vscode/settings.json`. Lösungen erfordern Schreibzugriff auf
  Projekt-Verzeichnisse oder einen aktivierbaren yml-Schalter pro
  Projekt — bewusst offen.

- **Host-Policy-Propagation für `/etc/claude-code/` und `/etc/codex/`** —
  Wenn eine Org per MDM/Group-Policy eine `/etc/claude-code/CLAUDE.md`
  oder `/etc/codex/requirements.toml` auf den Host deployed, ist das
  eine bewusste Policy-Entscheidung. Monoceros sollte diese Dateien
  beim Container-Build aus dem Host übernehmen und an die gleichen
  Pfade im Container kopieren — der Container respektiert damit die
  Org-Vorgaben, ohne dass Monoceros sie überschreibt oder ersetzt
  (siehe ADR 0014, Abschnitt "Verworfen"). Realisierung als
  opt-in-Verhalten beim `apply`: prüfen, ob die Host-Pfade existieren,
  und falls ja als read-only ins Container-Image legen. Offen:
  Plattform-Verhalten auf macOS (`/Library/Application Support/ClaudeCode/`)
  und Windows (`C:\Program Files\ClaudeCode\`) — andere Pfade als
  Linux, gehören aber konzeptionell ins gleiche Feature.
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
- **Service-Config-Modell, Secrets & init-Redesign** — ✅ umgesetzt,
  siehe Milestone **M6** oben. Aus dem damaligen Design noch **offen**
  (bewusst aufgeschoben):
  - **`cmd:`-Resolver in der `.env`** (`PG_PASSWORD=cmd:op read op://…`)
    — Monoceros führt das Kommando beim Apply host-seitig aus und nimmt
    stdout. Universeller Brückenkopf zu jedem Passwort-Manager mit CLI
    (1Password/KeePassXC/Bitwarden/Vault), kollabiert N Secrets auf ein
    Vault-Entsperren. Caveat: interaktive Manager (KeePassXC) blockieren
    nicht-interaktives Apply; Session-/Agent-Manager (op, bw, gpg-agent)
    lösen still auf. Offen: ob aufgelöster Klartext in die generierte
    compose.yaml gebacken wird oder nur als Prozess-Env durchgereicht.
  - **Verschlüsselt-at-rest** (committbare Secrets) via **SOPS + age**,
    nicht Ansible Vault — nur falls je echter Team-Bedarf.

- **Compose-Service-Katalog erweitern** — heute kuratiert: `postgres`,
  `mysql`, `redis`. Seit M6 weitgehend gegenstandslos — jedes andere
  Image (`mongodb`, `elasticsearch`, `kafka`, …) geht direkt als
  `--with-services=<image>` bzw. Objekt-Block, ohne Katalog-Eintrag.
  Kuratieren lohnt nur noch für bequeme Dev-Defaults bei sehr häufigen
  Services.
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
