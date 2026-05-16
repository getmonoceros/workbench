# Monoceros CLI — Befehlsübersicht

Diese Übersicht ist die Anlaufstelle für alle `monoceros …`-Befehle.
Jeder Befehl hat (oder bekommt) eine eigene Detail-Datei.
`monoceros <cmd> --help` zeigt die knappe Variante mit Argumenten und
Optionen; die MD-Dateien hier ergänzen das um Zweck, Beispiele,
Verwandte Befehle und Fail-Modi.

Aufruf der Docs vom Container aus:

```sh
less /opt/monoceros-workbench/docs/commands/<name>.md
```

## Das Konfig-Modell (Stand M2.5 Phase 3)

Eine **Container-Konfig** liegt unter
`.local/container-configs/<name>.yml` und ist die Wahrheit eines
Dev-Containers. Dev-Container-Verzeichnisse referenzieren ihre Konfig
über `.monoceros/state.json` (`origin: <name>`). Mehrere Container
können dieselbe Konfig nutzen.

Typischer Lebenszyklus:

```sh
monoceros init <template> <name>          # Konfig erstellen
vim .local/container-configs/<name>.yml   # anpassen
monoceros apply <name> <dir>              # in ein Verzeichnis materialisieren
cd <dir>
monoceros add-feature …                   # Konfig editieren
monoceros apply                           # gegen die aktuelle Konfig neu bauen
```

Legacy-Solutions (mit `stack.json` aus M1/M2) werden beim ersten
`monoceros apply` automatisch migriert. Details: [apply.md](./apply.md).

## Solution anlegen + Lifecycle

| Befehl                         | Zweck                                                                     | Doku                   |
| ------------------------------ | ------------------------------------------------------------------------- | ---------------------- |
| `monoceros init <tpl> <name>`  | Konfig aus Vorlage erstellen (`.local/container-configs/<name>.yml`)      | [init.md](./init.md)   |
| `monoceros apply <name> [<p>]` | Konfig in einem Verzeichnis materialisieren + Container hochfahren        | [apply.md](./apply.md) |
| `monoceros apply`              | Aktuellen Dev-Container gegen seine Konfig neu anwenden (auch Migrations) | [apply.md](./apply.md) |
| `monoceros create <name>`      | Legacy-Pfad — direkt einen Dev-Container scaffolden (Migrationsziel: yml) | _TODO_                 |
| `monoceros start`              | Devcontainer hochfahren (`devcontainer up` + Services)                    | _TODO_                 |
| `monoceros stop`               | Compose-Services stoppen, Volumes erhalten                                | _TODO_                 |
| `monoceros down [--volumes]`   | Container + Network entfernen, optional Volumes                           | _TODO_                 |
| `monoceros status`             | Compose-Status anzeigen                                                   | _TODO_                 |
| `monoceros logs [--service]`   | Compose-Logs verfolgen                                                    | _TODO_                 |

## Im Container arbeiten

| Befehl                   | Zweck                                                             | Doku   |
| ------------------------ | ----------------------------------------------------------------- | ------ |
| `monoceros shell`        | Interaktive Bash-Session im Container öffnen                      | _TODO_ |
| `monoceros run -- <cmd>` | One-off-Befehl im Container ausführen (Exit-Code wird propagiert) | _TODO_ |

## Konfiguration ändern

### Hinzufügen

| Befehl                            | Zweck                                                                 | Doku                                         |
| --------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| `monoceros add-language <lang>`   | Sprach-Toolchain als Devcontainer-Feature ergänzen (kuratierte Liste) | _TODO_                                       |
| `monoceros add-service <svc>`     | Compose-Service ergänzen (Postgres, Redis, MySQL — kuratierte Liste)  | _TODO_                                       |
| `monoceros add-apt-packages -- …` | Beliebige apt-Pakete ergänzen (kein Whitelist)                        | [add-apt-packages.md](./add-apt-packages.md) |
| `monoceros add-feature <ref>`     | Beliebiges Devcontainer-Feature ergänzen (kein Whitelist)             | [add-feature.md](./add-feature.md)           |
| `monoceros add-from-url <url>`    | HTTPS-Install-Script per `bash <(curl -fsSL …)` registrieren          | [add-from-url.md](./add-from-url.md)         |
| `monoceros add-repo <url>`        | Git-Repo nach `projects/<name>/` klonen (idempotent, post-create)     | [add-repo.md](./add-repo.md)                 |

### Entfernen

| Befehl                                | Zweck                                                                  | Doku                                               |
| ------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| `monoceros remove-language <lang>`    | Sprach-Toolchain entfernen                                             | [remove-language.md](./remove-language.md)         |
| `monoceros remove-service <svc>`      | Compose-Service entfernen (Volumes bleiben — manuelles Cleanup)        | [remove-service.md](./remove-service.md)           |
| `monoceros remove-apt-packages -- …`  | apt-Pakete entfernen                                                   | [remove-apt-packages.md](./remove-apt-packages.md) |
| `monoceros remove-feature <ref>`      | Devcontainer-Feature entfernen                                         | [remove-feature.md](./remove-feature.md)           |
| `monoceros remove-from-url <url>`     | Install-URL entfernen (Install-Resultat bleibt im aktuellen Container) | [remove-from-url.md](./remove-from-url.md)         |
| `monoceros remove-repo <url-or-name>` | Repo-Eintrag entfernen (lokaler `projects/<name>/`-Folder bleibt)      | [remove-repo.md](./remove-repo.md)                 |

## Konventionen für alle Konfig-Befehle

Jeder `add-*`/`remove-*`-Befehl ist **idempotent**: gleicher Aufruf
zweimal → zweite Mal keine Datei-Änderung. Vor dem Schreiben zeigt
jeder Aufruf eine Unified-Diff-Vorschau; `--yes` (oder `-y`)
überspringt den Confirm-Prompt für Skripte.

**Phase-3-Container** (mit `state.json`): Die Befehle editieren die yml,
auf die `state.json.origin` zeigt. Kommentare in der yml werden
preserved. Container-Files werden **nicht direkt** geändert — sie
regenerieren sich beim nächsten `monoceros apply` aus der yml.

**Legacy-Container** (mit `stack.json`, kein `state.json`): Die
Befehle mutieren `stack.json` direkt und regenerieren
`devcontainer.json`/`compose.yaml`/`post-create.sh` in-place — wie
in M2. Das erste `monoceros apply` migriert den Container danach
in das yml-Modell.

In beiden Fällen muss `monoceros apply` laufen, damit die Änderungen
im laufenden Container wirksam werden:

```sh
monoceros add-feature ghcr.io/devcontainers/features/github-cli:1 --yes
monoceros add-apt-packages --yes -- make jq
monoceros apply
```
