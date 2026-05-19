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
| M4           | Distribution / Go-Live                                         | 🔜                        |
| M5           | Stabilisierung + Doku                                          | 🔜                        |

---

## ✅ M0 — Bootstrap

**Ziel:** Das Repo ist arbeitsfähig — pnpm-Workspace, Linting,
Formatting, Husky, Basis-CI-Hygiene. **Abgeschlossen 2026-05-10.**

- ✅ pnpm-Workspace, TypeScript-Basis, Prettier + ESLint (Flat-Config),
  Husky + lint-staged, Vitest-Basis
- ✅ `.editorconfig` / `.gitignore` / `.gitattributes` aus älteren
  Archiven übernommen

CI-Skeleton (GitHub-Actions) ist offen und wandert nach M4.

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
`ghcr.io/<org>/monoceros-features/<tool>:1`.

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

**Frische Session, die M4 anfasst:** lies zuerst
[`docs/m4-brief.md`](./m4-brief.md). Da stehen die Namens-
Entscheidungen (GitHub-Org `getmonoceros`, npm
`@getmonoceros/workbench`, GHCR `ghcr.io/getmonoceros/…`), die
Pre-Flight-Schritte und der Stolperstein-Katalog.

### Tasks (Skizze)

1. **Runtime-Image nach GHCR pushen** — `ghcr.io/<org>/monoceros-runtime:<tag>`,
   Multi-Arch (amd64 + arm64). Templates und scaffold.ts referenzieren
   den GHCR-Tag statt `monoceros-runtime:dev`.

2. **Feature-Library nach GHCR pushen** — die heutigen drei
   Features (`claude-code`, `atlassian`, `github-cli`) unter
   `ghcr.io/<org>/monoceros-features/<name>:<tag>` publizieren,
   manuell via `@devcontainers/cli features publish`, später per
   CI (Task 5). Sobald die Refs in der yml unter dem realen
   `<org>`-Namespace existieren, kann die Local-Source-Auflösung
   im Scaffold (`resolveFeatures` in `scaffold.ts`) eigentlich
   raus — sie ist nur fürs Dev-mit-Workbench-Checkout nötig.
   Wir lassen sie aber als Fallback drin, damit Workbench-
   Contributors weiter direkt auf `images/features/<name>/`
   testen können, ohne nach jedem Edit zu publishen.

3. **CLI als npm-Paket publizieren** — `@monoceros/cli` (oder direkt
   `monoceros`) auf npm. `bin`-Eintrag funktioniert via global install.

4. **`pnpm cli`-Workaround retire** — sobald CLI npm-installable ist,
   ist das Root-Script in `package.json` nur noch Dev-Convenience.

5. **Install-Doku** — README im Workbench-Root mit drei Optionen:
   - „Ich nutze die Workbench" (npm install -g + `~/.monoceros/`-Setup)
   - „Ich entwickle an der Workbench" (`pnpm install` + `pnpm cli …`)
   - „Ich nutze die Werkbank schon auf einer Solution" (welche
     Container-yml-Felder gibt's, wie editiere ich Hand)

6. **CI-Skeleton** — GH-Actions für Lint + Typecheck + Test bei jedem
   PR. Auto-Publish-Pipeline für Runtime-Image + Features +
   npm-Package bei Release-Tag.

7. **MONOCEROS_HOME-Default geschärft** — Wenn `npm install -g`
   greift, ist `$MONOCEROS_HOME` standardmäßig `~/.monoceros/`. Erst-
   Run-Erlebnis: `monoceros init hello --with=claude && monoceros apply hello`
   muss out-of-the-box laufen, inkl. automatisch erstelltem
   `~/.monoceros/`-Layout.

### Bewusst nicht in M4

- Eigene Web-UI / Hub
- Multi-User-Hosting
- Cloud-Variante

### Definition of Done

- ✅ Ein Builder ohne Workbench-Checkout kann via `npm install -g`
  und `monoceros init hello --with=claude && monoceros apply hello`
  einen Container hochfahren — Runtime-Image **und** Features
  werden aus GHCR gezogen, keine lokalen `images/...`-Files nötig
- ✅ `ghcr.io/<org>/monoceros-features/{claude-code,atlassian,github-cli}`
  via `docker pull` / `devcontainer features info` von außen
  erreichbar
- ✅ Stage E-Walkthrough von Außen (Test-Plan) durchgespielt
- ✅ README erklärt, was Monoceros ist und wie man's installiert

---

## 🔜 M5 — Stabilisierung + Doku

**Ziel:** Was M2.5 + M3 + M4 geliefert haben, ist robust und gut
beschrieben.

### Tasks (Skizze)

1. **Test-Plan überarbeiten** — Stages A–D aktualisieren auf das
   neue Modell (`monoceros init --with=…` + `apply <name>`, keine
   `create`-Referenzen mehr). Stage C als End-to-End-Strecke pro
   Komponenten-Bündel (aus M3 herübergezogen).
2. **AI-Tool-Library erweitern** — OpenCode, Codex, GitHub Copilot,
   Aider als Features dazu, jeweils nach dem Cookbook in
   [`docs/ai-tools.md`](./ai-tools.md).
3. **`docs/commands/`-Lücken füllen** — alle Detail-Seiten sind
   geschrieben (Stand 2026-05-19). Wenn neue Befehle dazukommen,
   nicht vergessen pro neuem CLI-Command eine MD-Datei zu liefern
   (CLAUDE.md-Konvention). _(M3-Doku-Sweep erledigt; offen
   bleiben nur künftige neue Befehle.)_
4. **Beispiel-Workflows** — kurze how-to-Dokumente für die häufigsten
   Stacks (Node-API, Python-Pipeline, Atlassian-Forge-Setup).
5. **Image-Aufräumen** — entscheiden, ob die dormant Egress-iptables-
   Mechanik im Image bleibt (opt-in für CI/headless) oder ganz raus
   kann. Heute beides möglich, kein akuter Druck.

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
