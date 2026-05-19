# `monoceros add-service`

Fügt einen Compose-Service zur Container-Konfig hinzu. Idempotent,
zeigt vor dem Schreiben einen Diff.

```sh
monoceros add-service <name> <svc> [--yes]
```

## Zweck

Editiert die yml unter
`$MONOCEROS_HOME/container-configs/<name>.yml`. Trägt `<svc>` im
`services:`-Block ein. Beim nächsten `monoceros apply <name>` wird
der Container in den Compose-Modus überführt (oder, wenn er das
schon ist, der Service als zusätzlicher Compose-Container neben
dem Workspace gestartet).

## Mechanik

1. **Schema-Validierung** der yml.
2. **Catalog-Check**: `<svc>` muss in der kuratierten Liste
   `postgres, mysql, redis` stehen.
3. **Diff-Vorschau** vor dem Schreiben (mit `--yes` übersprungen).
4. **AST-Mutation**: schreibt das `services:`-Feld
   comment-preserving.

## Argumente

| Argument | Bedeutung                                              |
| -------- | ------------------------------------------------------ |
| `<name>` | Container-Name.                                        |
| `<svc>`  | Service aus dem Katalog: `postgres`, `mysql`, `redis`. |

## Optionen

| Option      | Bedeutung                                       |
| ----------- | ----------------------------------------------- |
| `--yes, -y` | Diff-Confirm-Prompt überspringen (für Scripts). |

## Erreichbarkeit + Credentials

Inside-the-container ist der Service als Hostname `<svc>`
erreichbar (z.B. `postgres:5432`). Die Default-Credentials sind
eine Dev-Konvention (`monoceros / monoceros / monoceros`) und
fest im Service-Katalog verdrahtet — siehe Hinweis in
`packages/cli/src/create/catalog.ts`.

Beispiel-Connection-Strings:

```
postgresql://monoceros:monoceros@postgres:5432/monoceros
mysql://monoceros:monoceros@mysql:3306/monoceros
redis://redis:6379
```

DB-Daten werden bind-gemountet auf
`<MONOCEROS_HOME>/container/<name>/data/<svc>/` (siehe
[ADR 0003](../adr/0003-container-state-model.md)) — damit
überleben sie `apply`-Rebuilds und sind teil eines
`monoceros remove`-Backups.

## Externe Services statt lokalem Compose-Service

Wenn du eine bestehende Datenbank ausserhalb des Containers nutzen
willst (Production-DB, geteilte Dev-DB, …): statt `add-service`
trägst du in der yml von Hand ein:

```yaml
externalServices:
  postgres: postgresql://user:pass@host:5432/dbname
```

Beim Apply wird kein `postgres`-Compose-Service mehr generiert —
der Container greift direkt auf den externen Host zu.

## Idempotenz

`add-service sandbox postgres` zweimal in Folge → zweiter Aufruf
ist ein no-change.

## Verwandte Befehle

- [`remove-service`](./remove-service.md) — Inverse (Datenvolumen
  bleibt!)
- [`monoceros apply <name>`](./apply.md) — Änderung wirksam machen
- [`monoceros init <name> --with=postgres`](./init.md) — Service
  schon beim Init eintragen

## Fail-Modi

- **`Unknown service: <name>`** — Tippfehler oder Service nicht
  im Katalog.
- **`No such config`** — Container-yml existiert nicht.
