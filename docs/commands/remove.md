# `monoceros remove`

Räumt alles weg, was zu einem Container gehört — Docker-Objekte,
yml-Konfig und das materialisierte Verzeichnis. Schreibt vorher ein
Backup, sodass nichts unwiderruflich verloren geht.

```sh
monoceros remove <name> [--no-backup] [-y]
```

## Zweck

Der Endpunkt für „Container brauche ich nicht mehr." Im Gegensatz zu
`monoceros stop` (nur pausieren) räumt `remove` wirklich alles
weg:

- Docker-Container der Compose-Services + Image-Mode-Container
- Compose-Netzwerk
- yml-Quelle unter `container-configs/<name>.yml`
- materialisierter Container-Ordner unter `container/<name>/`
  inklusive `home/`, `projects/`, `.monoceros/` und `data/`
  (DB-Inhalte landen jetzt dort als Bind-Mount, siehe
  [ADR 0003](../adr/0003-container-state-model.md))

Was **nicht** weg geräumt wird:

- Geteilte Docker-Images (`monoceros-runtime:dev`, Postgres-Basis,
  …) — die nutzen andere Container ggf. weiter. Aufräumen via
  `docker image prune` wenn gewünscht.

## Mechanik

In dieser Reihenfolge:

1. **Confirm-Prompt** zeigt was passieren wird. Mit `-y` skippen.
2. **Docker-Cleanup**: stoppt + entfernt alle Container, die zum
   Projekt gehören (per Compose-Label, per Container-Namens-Präfix,
   plus der Image-Mode-`vsc-<name>-…`-Container). Räumt das
   Compose-Netzwerk `<name>_devcontainer_default` mit.
3. **Backup** (default an, mit `--no-backup` aus): kopiert
   `<name>.yml` und das gesamte `container/<name>/`-Verzeichnis
   nach `$MONOCEROS_HOME/container-backups/<name>-<timestamp>/`.
   Plain-Verzeichnis-Tree — kein tar, einfach mit `cp -r`
   zurückholbar.
4. **Löschen**: yml + Container-Verzeichnis von der Disk.

## Arguments

| Argument | Bedeutung                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>` | Container-Name. Es muss eine yml unter `container-configs/` UND/ODER ein materialisiertes `container/<name>/`-Verzeichnis geben — sonst Error. |

## Options

| Option        | Bedeutung                                                                 |
| ------------- | ------------------------------------------------------------------------- |
| `--no-backup` | Backup-Schritt überspringen. Host-State ist danach unwiederbringlich weg. |
| `-y, --yes`   | Confirm-Prompt überspringen (für Scripts).                                |

## Beispiele

Konservativ — mit Backup und Confirm:

```sh
$ monoceros remove sandbox
 ▲ About to remove 'sandbox'. A backup will be written to
   container-backups/ first, then docker objects, container-configs
   entry, and container directory will all be deleted.
Continue? [y/N] y
ℹ Backup written to container-backups/sandbox-2026-05-19T08-12-44-501Z.
✔ Removed 'sandbox': docker objects gone, container-configs entry deleted, container directory deleted.
```

Für Scripts oder wenn man sicher ist:

```sh
$ monoceros remove sandbox --no-backup -y
✔ Removed 'sandbox': docker objects gone, container-configs entry deleted, container directory deleted.
 ▲ No backup created (--no-backup). The host-side state is gone for good.
```

## Verwandte Befehle

- [`monoceros stop <name>`](./stop.md) — nur pausieren, alles bleibt
- `monoceros init <name>` + `apply <name>` — Container neu aufsetzen
  (siehe [init.md](./init.md), [apply.md](./apply.md))

## Fail-Modi

- **`Nothing to remove for '<name>'`** — weder yml noch
  Container-Verzeichnis existieren. Tippfehler? `ls container-configs/`
  zur Kontrolle.
- **`Invalid config name`** — `<name>` enthält Slash, Space oder
  Shell-Metazeichen. Erlaubt: `[A-Za-z0-9._-]+`.
- **Docker-Cleanup-Exit-Code ≠ 0** — irgendwas in der Docker-
  Pipeline hat gehakt. Der Befehl bricht ab, **bevor** das Backup
  oder das Löschen passiert — also kein partieller Zustand.

## Wenn das Backup nicht reicht

DB-Daten liegen heute unter `container/<name>/data/<service>/`
auf der Host-Disk und sind im Backup automatisch mit drin. Wenn
du eine logische Sicherung willst (z. B. SQL-Dump statt
File-Snapshot), `pg_dump` oder Äquivalent **vor** `monoceros
remove` einplanen — der Container muss noch laufen damit's was
zum Dumpen gibt.
