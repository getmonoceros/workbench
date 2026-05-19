# AI-Tools in Monoceros

Monoceros bringt AI-Coding-Tools (Claude Code, Rovo Dev, GitHub
Copilot etc.) als **Devcontainer-Features** in den Container. Pro
Tool ein Feature, das install + Auth + Persistierung gebündelt
mitbringt.

Dieses Dokument fasst zusammen:

- welche AI-Tool-Features heute live sind
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
    "optionHints": ["apiKey"]
  }
}
```

Wichtig:

- `x-monoceros.persistentHomePaths` — welche Subdirs unter
  `/home/node/` der Container-Lifecycle persistent halten muss.
- `x-monoceros.optionHints` — welche Options als kommentierte
  Hint-Zeilen unter dem `options:`-Block in der generierten yml
  auftauchen sollen. Standardmäßig die Auth-relevanten.

### 3. `install.sh`

Läuft als root im Container während `docker build`. Lädt das
Tool, validiert Install, dropt optional einen Post-Create-Hook
unter `/usr/local/share/monoceros/post-create.d/foo.sh` ab — den
ruft Monoceros' generierter `post-create.sh` beim Container-
Start auf, mit den Bind-Mounts unter `/home/node/` schon aktiv.

### 4. Komponenten-Eintrag

Optional, aber empfohlen — damit `monoceros init … --with=foo`
funktioniert:

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
