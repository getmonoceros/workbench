# Monoceros CLI — Befehlsübersicht

Diese Übersicht ist die Anlaufstelle für alle `monoceros …`-Befehle.
Jeder Befehl hat (oder bekommt) eine eigene Detail-Datei. `monoceros <cmd> --help`
zeigt die knappe Variante mit Argumenten und Optionen; die MD-Dateien
hier ergänzen das um Zweck, Beispiele, Verwandte Befehle und Fail-Modi.

Aufruf der Docs vom Container aus:

```sh
less /opt/monoceros-workbench/docs/commands/<name>.md
```

## Solution anlegen + Lifecycle

| Befehl                       | Zweck                                                                    | Doku   |
| ---------------------------- | ------------------------------------------------------------------------ | ------ |
| `monoceros create <name>`    | Neue Solution scaffolden (Devcontainer, Plugin-Wiring, Workspace-Layout) | _TODO_ |
| `monoceros start`            | Devcontainer hochfahren (`devcontainer up` + Services)                   | _TODO_ |
| `monoceros stop`             | Compose-Services stoppen, Volumes erhalten                               | _TODO_ |
| `monoceros down [--volumes]` | Container + Network entfernen, optional Volumes                          | _TODO_ |
| `monoceros status`           | Compose-Status anzeigen                                                  | _TODO_ |
| `monoceros logs [--service]` | Compose-Logs verfolgen                                                   | _TODO_ |
| `monoceros apply`            | Devcontainer neu bauen nach `add-*`-Änderungen                           | _TODO_ |

## Im Container arbeiten

| Befehl                   | Zweck                                                             | Doku   |
| ------------------------ | ----------------------------------------------------------------- | ------ |
| `monoceros shell`        | Interaktive Bash-Session im Container öffnen                      | _TODO_ |
| `monoceros run -- <cmd>` | One-off-Befehl im Container ausführen (Exit-Code wird propagiert) | _TODO_ |

## Konfiguration ändern

| Befehl                            | Zweck                                                                 | Doku                                         |
| --------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| `monoceros add-language <lang>`   | Sprach-Toolchain als Devcontainer-Feature ergänzen (kuratierte Liste) | _TODO_                                       |
| `monoceros add-service <svc>`     | Compose-Service ergänzen (Postgres, Redis, MySQL — kuratierte Liste)  | _TODO_                                       |
| `monoceros add-apt-packages -- …` | Beliebige apt-Pakete ergänzen (kein Whitelist)                        | [add-apt-packages.md](./add-apt-packages.md) |
| `monoceros add-feature <ref>`     | Beliebiges Devcontainer-Feature ergänzen (kein Whitelist)             | [add-feature.md](./add-feature.md)           |
| `monoceros add-from-url <url>`    | HTTPS-Install-Script per `bash <(curl -fsSL …)` registrieren          | [add-from-url.md](./add-from-url.md)         |

## Konvention für alle Konfig-Befehle

Jeder `add-*`-Befehl ist **idempotent**: gleicher Aufruf zweimal → zweite Mal
keine Datei-Änderung. Vor dem Schreiben zeigt jeder Aufruf eine
Unified-Diff-Vorschau; `--yes` (oder `-y`) überspringt den Confirm-Prompt
für Skripte.

Nach jedem `add-*` muss `monoceros apply` laufen, damit die Änderungen
im laufenden Container wirksam werden — die Befehle schreiben nur in
`.devcontainer/devcontainer.json` und `.monoceros/stack.json`,
nicht in den Container selbst.

```sh
monoceros add-feature ghcr.io/devcontainers/features/github-cli:1 --yes
monoceros add-apt-packages --yes -- make jq
monoceros apply
```
