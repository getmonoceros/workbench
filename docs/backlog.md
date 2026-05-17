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
| **M3 (neu)** | AI-Tool-Feature-Library                                        | 🔜 nächste Etappe         |
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
- ✅ Runtime-Image-Setup mit Egress-Allowlist via NET_ADMIN + iptables
  (siehe [ADR 0002](./adr/0002-egress-whitelist-runtime-image.md))
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

## 🔜 M3 (neu) — AI-Tool-Feature-Library

**Ziel:** AI-Tools sind erstklassige Bürger in der Container-yml.
Builder schreibt `features: [- ref: …/claude-code:1]` und kriegt das
Tool sauber installiert. Eigene Feature-Library unter
`ghcr.io/kamann/monoceros-features/<tool>:1`.

### Voraussetzung

- Konzept klar (siehe `konzept.md`, „Die drei Bausteine" → AI-Tools)
- Runtime-Image abgerüstet: Claude Code raus aus dem Image (heute
  noch drin), wird Feature

### Tasks

1. **Feature-Library-Verzeichnis** — Layout unter `images/features/<tool>/`
   mit `devcontainer-feature.json` + `install.sh`. Publish-Pipeline
   skizzieren (anfangs manuell via `devcontainer features publish`,
   später GH Action).

2. **Feature `claude-code`** — installiert `@anthropic-ai/claude-code`
   via npm global. Options:
   - `version: 'latest' | <semver>` (Default `latest`)
   - Auth bleibt über den `~/.claude/`-Bind-Mount (M1-Mechanik)

3. **Runtime-Image abrüsten** — `npm install -g @anthropic-ai/claude-code`
   aus dem Dockerfile entfernen. Image-Rebuild. Alle bestehenden
   Templates ergänzen um `features: [- ref: …/claude-code:1]`.

4. **Feature `atlassian`** — installiert `acli` (mit Rovo Dev Agent)
   und/oder TWG-CLI. Options:
   - `rovo_dev: true | false` (Default `false`)
   - `twg: true | false` (Default `false`)
   - Login via `monoceros apply`-Pre-Step: `monoceros-config.yml` →
     `defaults.atlassian.{instance,email,apiToken}` → `.monoceros/atlassian-credentials`
     (Mode 0600) → Feature-`install.sh` liest die Datei und führt
     `acli auth login` / `twg config` aus

5. **`monoceros-config.yml`-Schema erweitern** — neuer Block
   `defaults.atlassian` mit Zod-Validierung; CLI liest und reicht
   beim Apply durch. Sample-Datei ergänzen.

6. **Template-Variante `atlassian`** — `templates/yml/atlassian.yml`
   mit aktiviertem atlassian-Feature, gutem Comment-Block als
   Inline-Doku.

7. **Doku** — `docs/commands/`-Eintrag für die neue Mechanik (kein
   neuer Befehl, aber das Feature-Modell erklärt); kurzes
   `docs/ai-tools.md` als Übersicht über die Library + Roadmap der
   weiteren Features.

8. **Tests** — Schema-Tests für die neuen Config-Felder; Feature-
   Installation manuell verifiziert (es gibt keinen sauberen Unit-Test
   für „Feature im Container materialisiert sich" — Stage C des
   Test-Plans deckt das ab).

### Bewusst nicht in M3

- Weitere AI-Tools (OpenCode, Codex, GitHub Copilot, Aider) — kommen
  später in einer eigenen Etappe, jeweils mit demselben Muster wie
  `claude-code`
- VS-Code-Server / browser-IDE als Feature — siehe „Vorgemerkt für
  später"

### Definition of Done

- ✅ `monoceros init nodejs-github sandbox && monoceros apply sandbox`
  installiert Claude Code via Feature (nicht aus dem Image)
- ✅ `monoceros init atlassian sandbox && monoceros apply sandbox`
  liefert einen Container, in dem `acli` + `twg` ohne weiteres
  manuelles Auth-Setup funktionieren (sofern `monoceros-config.yml`
  die Credentials hält)
- ✅ Feature-Library im GHCR auffindbar unter
  `ghcr.io/kamann/monoceros-features/{claude-code,atlassian}`
- ✅ Stage C des Test-Plans erweitert um Feature-Pfad

---

## 🔜 M4 — Distribution / Go-Live

**Ziel:** Die Workbench wird benutzbar **ohne** dass der Builder das
Workbench-Repo selbst klont.

### Tasks (Skizze)

1. **Runtime-Image nach GHCR pushen** — `ghcr.io/kamann/monoceros-runtime:<tag>`,
   Multi-Arch (amd64 + arm64). Templates und scaffold.ts referenzieren
   den GHCR-Tag statt `monoceros-runtime:dev`.

2. **CLI als npm-Paket publizieren** — `@monoceros/cli` (oder direkt
   `monoceros`) auf npm. `bin`-Eintrag funktioniert via global install.

3. **`pnpm cli`-Workaround retire** — sobald CLI npm-installable ist,
   ist das Root-Script in `package.json` nur noch Dev-Convenience.

4. **Install-Doku** — README im Workbench-Root mit drei Optionen:
   - „Ich nutze die Workbench" (npm install -g + `~/.monoceros/`-Setup)
   - „Ich entwickle an der Workbench" (`pnpm install` + `pnpm cli …`)
   - „Ich nutze die Werkbank schon auf einer Solution" (welche
     Container-yml-Felder gibt's, wie editiere ich Hand)

5. **CI-Skeleton** — GH-Actions für Lint + Typecheck + Test bei jedem
   PR. Auto-Publish-Pipeline für Runtime-Image + npm-Package bei
   Release-Tag.

6. **MONOCEROS_HOME-Default geschärft** — Wenn `npm install -g`
   greift, ist `$MONOCEROS_HOME` standardmäßig `~/.monoceros/`. Erst-
   Run-Erlebnis: `monoceros init bare hello && monoceros apply hello`
   muss out-of-the-box laufen, inkl. automatisch erstelltem
   `~/.monoceros/`-Layout.

### Bewusst nicht in M4

- Eigene Web-UI / Hub
- Multi-User-Hosting
- Cloud-Variante

### Definition of Done

- ✅ Ein Builder ohne Workbench-Checkout kann via `npm install -g`
  und `monoceros init bare hello && monoceros apply hello` einen
  Container hochfahren
- ✅ Stage E-Walkthrough von Außen (Test-Plan) durchgespielt
- ✅ README erklärt, was Monoceros ist und wie man's installiert

---

## 🔜 M5 — Stabilisierung + Doku

**Ziel:** Was M2.5 + M3 + M4 geliefert haben, ist robust und gut
beschrieben.

### Tasks (Skizze)

1. **Test-Plan überarbeiten** — Stages A–D aktualisieren auf das neue
   Modell (`monoceros init` + `apply <name>`, keine `create`-
   Referenzen mehr). Stage C als End-to-End-Strecke pro Template.
2. **AI-Tool-Library erweitern** — OpenCode, Codex, GitHub Copilot,
   Aider als Features dazu, mit jeweils eigenen Templates.
3. **`docs/commands/`-Lücken füllen** — die `_TODO_`-Einträge für
   `shell` / `run` / `start` / `stop` / `down` / `status` / `logs` /
   `add-language` / `add-service` ergänzen.
4. **Beispiel-Workflows** — kurze how-to-Dokumente für die häufigsten
   Stacks (Node-API, Python-Pipeline, Atlassian-Forge-Setup).
5. **Egress-Allowlist-Tuning** — Default-Allowlist auditieren, gute
   Dokumentation wie man sie pro Container erweitert.

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
