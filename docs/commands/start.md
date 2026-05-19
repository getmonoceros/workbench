# `monoceros start`

Fährt den benannten Container hoch. Im Compose-Modus startet das
gleichzeitig den Workspace-Container und alle Compose-Services
(`postgres`, `mysql`, `redis`).

```sh
monoceros start <name>
```

## Zweck

Wenn du den Container mit `monoceros stop` pausiert hast und ihn
wieder brauchst — `start` macht ihn an, ohne neu zu bauen. Im
Gegensatz zu `monoceros apply`:

| Aspekt                                      | `apply` | `start` |
| ------------------------------------------- | ------- | ------- |
| Liest die yml und schreibt das Scaffold neu | ja      | nein    |
| Räumt den alten Container vorher weg        | ja      | nein    |
| Baut bei geänderten Features das Image neu  | ja      | nein    |
| Startet den Container hoch                  | ja      | ja      |

Kurz: `start` ist der billige Lifecycle-Wakeup. `apply` ist die
volle „yml-Änderungen anwenden"-Operation.

## Mechanik

Hinter den Kulissen ein `devcontainer up --workspace-folder <root>`.
Im Compose-Modus inkludiert das den `workspace`-Service plus alle
`runServices` aus der `devcontainer.json` (die aus den `services:`
in der yml generiert wurde).

## Argumente

| Argument | Bedeutung       |
| -------- | --------------- |
| `<name>` | Container-Name. |

## Beispiel

```sh
$ monoceros start sandbox
ℹ Bringing up sandbox …
[+] Running 3/3
 ✔ Container sandbox_devcontainer-postgres-1   Started
 ✔ Container sandbox_devcontainer-workspace-1  Started
 ✔ Network sandbox_devcontainer_default        Created
✔ sandbox is up.
```

## Verwandte Befehle

- [`monoceros stop <name>`](./stop.md) — Compose-Services pausieren
  ohne sie zu entfernen
- [`monoceros status <name>`](./status.md) — anzeigen, was läuft
- [`monoceros apply <name>`](./apply.md) — yml-Änderungen anwenden +
  neu bauen + hochfahren (statt nur hochfahren)
- [`monoceros remove <name>`](./remove.md) — Container restlos
  wegräumen

## Fail-Modi

- **`No .devcontainer/ at <path>`** — Container nie materialisiert.
  `monoceros apply <name>` vorher.
- **Port-Konflikt** — wenn ein anderer Prozess oder Container die
  forwarded Ports (3000, 4000) belegt, schlägt der Workspace-Start
  fehl. Stop den blockenden Prozess oder editiere `forwardPorts`
  in der yml.
