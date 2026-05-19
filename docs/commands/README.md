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

## Das Konfig-Modell

Alle Befehle folgen einem einheitlichen Schema:

```sh
monoceros <command> <containername> [<args> …]
```

`<containername>` ist immer das erste positional Argument. cwd spielt
keine Rolle — Monoceros findet alles über Konvention. Das Layout:

```
$MONOCEROS_HOME/
├── monoceros-config.yml               ← optionale, persönliche Defaults
├── monoceros-config.sample.yml        ← committed (Marker + Vorlage)
├── container-configs/
│   └── <name>.yml                     ← Container-Konfig (`monoceros init`)
└── container/
    └── <name>/                        ← materialisierter Dev-Container
                                         (`monoceros apply`)
```

`MONOCEROS_HOME` wird in dieser Reihenfolge aufgelöst:

1. Env-Var `MONOCEROS_HOME`
2. Dev-Detection: aufwärts vom CLI-Modul suchen nach
   `<dir>/.local/monoceros-config.sample.yml` → `<dir>/.local`
3. Fallback `~/.monoceros`

## Typischer Lebenszyklus

```sh
monoceros init <name> --with=node,postgres,github,claude  # Konfig komponieren
vim $MONOCEROS_HOME/container-configs/<name>.yml          # anpassen (optional)
monoceros apply <name>                                    # Dev-Container materialisieren + hochfahren
monoceros shell <name>                                    # darin arbeiten
monoceros add-feature <name> <ref>                        # Konfig editieren
monoceros apply <name>                                    # neu bauen, picks up the change
```

## Solution anlegen + Lifecycle

| Befehl                                  | Zweck                                                  | Doku                                       |
| --------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| `monoceros init <name> [--with=]`       | Konfig aus Komponenten komponieren (oder dokumentierte | [init.md](./init.md)                       |
|                                         | Vorlage erzeugen, wenn --with weggelassen)             |                                            |
| `monoceros list-components`             | Komponenten-Katalog anzeigen                           | [list-components.md](./list-components.md) |
| `monoceros apply <name>`                | Konfig materialisieren + Container hochfahren          | [apply.md](./apply.md)                     |
| `monoceros start <name>`                | Devcontainer hochfahren (`devcontainer up` + Services) | [start.md](./start.md)                     |
| `monoceros stop <name>`                 | Compose-Services stoppen, Daten bleiben                | [stop.md](./stop.md)                       |
| `monoceros status <name>`               | Compose-Status anzeigen                                | [status.md](./status.md)                   |
| `monoceros logs <name> [...]`           | Compose-Logs verfolgen                                 | [logs.md](./logs.md)                       |
| `monoceros remove <name> [--no-backup]` | Container restlos wegräumen (Backup by default)        | [remove.md](./remove.md)                   |
| `monoceros restore <backup-path>`       | Container aus einem remove-Backup wiederherstellen     | [restore.md](./restore.md)                 |

## Im Container arbeiten

| Befehl                          | Zweck                                                   | Doku                   |
| ------------------------------- | ------------------------------------------------------- | ---------------------- |
| `monoceros shell <name>`        | Interaktive Bash-Session im Container                   | [shell.md](./shell.md) |
| `monoceros run <name> -- <cmd>` | One-off-Befehl im Container (Exit-Code wird propagiert) | [run.md](./run.md)     |

## Konfiguration ändern

### Hinzufügen

| Befehl                                      | Zweck                                                                 | Doku                                         |
| ------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| `monoceros add-language <name> <lang>`      | Sprach-Toolchain als Devcontainer-Feature ergänzen (kuratierte Liste) | [add-language.md](./add-language.md)         |
| `monoceros add-service <name> <svc>`        | Compose-Service ergänzen (Postgres, Redis, MySQL — kuratierte Liste)  | [add-service.md](./add-service.md)           |
| `monoceros add-apt-packages <name> -- …`    | Beliebige apt-Pakete ergänzen (kein Whitelist)                        | [add-apt-packages.md](./add-apt-packages.md) |
| `monoceros add-feature <name> <ref> [-- …]` | Beliebiges Devcontainer-Feature ergänzen                              | [add-feature.md](./add-feature.md)           |
| `monoceros add-from-url <name> <url>`       | HTTPS-Install-Script per `curl … \| sh` registrieren                  | [add-from-url.md](./add-from-url.md)         |
| `monoceros add-repo <name> <url> [--as=…]`  | Git-Repo nach `projects/<folder>/` klonen (idempotent, post-create)   | [add-repo.md](./add-repo.md)                 |

### Entfernen

| Befehl                                       | Zweck                                                                  | Doku                                               |
| -------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| `monoceros remove-language <name> <lang>`    | Sprach-Toolchain entfernen                                             | [remove-language.md](./remove-language.md)         |
| `monoceros remove-service <name> <svc>`      | Compose-Service entfernen (Volumes bleiben — manuelles Cleanup)        | [remove-service.md](./remove-service.md)           |
| `monoceros remove-apt-packages <name> -- …`  | apt-Pakete entfernen                                                   | [remove-apt-packages.md](./remove-apt-packages.md) |
| `monoceros remove-feature <name> <ref>`      | Devcontainer-Feature entfernen                                         | [remove-feature.md](./remove-feature.md)           |
| `monoceros remove-from-url <name> <url>`     | Install-URL entfernen (Install-Resultat bleibt im aktuellen Container) | [remove-from-url.md](./remove-from-url.md)         |
| `monoceros remove-repo <name> <url-or-name>` | Repo-Eintrag entfernen (lokaler `projects/<folder>/`-Folder bleibt)    | [remove-repo.md](./remove-repo.md)                 |

## Konventionen für alle Konfig-Befehle

Jeder `add-*`/`remove-*`-Befehl ist **idempotent**: gleicher Aufruf
zweimal → zweite Mal keine Datei-Änderung. Vor dem Schreiben zeigt
jeder Aufruf eine Unified-Diff-Vorschau; `--yes` (oder `-y`)
überspringt den Confirm-Prompt für Skripte.

Die Befehle editieren die yml unter `container-configs/<name>.yml` —
Kommentare und Layout der Datei bleiben **erhalten**. Container-Files
(devcontainer.json, compose.yaml, post-create.sh) werden **nicht
direkt** geändert; sie regenerieren sich beim nächsten
`monoceros apply <name>` aus der yml.

```sh
monoceros add-feature sandbox ghcr.io/devcontainers/features/github-cli:1 --yes
monoceros add-apt-packages sandbox --yes -- htop tmux
monoceros apply sandbox
```

## Globale Defaults: `monoceros-config.yml`

Optional unter `$MONOCEROS_HOME/monoceros-config.yml`. Heute trägt sie
genau ein Feld: Default-Git-Identity, die in jedem materialisierten
Container greift, wenn die Container-yml selbst nichts angibt und der
Host kein global `git config` hat. Eine Sample-Vorlage liegt unter
`monoceros-config.sample.yml` neben dran.

Priorität der Git-Identity-Auflösung (`monoceros apply`):

1. `git.user` in der Container-yml (höchste Priorität)
2. `defaults.git.user` in `monoceros-config.yml`
3. `git config --global --get user.name|email` auf dem Host
4. Wert aus früherem Apply in `.monoceros/gitconfig`
5. Interaktiver Prompt (übersprungen in nicht-TTY-Umgebungen)
