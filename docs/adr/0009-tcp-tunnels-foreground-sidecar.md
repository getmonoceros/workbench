# ADR 0009 — TCP-Tunnels via Foreground-socat-Sidecar

- Status: accepted
- Datum: 2026-05-28

## Kontext

[ADR 0007](./0007-port-management-traefik.md) liefert
**HTTP-Routing**: deklarierte Ports im `routing.ports`-Block werden
vom Traefik-Singleton hinter `<name>.localhost` ausgespielt,
persistent über `apply`-Läufe hinweg. Das ist die richtige
Antwort für Web-Apps, die der Builder dauerhaft erreichen will.

Drei Use-Cases bleiben damit ungelöst:

1. **TCP-Services (postgres, mysql, redis, …)** vom Host aus
   erreichen. Traefik ist HTTP-only; `psql -h localhost -p 5432`
   muss aber direkt auf den Service-Port treffen.
2. **Ad-hoc HTTP-Apps**, die _nicht_ in `routing.ports` stehen,
   einmalig prüfen — ohne einen `apply`-Rebuild und ohne die yml
   anzufassen.
3. **Per-Container-Tooling** (`pgcli`, GUI-DB-Clients, REST-Clients)
   ohne `monoceros shell` zu nehmen.

Alle drei sind situativ — der Builder will sie für die Dauer einer
Aufgabe, nicht permanent. Eine yml-Mitschrift wäre falsche
Persistenz.

## Verworfen: Persistente Sidecars mit yml-Mitschrieb

Der Original-Backlog-Entwurf sah vor, Tunnels als Container-yml-
Einträge zu führen (`tunnels:` neben `routing.ports`), per
`monoceros tunnel <name>` zu starten, per `monoceros tunnel <name>
--stop` zu beenden und implizit bei `monoceros stop`/`remove`
mit zu räumen. Sidecars wären über `monoceros start <name>`
wieder hochgekommen.

**Warum verworfen:**

- Zwei Lifecycle-Modelle nebeneinander (persistent für HTTP via
  Traefik, persistent für TCP via Sidecar) sind ein Konzept zu
  viel. Builder muss zwei Mental-Models pflegen.
- Listing-Subcommand (`monoceros status` mit Tunnel-Spalte? Eigener
  `tunnel --list`?) wird notwendig, sobald Tunnels überleben.
- Räumungslogik in `remove`/`stop` muss Edge-Cases abdecken
  („Tunnel zeigt ins Leere, weil Container down — was tun?").
- Das Mental-Model passt nicht zum Tool-Vorbild: `kubectl
port-forward` und `ssh -L` sind Foreground-Befehle. Builder, die
  diese kennen, erwarten dasselbe.

## Verworfen: SSH-basierter Tunnel im Dev-Container

sshd im Container starten, key-basierte Auth, ein `ssh -L`-Aufruf
vom Host. Vorteil: ein Tunnel kann mehrere Ports auf einmal.
Nachteil: sshd + Key-Verwaltung im Dev-Container ist Over-Engineering
für Local-Dev. Die Builder-Workstation hat schon Docker-Zugriff —
warum den Umweg über SSH? Re-aufrufbar, falls Remote-Dev-Container
(über das Netzwerk) später Thema werden.

## Entscheidung

**Ein Foreground-Prozess pro Tunnel, ein Tunnel pro Aufruf,
Ctrl+C beendet.** Implementation über einen kurzlebigen
`alpine/socat`-Sidecar, der in das Docker-Network des Ziel-
Containers joint und einen Host-Port auf den internen Port
forwardet.

### CLI-Form

```sh
monoceros tunnel <name> <service-or-port> [--local-port=<n>] [--local-address=<addr>]
```

- `<service-or-port>` ist entweder ein Service-Name aus dem
  `services:`-Block der Container-yml (`postgres`, `mysql`, `redis`
  — vgl. `monoceros list-components`) oder eine interne Port-Nummer
  (`8080`).
- `--local-port` setzt den Host-Port. Default ist 1:1 (postgres →
  5432 → 5432, Port 8080 → 8080). Bei Belegung des Default-Ports
  bricht der Befehl mit klarem Fehler ab; der Builder leitet
  explizit um.
- `--local-address` setzt das Listen-Interface auf dem Host.
  Default `127.0.0.1` (nur Loopback — vom selben Rechner erreichbar,
  nicht aus dem LAN). `--local-address=0.0.0.0` bindet auf alle
  Interfaces; sinnvoll z. B. für Tests vom Mobilgerät im selben
  WLAN. Bewusster Opt-in, weil die LAN-Exposition eine
  Sicherheits-Konsequenz hat.

### Lifecycle

1. **Start:** `monoceros tunnel hello postgres` blockiert im
   Terminal mit einer Info-Zeile
   (`Tunnel: localhost:5432 → hello/postgres:5432, Ctrl+C to stop`).
2. **Stop:** Ctrl+C signalisiert den `docker run`-Subprozess; der
   socat-Container hat `--rm` und verschwindet beim Exit.
3. **Mehrere parallele Tunnels:** mehrere Terminals (oder `&`).
   Bewusst keine `--for-services=postgres,mysql`-Kollektion in
   einem Aufruf — Log-Multiplex bringt mehr Verwirrung als der
   Komfort wert ist, und `--local-port`-Kollisionen wären
   semantisch nicht eindeutig auflösbar.

### Topologie

Der Sidecar joint das Docker-Network des Ziel-Containers und
ruft den Service per DNS-Name auf:

```
docker run --rm -i \
  --network=<container-network> \
  -p <local-address>:<local-port>:<internal-port> \
  alpine/socat:1.8.0.3 \
  TCP-LISTEN:<internal-port>,fork,reuseaddr \
  TCP:<target-host>:<internal-port>
```

Das socat-Image ist auf eine konkrete Version gepinnt
(`alpine/socat:1.8.0.3`) — Reproducibility schlägt
Floating-Latest. Ein Bump erfolgt explizit per ADR-Update.

Network und Target-Host hängen vom Container-Mode ab:

| Mode                                 | Network                   | Target-Host (DNS)          |
| ------------------------------------ | ------------------------- | -------------------------- |
| Compose, Service-Name (`postgres`)   | `<projectName>_default`   | Compose-Service-Name       |
| Compose, Port (Workspace)            | `<projectName>_default`   | `workspace`                |
| Image-Mode mit `routing.ports`, Port | `monoceros-proxy`         | `<container-name>` (Alias) |
| Image-Mode ohne `routing.ports`      | (Bridge-IP via `inspect`) | Container-IP               |

Der letzte Fall ist die Notlösung: ohne `routing.ports` ist der
Container auf Dockers Default-Bridge ohne DNS, also lookup-en wir
die IP einmal beim Start und targeten sie direkt.

### Was bewusst draußen bleibt

- **Listing-Befehl** — `ps`/Terminal-Tabs sind das Listing.
- **`tunnel --stop`** — Ctrl+C ist der Stop.
- **yml-Persistenz** — keine `tunnels:`-Section in der Container-
  yml. Tunnel-Konfig ist immer der CLI-Aufruf.
- **TLS** — TCP-Layer; Ende-zu-Ende-Verschlüsselung ist Sache des
  Service-Protokolls (postgres SSL, redis TLS, …).

## Konsequenzen

- Tunnel-Code lebt unter `packages/cli/src/tunnel/` (eigenes
  Modul neben `proxy/`), keine yml-Schema-Erweiterung.
- `alpine/socat` ist ein zusätzliches Image, das beim ersten
  `tunnel`-Aufruf gepullt wird. Klein (~5 MB), gut gepflegt,
  Single-Purpose — vertretbarer Footprint.
- Ein abgestürzter `monoceros tunnel`-Prozess (kill -9 statt
  Ctrl+C) lässt den socat-Container kurz hängen, bis Docker
  per `--rm` aufräumt. Im Worst-Case sieht der Builder einen
  `monoceros-tunnel-…`-Container in `docker ps` — kein State-
  Leak, da `--rm` beim nächsten Exit-Signal greift.
- Vorbild für künftige situative Sidecar-Befehle: wenn weitere
  „lebt nur während der Befehl läuft"-Tools auftauchen, ist das
  Muster dokumentiert.
