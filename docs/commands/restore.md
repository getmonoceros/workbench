# `monoceros restore`

Stellt einen Container aus einem `monoceros remove`-Backup wieder
her. Kopiert die yml-Quelle und das Container-Verzeichnis zurück
nach `$MONOCEROS_HOME`, sodass `monoceros apply <name>` den
Container danach wieder hochfahren kann.

```sh
monoceros restore <backup-path>
```

## Zweck

`monoceros remove` schreibt vor dem Löschen ein Backup nach
`container-backups/<name>-<timestamp>/`. `restore` ist der
Gegenbefehl: nimmt so ein Verzeichnis, packt es wieder in das
`$MONOCEROS_HOME`-Layout zurück.

Wann wirst du das brauchen?

- Container versehentlich gelöscht.
- Container für ein anderes Setup pausiert und später wieder
  reaktiviert.
- Container von einer Maschine auf eine andere übertragen
  (Backup-Verzeichnis kopieren, dann auf der Zielmaschine
  `monoceros restore` aufrufen).

## Mechanik

1. **Backup einlesen**: prüft dass `<backup-path>` ein Verzeichnis
   ist, sucht eine `*.yml` im Root, leitet daraus den Container-
   Namen ab (Datei `<name>.yml`).
2. **Überlebenscheck**: refuses to clobber. Bricht mit einer
   klaren Fehlermeldung ab, wenn
   - `$MONOCEROS_HOME/container-configs/<name>.yml` schon existiert
   - oder `$MONOCEROS_HOME/container/<name>/` schon existiert
     (und das Backup einen Container-Ordner enthält). Lösung:
     `monoceros remove <name>` zuerst.
3. **Kopieren**: `<backup>/<name>.yml` → `container-configs/<name>.yml`,
   `<backup>/container/` → `container/<name>/` (rekursiv). Inklusive
   `home/`, `projects/`, `data/`, `.monoceros/`.
4. **Hint**: gibt aus, dass `monoceros apply <name>` als nächster
   Schritt fehlt — die Docker-Objekte legt restore nicht selbst an.

## Argumente

| Argument        | Bedeutung                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `<backup-path>` | Pfad zu einem Backup-Verzeichnis (typischerweise `<MONOCEROS_HOME>/container-backups/<name>-<timestamp>/`). |

## Beispiel

```sh
$ ls ~/.monoceros/container-backups/
sandbox-2026-05-19T10-15-22-401Z
sandbox-2026-05-19T11-41-42-582Z

$ monoceros restore ~/.monoceros/container-backups/sandbox-2026-05-19T11-41-42-582Z
✔ Restored 'sandbox' from container-backups/sandbox-2026-05-19T11-41-42-582Z.
ℹ Run `monoceros apply sandbox` to bring the container back up.

$ monoceros apply sandbox
```

## Verwandte Befehle

- [`monoceros remove <name>`](./remove.md) — Container wegräumen
  (schreibt das Backup, das `restore` einliest)
- [`monoceros apply <name>`](./apply.md) — den restaurierten
  Container hochfahren

## Fail-Modi

- **`Backup not found`** — Pfad existiert nicht. Vertippt?
- **`Backup path is not a directory`** — Pfad zeigt auf eine Datei.
- **`Backup at … doesn't contain a *.yml`** — das Backup ist nicht
  von `monoceros remove`. Restore erwartet eine einzelne `<name>.yml`
  im Root.
- **`Refusing to restore: … already exists`** — am Ziel existiert
  bereits ein Container mit demselben Namen. `monoceros remove`
  zuerst, dann `restore` erneut.
