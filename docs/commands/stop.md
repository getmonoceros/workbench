# `monoceros stop`

Pausiert die Compose-Services des benannten Containers. Daten und
Container-Layer bleiben erhalten; ein `monoceros start` weckt
denselben Zustand wieder auf.

```sh
monoceros stop <name> [--service <svc>]
```

## Zweck

Wenn du mit dem Container gerade nicht arbeitest und ihm CPU/RAM
zurückgeben willst — aber später wieder genau da weiter willst
wo du aufgehört hast.

Wichtig was `stop` **nicht** macht:

- Räumt keine Container weg (anders als `remove`)
- Räumt keine Daten weg
- Räumt keine Docker-Images weg
- Sparpotential beim Festplattenplatz: praktisch keines

Wenn du wirklich Platz brauchst → [`monoceros remove`](./remove.md).

## Mechanik

`docker compose stop` darunter. Die Container bleiben in `Exited`-
Status, ihre Volumes und das Compose-Netzwerk bleiben unverändert.
Daten liegen ohnehin als Bind-Mounts unter `container/<name>/data/`
auf der Host-Disk (siehe [ADR 0003](../adr/0003-container-state-model.md))
und sind komplett unabhängig vom Lifecycle.

## Argumente

| Argument | Bedeutung       |
| -------- | --------------- |
| `<name>` | Container-Name. |

## Optionen

| Option            | Bedeutung                                                                              |
| ----------------- | -------------------------------------------------------------------------------------- |
| `--service <svc>` | Nur einen Compose-Service stoppen (z.B. `--service postgres`). Default: alle Services. |

## Beispiele

Alles pausieren:

```sh
$ monoceros stop sandbox
✔ Stopped sandbox_devcontainer
```

Nur den DB-Container, Workspace weiter laufen lassen:

```sh
$ monoceros stop sandbox --service postgres
✔ Stopped postgres
```

## Verwandte Befehle

- [`monoceros start <name>`](./start.md) — wieder hochfahren
- [`monoceros status <name>`](./status.md) — anzeigen welche Services
  gerade laufen oder gestoppt sind
- [`monoceros remove <name>`](./remove.md) — restlos wegräumen
  (Backup default an)

## Fail-Modi

- **`No compose.yaml at <path>`** — der Container ist im
  Image-Mode (keine Compose-Services konfiguriert). `stop` greift
  dann nicht, weil es nichts zu stoppen gibt; nutze Docker direkt
  oder schreibe einen Service in die yml.
- **Compose-Service unbekannt** — `--service foo` wird durch
  `docker compose` selbst gemeldet wenn `foo` nicht in
  `compose.yaml` ist.
