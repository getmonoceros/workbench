# `monoceros status`

Zeigt welche Compose-Services des benannten Containers gerade
laufen, gestoppt sind oder noch nie hochgefahren wurden.

```sh
monoceros status <name> [--service <svc>]
```

## Zweck

Schnelle Antwort auf „läuft der Container?" ohne in die
Docker-CLI wechseln zu müssen. Output kommt direkt von
`docker compose ps`, also vollständig und ehrlich.

## Mechanik

Ein `docker compose ps` mit dem Compose-File des Containers und
dem Compose-Project-Name `<name>_devcontainer`. Tabellarisch:

| Column   | Inhalt                                                   |
| -------- | -------------------------------------------------------- |
| `NAME`   | Container-Name (z.B. `sandbox_devcontainer-workspace-1`) |
| `IMAGE`  | das geladene Image                                       |
| `STATUS` | `running (...)`, `exited (0)`, …                         |
| `PORTS`  | gemappte Ports (falls publishet)                         |

## Argumente

| Argument | Bedeutung       |
| -------- | --------------- |
| `<name>` | Container-Name. |

## Optionen

| Option            | Bedeutung                                                   |
| ----------------- | ----------------------------------------------------------- |
| `--service <svc>` | Nur einen Compose-Service anzeigen. Default: alle Services. |

## Beispiele

Alles:

```sh
$ monoceros status sandbox
NAME                                  IMAGE                       STATUS              PORTS
sandbox_devcontainer-postgres-1       postgres:18                 Up 2 minutes        5432/tcp
sandbox_devcontainer-workspace-1      monoceros-runtime:dev       Up 2 minutes        0.0.0.0:3000->3000/tcp, 0.0.0.0:4000->4000/tcp
```

Nur eine Service-Zeile:

```sh
$ monoceros status sandbox --service postgres
NAME                              IMAGE         STATUS              PORTS
sandbox_devcontainer-postgres-1   postgres:18   Up 2 minutes        5432/tcp
```

## Verwandte Befehle

- [`monoceros start <name>`](./start.md) — hochfahren
- [`monoceros stop <name>`](./stop.md) — pausieren
- [`monoceros logs <name>`](./logs.md) — Compose-Logs verfolgen

## Fail-Modi

- **`No compose.yaml at <path>`** — der Container ist im Image-Mode
  (keine Compose-Services). `status` ist nur für Compose-Mode
  sinnvoll; bei reinen Image-Mode-Containern liefert `docker ps`
  vergleichbare Info.
- **Leere Tabelle** — Compose-Project existiert nicht (noch nie
  `start` oder `apply` aufgerufen, oder mit `remove` weggeräumt).
