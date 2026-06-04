# AI-Tools in Monoceros

Monoceros bringt AI-Coding-Tools (Claude Code, Rovo Dev, GitHub
Copilot etc.) als **Devcontainer-Features** in den Container. Pro
Tool ein Feature, das install + Auth + Persistierung gebündelt
mitbringt.

Dieses Dokument fasst zusammen:

- welche AI-Tool-Features heute live sind
- wie das **Container-Briefing** (`AGENTS.md` / `CLAUDE.md` /
  `.monoceros/commands.md`) den im Container laufenden AI-Tools sagt,
  was tatsächlich verfügbar ist
- was im selben Pattern später dazukommen soll
- wie ein neues Tool-Feature gebaut wird

Der konzeptionelle Überbau (warum Features, warum yml-Modell)
steht in [konzept.md](./konzept.md). Der State-Modell-Hintergrund
(warum jeder Container ein eigenes `home/` hat) in
[ADR 0003](./adr/0003-container-state-model.md).

## Live heute

| Feature       | Tool                                       | Auth-Mechanik                                                                        |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `claude-code` | Anthropic Claude Code CLI                  | Subscription/OAuth via `claude` interaktiv, ODER `apiKey` für ANTHROPIC_API_KEY-Mode |
| `atlassian`   | Atlassian-Stack: Rovo Dev (`acli`) + `twg` | `apiToken` für non-interactive Login bei beiden Sub-Tools                            |
| `github-cli`  | GitHub CLI (`gh`)                          | `apiToken` als `GH_TOKEN` für transparente Auth                                      |

Alle drei nutzen das gleiche Pattern:

1. **Feature-Install** lädt das Tool ins Container-Image
   (npm/apt/curl je nach Tool).
2. **Persistente Home-Subpfade** (`~/.claude`, `~/.config/acli`,
   `~/.rovodev`, `~/.config/gh`, `~/.agents`) werden über
   `x-monoceros.persistentHomePaths` deklariert und bind-gemountet
   aus `<container-dir>/home/<subpath>`. Logins, Session-History,
   Skills überleben damit jedes `monoceros apply`.
3. **Auth-Optionen** kommen entweder pro Container in der yml
   (`features[].options.apiToken: …`) oder global einmalig in
   `monoceros-config.yml` unter
   `defaults.features.<ref>.<option>`. Per-Container gewinnt beim
   Merge.
4. **Post-Create-Hook** macht den eigentlichen Login. Idempotent
   für Tools die wir kontrollieren; bei Token-Rotation in der yml
   propagiert die Änderung automatisch beim nächsten Apply.

## Auth-Token im Klartext: was geschieht damit?

- **Während des Builds** werden Tokens via Feature-Options als
  Build-Args an `docker build` durchgereicht. Der Build-Output
  läuft durch unseren [Secret-Masker](../packages/cli/src/util/mask-secrets.ts),
  der bekannte Token-Shapes (`ATATT…`, `ghp_…`, `sk-ant-…`, …)
  mit Prefix + letzten 6 Zeichen darstellt. So bleibt der Token
  identifizierbar, aber nicht ablesbar.
- **Auf der Disk** liegen Tokens als Klartext in der Container-yml
  und ggf. in der `monoceros-config.yml`. Diese Dateien sind
  bewusst nicht in Git (`.gitignored` per Default). Wer Secrets
  weiter absichern will: später optional `env:`-Indirection oder
  Secret-Manager-Hook (siehe Backlog → „Vorgemerkt für später").

## Container-Briefing — `AGENTS.md` / `CLAUDE.md`

Ein AI-Tool, das im Container läuft, weiß out-of-the-box nicht, was
für ein Stack hier materialisiert wurde. Eine Java-Werkbank riskiert,
dass Claude ein Node-Backend vorschlägt — schlicht weil Claude nicht
weiß, dass kein Node da ist. Beim `apply` schreibt Monoceros deswegen
drei Dateien an den Container-Workspace-Root, die das Briefing
übernehmen.

### Was geschrieben wird

```
<container-dir>/
├── AGENTS.md               ← Stack-Briefing + Verhaltens-Regeln
├── CLAUDE.md               ← @AGENTS.md (Import-Stub)
└── .monoceros/
    └── commands.md         ← komplette CLI-Referenz
```

- **`AGENTS.md`** — der eigentliche Briefing-Inhalt. Beschreibt:
  - welche Sprachen, Services, Tools, Repos und Ports im Container
    sind (aus der yml abgeleitet);
  - das Monoceros-Modell selbst (deklarativ, container-isoliert,
    Host-Erweiterung via `monoceros add-*` + `apply`);
  - wie das AI-Tool auf fehlende Capabilities reagieren soll
    (Vorschlag des passenden Host-Befehls als copy-paste-fähiger
    Code-Block).
- **`CLAUDE.md`** — eine einzige Zeile `@AGENTS.md`. Claude Codes
  dokumentierter Mechanismus für AGENTS.md-Koexistenz. OpenCode liest
  beide Dateien direkt und käme auch ohne diesen Stub aus.
- **`.monoceros/commands.md`** — Auto-generiert aus den citty-defs in
  `packages/cli/src/commands/*.ts`. Eine H3 pro Subcommand mit
  Signatur, Argumenten und Flags. `AGENTS.md` importiert sie via
  `@.monoceros/commands.md` — so kann das AI-Tool die exakte
  Befehls-Syntax nachschlagen, bevor es einen Vorschlag macht.

### Wie das Briefing zum AI-Tool kommt

Die Dateien liegen **eine Ebene über** den Projekten. Claude Code,
OpenCode und andere Tools, die hierarchisch von ihrem cwd nach oben
walken, finden sie automatisch — egal von welchem `projects/<repo>/`
aus die Session gestartet wird.

> **Beim ersten Claude-Start in einem Projekt:** Claude zeigt einen
> Approval-Dialog "Allow external CLAUDE.md file imports?" — weil
> `AGENTS.md` und `.monoceros/commands.md` außerhalb des
> Projekt-Verzeichnisses liegen. **Akzeptieren ist sicher und nötig**:
> die Dateien sind Monoceros-generiert, nicht von Dritten. Decline
> ist **permanent** für dieses Projekt (kein Re-Prompt) — das
> Briefing bleibt dann unsichtbar.
>
> Pro Projekt einmal Approve. Bei drei Projekten unter `projects/`
> heißt das drei einmalige Prompts.

Codex (begrenzt durch git-root nach unten), Gemini CLI ("trusted
root", noch ungeklärt) und GitHub Copilot (workspace-root only, in
Multi-Root buggy) sehen das Briefing **heute nicht** — sie sind
bewusst aufgeschoben, siehe
[Backlog → "Vorgemerkt für später (jenseits M6)"](./backlog.md#vorgemerkt-für-später-jenseits-m6).

### User-Notizen überleben Re-Apply

`AGENTS.md` ist von HTML-Kommentar-Markern umgeben:

```markdown
<!-- monoceros:begin -->

… Monoceros-generierter Inhalt …

<!-- monoceros:end -->

## My own notes

(Anything outside the markers is yours. Apply preserves it.)
```

Jedes `monoceros apply` ersetzt **nur** den Inhalt zwischen den
Markern. Was du außerhalb schreibst (eigene Coding-Standards,
Projekt-spezifische Erinnerungen), bleibt erhalten.
`CLAUDE.md` und `.monoceros/commands.md` sind 100% Monoceros-eigen
und werden immer komplett neu geschrieben.

Alle drei Dateien sind in der container-root `.gitignore` —
falls dort jemals `git init` läuft, landen sie nicht im Repo.

### Keine Credentials im Briefing

Die Datei enthält bewusst **keine** Service-Credentials, weder
Dev-Defaults aus dem Catalog noch Werte aus der `.env`. Das Briefing
weist das AI-Tool an, den User in der laufenden Session zu fragen
wenn es Credentials braucht, und sie nicht in versioniertes Material
zu schreiben.

Hintergrund: `AGENTS.md` wird zwar wie die `.env` als local-only
behandelt und ist gitignored — aber sie ist eine zusätzliche
Oberfläche (Screenshot, Paste, Share mit anderen AI-Tools). Die
"keine Credentials"-Linie macht diese Oberfläche unkritisch.

### Feature-Briefings manifest-gesteuert

Jedes Feature kann im eigenen `devcontainer-feature.json` deklarieren,
mit welchen Zeilen es in der "Installed tools"-Sektion der `AGENTS.md`
auftaucht. Bedingungen erlaubt:

```json
"x-monoceros": {
  "briefing": {
    "lines": [
      {
        "whenOption": "rovodev",
        "text": "Atlassian Rovo Dev — invoke via `acli rovodev`. Pre-authenticated against the Atlassian account in the feature options."
      },
      {
        "whenOption": "twg",
        "text": "Atlassian Teamwork Graph CLI (`twg`) — Jira / Confluence / Bitbucket / JSM / Assets access."
      }
    ]
  }
}
```

- **`text`** — der Bullet-Inhalt (ohne `- ` davor). Markdown,
  Inline-Code erlaubt.
- **`whenOption`** — optional. Wenn gesetzt, wird die Zeile nur
  emittiert, wenn die genannte Feature-Option zur Apply-Zeit
  **truthy** ist (Boolean `true`, nicht-leerer String, Zahl ≠ 0).
  Ohne `whenOption` ist die Zeile unbedingt.
- Defaults werden aus den Feature-Manifest-Options gezogen; User-
  Werte in der Container-yml gewinnen.

Konsequenzen:

- Ein Feature mit zwei Sub-Tools (z. B. `atlassian` mit `rovodev` +
  `twg`) hat zwei Zeilen, eine pro Sub-Tool. Wird eines abgeschaltet
  (`twg: false`), verschwindet auch nur diese Zeile.
- Wenn ein Feature ein `briefing`-Block deklariert aber **keine**
  Zeile matched (alle `whenOption` sind falsy), wird das Feature
  **stillschweigend weggelassen** — kein "Tool installiert" wenn
  keins läuft.
- Ohne `x-monoceros.briefing` fällt der Generator auf den
  `displayName` aus dem Component-Katalog
  (`packages/cli/templates/components/<name>.yml`) zurück, oder bei
  Dritt-Features auf den letzten Pfad-Segment-Namen der OCI-Ref.

### Hintergrund

Design-Entscheid und Trade-offs:
[ADR 0014 — AI-Tool-Briefing im Container-Workspace-Root](./adr/0014-ai-tool-briefing-im-workspace-root.md).
Implementierung lebt unter `packages/cli/src/briefing/`.

## Was später dazukommen soll

Geplant (siehe [backlog.md](./backlog.md) M5):

- **OpenCode** — sst's Open-Source-Multi-Modell-CLI
- **Codex** — OpenAI Codex CLI
- **GitHub Copilot CLI** — `gh extension install github/gh-copilot`
- **Aider** — Python-basiertes Pair-Programming-CLI

Jedes wird im gleichen Muster gebaut wie `claude-code`:
Install via package manager → `persistentHomePaths` für Auth-Dir
→ optional `optionHints` im Manifest für die UX-Auth-Anzeige im
`init`-Output.

## Wie kommt ein neues Tool-Feature dazu?

Kochrezept, am Beispiel eines fiktiven Tools `foo`:

### 1. Feature-Verzeichnis

```
images/features/foo/
├── devcontainer-feature.json
└── install.sh
```

### 2. `devcontainer-feature.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/devcontainers/spec/main/schemas/devContainerFeature.schema.json",
  "id": "foo",
  "name": "Foo CLI",
  "version": "0.1.0",
  "description": "Installs the Foo CLI. Auth via apiKey or interactive `foo auth login`.",
  "options": {
    "apiKey": {
      "type": "string",
      "default": "",
      "description": "Foo API key. Exported as FOO_API_KEY when set."
    }
  },
  "customizations": {
    "vscode": { "extensions": ["foo.vscode-foo"] }
  },
  "x-monoceros": {
    "persistentHomePaths": [".config/foo"],
    "optionHints": ["apiKey"],
    "briefing": {
      "lines": [
        {
          "text": "Foo CLI (`foo`) — invoke directly. Pre-authenticated when `apiKey` was set; otherwise needs `foo auth login` once."
        }
      ]
    }
  }
}
```

Wichtig:

- `x-monoceros.persistentHomePaths` — welche Subdirs unter
  `/home/node/` der Container-Lifecycle persistent halten muss.
- `x-monoceros.optionHints` — welche Options als kommentierte
  Hint-Zeilen unter dem `options:`-Block in der generierten yml
  auftauchen sollen. Standardmäßig die Auth-relevanten.
- `x-monoceros.briefing.lines` — die Bullets, die in `AGENTS.md`
  unter "Installed tools" auftauchen. Eine Zeile für ein simples
  Tool; mehrere mit `whenOption`-Gating wenn das Feature mehrere
  Sub-Tools über Bool-Options ein-/ausschaltet (siehe
  [Container-Briefing](#container-briefing--agentsmd--claudemd)
  weiter oben).

### 3. `install.sh`

Läuft als root im Container während `docker build`. Lädt das
Tool, validiert Install, dropt optional einen Post-Create-Hook
unter `/usr/local/share/monoceros/post-create.d/foo.sh` ab — den
ruft Monoceros' generierter `post-create.sh` beim Container-
Start auf, mit den Bind-Mounts unter `/home/node/` schon aktiv.

### 4. Komponenten-Eintrag

Optional, aber empfohlen — damit `monoceros init … --with-features=foo`
funktioniert (und der Kurzname in `list-components` auftaucht):

```
templates/components/foo.yml
```

```yaml
displayName: Foo CLI
description: |
  Installs Foo CLI via apt. Auth via apiKey or interactive
  `foo auth login` on first use; state persists in ~/.config/foo.
category: feature
contributes:
  features:
    - ref: ghcr.io/getmonoceros/monoceros-features/foo:1
```

### 5. Docs

In dieser Datei einen Eintrag in der „Live heute"-Tabelle
ergänzen, plus eine kurze Beschreibung wenn das Feature Spezial-
Verhalten hat (z.B. wie sich `atlassian` mit Rovo-Dev+twg in
einem Feature bündelt).

## Verwandte Dokumente

- [konzept.md](./konzept.md) — der Überbau
- [adr/0003-container-state-model.md](./adr/0003-container-state-model.md)
  — warum jeder Container ein eigenes `home/` hat
- [commands/init.md](./commands/init.md) — `--with` und
  Versions-Suffix
- [commands/apply.md](./commands/apply.md) — was beim Apply
  passiert
- [images/features/README.md](../images/features/README.md) —
  Workbench-interne Konventionen für Feature-Autoren
