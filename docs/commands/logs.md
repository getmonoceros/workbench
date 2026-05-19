# `monoceros logs`

Tailt die Compose-Logs des benannten Containers. Default: alle
Services, mit `-f` (follow). `--no-follow` für einen einmaligen
Dump.

```sh
monoceros logs <name> [--service <svc>] [--no-follow]
```

## Zweck

Wenn etwas im Container schiefläuft — `monoceros logs sandbox`
ist der direkte Weg zu den `docker compose logs`. Kein Wechsel
in die Docker-CLI nötig.

## Mechanik

Ein `docker compose logs -f` mit dem Compose-File und
Project-Name des Containers. Standardmäßig follow-Mode (live),
mit `--no-follow` einmaliger Dump und exit.

## Argumente

| Argument | Bedeutung       |
| -------- | --------------- |
| `<name>` | Container-Name. |

## Optionen

| Option            | Bedeutung                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `--service <svc>` | Nur Logs eines Compose-Services (z.B. `--service postgres`). Default: alle Services.       |
| `--no-follow`     | Einmaliger Dump statt `tail -f`-Verhalten. Useful in Scripts oder für eine schnelle Sicht. |

## Beispiele

Live-Tail aller Services:

```sh
$ monoceros logs sandbox
sandbox_devcontainer-postgres-1   | 2026-05-19 12:31:01.512 UTC [1] LOG:  starting PostgreSQL 18.0
sandbox_devcontainer-postgres-1   | 2026-05-19 12:31:01.524 UTC [1] LOG:  database system is ready to accept connections
sandbox_devcontainer-workspace-1  | (workspace ready)
^C
```

Nur Postgres, ohne follow:

```sh
$ monoceros logs sandbox --service postgres --no-follow
```

## Verwandte Befehle

- [`monoceros status <name>`](./status.md) — welche Services laufen
  überhaupt
- [`monoceros start <name>`](./start.md) / [`stop`](./stop.md) —
  Lifecycle

## Fail-Modi

- **`No compose.yaml at <path>`** — Image-Mode-Container. Nutze
  `docker logs <container-id>` für den Image-Mode-Equivalent.
- **Leerer Output** — der Service ist nie gestartet, oder
  Compose-Project existiert nicht (siehe `status`).
