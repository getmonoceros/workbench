# `monoceros tunnel`

Öffnet einen **TCP-Tunnel** vom Host in den Container — für DB-Clients,
ad-hoc Port-Forwards oder Tooling, das vom Host aus einen
Container-internen Port erreichen muss. Foreground-Prozess: Ctrl+C
beendet den Tunnel.

```sh
monoceros tunnel <name> <service-or-port> [--local-port=<n>] [--local-address=<addr>]
```

## Zweck

[`add-port`](./add-port.md) + Traefik decken **HTTP-Routing** über
`<name>.localhost` ab — das ist die persistente Lösung für Web-Apps.
Für alles **TCP-basierte** (Postgres, MySQL, Redis, beliebige
Server-Sockets) braucht es einen anderen Mechanismus, weil Traefik
HTTP-only ist und ein `psql -h localhost -p 5432` direkt auf den
Service-Port treffen muss.

`tunnel` ist die situative Brücke: ad-hoc, für die Dauer eines
Tasks, ohne yml-Mitschrift, ohne `apply`-Rebuild. Vorbild ist
`kubectl port-forward` / `ssh -L`.

Hintergrund + verworfene Alternativen: [ADR 0009](../adr/0009-tcp-tunnels-foreground-sidecar.md).

## Mechanik

1. Liest die Container-yml unter `$MONOCEROS_HOME/container-configs/<name>.yml`.
2. Löst das Ziel auf:
   - **Service-Name** (`postgres`, `mysql`, `redis`) → interner Port
     kommt aus dem Service-Katalog (5432 / 3306 / 6379). Muss im
     `services:`-Block der yml deklariert sein.
   - **Port-Nummer** (`8080`) → interner Port direkt, ziel ist der
     Workspace-Container.
3. Pre-Flight: ist der lokale Port frei? Falls nicht → klarer
   Fehler mit `--local-port`-Hint.
4. Startet `docker run --rm -i --network=<container-network>
-p <local-address>:<local-port>:<internal-port> alpine/socat:1.8.0.3
TCP-LISTEN:… TCP:<target>:<internal-port>` im Vordergrund.
5. Ctrl+C → docker run signalisiert socat, der Container endet, `--rm`
   räumt auf.

## Argumente

| Argument            | Bedeutung                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `<name>`            | Container-Name (yml in `$MONOCEROS_HOME/container-configs/`).                                               |
| `<service-or-port>` | Service-Name aus `monoceros list-components` (heute `postgres`, `mysql`, `redis`) oder interne Port-Nummer. |

## Optionen

| Flag                     | Default         | Wirkung                                                                                                      |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `--local-port=<n>`       | = interner Port | Host-seitiger Listen-Port. Übersteuern, wenn der Default-Port belegt ist.                                    |
| `--local-address=<addr>` | `127.0.0.1`     | Host-Interface. `0.0.0.0` exponiert auf alle Interfaces (LAN sichtbar). Default schützt vor Versehentlichem. |

## Beispiele

### Postgres aus dem Container vom Host abfragen

```sh
$ monoceros tunnel sandbox postgres
ℹ Tunnel: 127.0.0.1:5432 → sandbox/postgres:5432 (Ctrl+C to stop)
```

In einem zweiten Terminal:

```sh
$ psql postgresql://monoceros:monoceros@localhost:5432/monoceros
```

### Mehrere DBs gleichzeitig — pro Tunnel ein Terminal

```sh
# Terminal 1
$ monoceros tunnel sandbox postgres

# Terminal 2
$ monoceros tunnel sandbox redis

# Terminal 3 — eigentliches Tooling
$ pgcli postgresql://…@localhost:5432/monoceros
$ redis-cli -h localhost -p 6379
```

### Port-Kollision auflösen

```sh
$ monoceros tunnel sandbox postgres
✖ Local port 5432 on 127.0.0.1 is already in use.

  Identify the holder, then either stop it or pick a different
  port for the tunnel:

    sudo lsof -iTCP:5432 -sTCP:LISTEN -n -P

  Re-run with an explicit local port:
    monoceros tunnel … --local-port=5433

$ monoceros tunnel sandbox postgres --local-port=5433
ℹ Tunnel: 127.0.0.1:5433 → sandbox/postgres:5432 (Ctrl+C to stop)
```

### Ad-hoc HTTP-App, nicht in `routing.ports`

Eine interne Test-App lauscht auf `8080`, ist aber nicht in
`routing.ports` eingetragen (Builder will keinen Apply-Rebuild,
keinen yml-Eintrag):

```sh
$ monoceros tunnel sandbox 8080
ℹ Tunnel: 127.0.0.1:8080 → sandbox:8080 (Ctrl+C to stop)
```

→ http://localhost:8080/ greift durch. Für **persistente** HTTP-
Routen ist [`add-port`](./add-port.md) die richtige Lösung.

### Vom Mobilgerät im selben WLAN testen

```sh
$ monoceros tunnel sandbox 3000 --local-address=0.0.0.0
ℹ Tunnel: 0.0.0.0:3000 → sandbox:3000 (Ctrl+C to stop)
```

Vom Handy: `http://<rechner-IP>:3000/`. Default-`127.0.0.1` würde
das blocken — bewusster Opt-in, weil LAN-Exposition ein
Sicherheits-Schritt ist.

## Verwandte Befehle

- [`add-port`](./add-port.md) / [`port`](./port.md) — persistentes
  HTTP-Routing über Traefik. Erste Wahl, wenn der Port bleiben soll.
- [`add-service`](./add-service.md) — Compose-Service ergänzen, bevor
  per `tunnel <name> <service-name>` darauf zugegriffen wird.
- [`shell`](./shell.md) — wenn das Tooling im Container leben darf,
  ist das oft die einfachere Antwort. Tunnel ist für die Fälle, wo
  der Builder explizit vom Host arbeiten will.

## Fail-Modi

- **`No yml profile`** — Container-yml existiert nicht. `monoceros
init <name>` vorher.
- **`Container is not materialised`** — yml ist da, aber `apply`
  wurde noch nicht gelaufen. `monoceros apply <name>`.
- **`No running container`** (Image-Mode ohne `routing.ports`) —
  Container ist gestoppt. `monoceros start <name>` (oder
  `monoceros shell <name>`) zuerst.
- **`Unknown service`** — Service-Name ist nicht im Katalog
  (`list-components` zeigt die gültigen).
- **`Service '…' is not declared in this container's yml`** — Service
  ist im Katalog, aber nicht in der yml. `monoceros add-service
<name> <svc>` + `monoceros apply`.
- **`Local port … is already in use`** — Pre-Flight-Check. Andere
  App lauscht auf dem Default-Port; mit `--local-port=<n>` umlenken.
- **`image-mode (no compose.yaml)` + Service-Name** — Services
  brauchen Compose-Mode. yml um mindestens einen Service ergänzen
  und re-applyen.
