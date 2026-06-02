# `monoceros add-service`

Fügt einen Backing-Service (Datenbank, Cache, Objektspeicher, …) zur
Container-Konfig hinzu. Idempotent, zeigt vor dem Schreiben einen Diff.

```sh
monoceros add-service <name> <service-or-image> [--as=<service-name>] [--yes]
```

## Zwei Wege, einen Service einzutragen

`<service-or-image>` wird so interpretiert:

- **Kuratierter Name** (`postgres`, `mysql`, `redis`) → expandiert zu
  einem **vollständigen, editierbaren Service-Block** mit Image,
  Default-Port, Dev-Env und persistentem `data:`-Volume. Sofort
  lauffähig; du passt danach an, was du brauchst.

- **Beliebiges Image** (`rustfs/rustfs:latest`, `clickhouse/clickhouse-server:24`)
  → trägt `name` + `image` aktiv ein und legt den Rest (`port`, `env`,
  `volumes`, `healthcheck`) als **auskommentiertes Grundgerüst**
  darunter ab. Monoceros kennt fremde Images nicht — du füllst aus, was
  das Image braucht. Auf der Konsole erscheint ein Hinweis darauf.

Der Service-Name (Compose-Service, DNS-Name im Netz, Daten-Verzeichnis)
wird bei kuratierten Services der Name selbst, bei Images aus dem
Image-Ref abgeleitet (`rustfs/rustfs:latest` → `rustfs`).

## Beispiele

```sh
# Kuratiert: voller Block mit Dev-Defaults
monoceros add-service logoscraper postgres

# Beliebiges Image: name + image + auskommentiertes Grundgerüst
monoceros add-service logoscraper rustfs/rustfs:latest

# Denselben Service mehrfach — eigener Name pro Instanz
monoceros add-service logoscraper postgres --as=postgres-app
monoceros add-service logoscraper postgres --as=postgres-analytics
```

## Das Service-Modell

Jeder Service-Eintrag ist ein Objekt. Felder:

| Feld          | Zweck                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `name`        | Compose-Service-Name / DNS-Hostname / Daten-Verzeichnis. Eindeutig pro Container.                       |
| `image`       | Docker-Image (Pflicht).                                                                                 |
| `port`        | **Interner** Listen-Port → Default für `monoceros tunnel`. **Kein** Host-Mapping.                       |
| `env`         | Umgebungsvariablen. `${VAR}` wird aus `<name>.env` aufgelöst (siehe unten).                             |
| `volumes`     | `data:/pfad` (persistenter Bind-Mount unter `data/<name>/`) oder relativer Host-Pfad (`projects/…:/…`). |
| `healthcheck` | Compose-Healthcheck. `test` als String oder `["CMD", …]`-Array.                                         |
| `restart`     | `no` / `always` / `on-failure` / `unless-stopped`.                                                      |
| `command`     | Override des Container-Commands.                                                                        |

Bewusst **nicht** dabei: `ports` (Host-Mappings) — Host-Exposition läuft
über [`add-port`](./add-port.md) (HTTP via Traefik) bzw.
[`tunnel`](./tunnel.md) (TCP). Und keine Docker Named Volumes — `data:`
bindet auf die Host-Platte, damit Daten Teil von `remove`-Backups sind
([ADR 0003](../adr/0003-container-state-model.md)).

## Secrets: `${VAR}` und `<name>.env`

Werte wie Passwörter gehören nicht in die (teilbare) yml. Stattdessen:

```yaml
# container-configs/logoscraper.yml
services:
  - name: postgres
    image: postgres:18
    env:
      POSTGRES_PASSWORD: ${PG_PASSWORD}
```

```sh
# container-configs/logoscraper.env  (gitignored)
PG_PASSWORD=s3cret
```

Beim `apply` werden alle `${VAR}` der Service-Felder aus `<name>.env`
ersetzt. Fehlt eine Variable, bricht der Apply mit einer klaren,
gesammelten Fehlermeldung ab (statt still einen leeren Wert zu setzen).
Die `.env` reist mit `remove`-Backups mit und ist via
`container-configs/.gitignore` (`*.env`) vom Versionieren ausgeschlossen.

## `--as` — denselben Service mehrfach

`--as=<name>` übersteuert den Service-Namen. Nötig, um dasselbe Image
mehr als einmal einzutragen (zwei Postgres-Server) oder um zwei Images,
die denselben Namen ableiten, auseinanderzuhalten. Jede Instanz bekommt
ein eigenes `data/<name>/`-Verzeichnis und einen eigenen DNS-Namen.

## Erreichbarkeit + Credentials

Aus dem Dev-Container ist der Service über seinen **Namen** als Hostname
erreichbar (nicht `localhost`) auf seinem internen Port:

```
postgresql://<user>:<pass>@<name>:5432/<db>
```

Kuratierter Postgres mit Dev-Defaults (`monoceros`/`monoceros`/`monoceros`):

```
postgresql://monoceros:monoceros@postgres:5432/monoceros
```

Vom **Host** (DB-GUI etc.) gibt es kein `localhost:5432` — dafür
[`monoceros tunnel <name> <service>`](./tunnel.md).

## Idempotenz + Kollision

- Gleicher Aufruf zweimal → no-change (vorhandener Service mit gleichem
  Image bleibt unangetastet, deine Edits am Block überleben).
- Gleicher Name, **anderes** Image → Fehler mit Hinweis auf `--as`.

## Argumente + Optionen

| Argument / Option     | Bedeutung                                                                |
| --------------------- | ------------------------------------------------------------------------ |
| `<name>`              | Container-Name.                                                          |
| `<service-or-image>`  | Kuratierter Name (`postgres`/`mysql`/`redis`) oder beliebiger Image-Ref. |
| `--as=<service-name>` | Service-Namen übersteuern (mehrfach derselbe Service / Namenskollision). |
| `--yes, -y`           | Diff-Confirm-Prompt überspringen (für Scripts).                          |

## Externe Services statt lokalem Compose-Service

Bestehende DB ausserhalb des Containers (Production, geteilte Dev-DB):
statt `add-service` in der yml von Hand:

```yaml
externalServices:
  postgres: postgresql://user:pass@host:5432/dbname
```

Beim Apply wird kein `postgres`-Compose-Service generiert — der
Container greift direkt auf den externen Host zu.

## Verwandte Befehle

- [`remove-service`](./remove-service.md) — Inverse (Daten-Verzeichnis bleibt)
- [`tunnel`](./tunnel.md) — Service vom Host erreichen
- [`monoceros apply <name>`](./apply.md) — Änderung wirksam machen

## Fail-Modi

- **`A service named '<name>' already exists with a different image`** —
  `--as=<other>` nutzen oder den bestehenden Service erst entfernen.
- **`Invalid --as name …`** — Name muss `[a-z0-9][a-z0-9_-]*` sein.
- **`No such config`** — Container-yml existiert nicht.
