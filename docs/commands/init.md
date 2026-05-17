# `monoceros init`

Erstellt eine Container-Konfig unter
`$MONOCEROS_HOME/container-configs/<name>.yml` aus einer mitgelieferten
Vorlage.

```sh
monoceros init <template> <name>
```

## Zweck

Eine Konfig ist die Wahrheit eines Dev-Containers. Sie liegt
**außerhalb** des Container-Verzeichnisses und kann frei editiert
werden, bevor `monoceros apply <name>` daraus konkret einen Container
materialisiert.

`monoceros init` ist der Erst-Setup-Schritt:

1. Kopiert eine Template-Datei aus `templates/yml/<template>.yml` nach
   `$MONOCEROS_HOME/container-configs/<name>.yml`.
2. Überschreibt das `name`-Feld in der Ziel-Datei mit `<name>`.
3. Preserved jeden Kommentar im Template — Builder lesen die yml danach
   als Inline-Doku und können sie hand-editieren.

Was es **nicht** ist:

- Kein Dev-Container-Setup — das macht `monoceros apply`
- Keine Auto-Update-Routine bei Template-Änderungen — die Kopie ist
  ab dem Init-Aufruf eigenständig

## Synopsis

```sh
monoceros init <template> <name>
```

## Argumente

| Argument     | Bedeutung                                                                      |
| ------------ | ------------------------------------------------------------------------------ |
| `<template>` | Template-Name. Datei-Basename unter `templates/yml/` (z. B. `bare`, `python`). |
| `<name>`     | Wunschname für die Konfig. Landet als `container-configs/<name>.yml`.          |

## Mitgelieferte Templates

| Template        | Stack                                       |
| --------------- | ------------------------------------------- |
| `bare`          | Node (Base-Image), sonst nichts             |
| `nodejs-github` | Node (Base) + GitHub CLI (`gh`)             |
| `python`        | Python (Feature) + lokaler Postgres-Service |
| `reference`     | Nachschlagewerk mit jedem Feld dokumentiert |

Weitere Templates können unter `templates/yml/` ergänzt werden — siehe
[`templates/yml/README.md`](../../templates/yml/README.md).

## Mechanik

1. **Template-Lookup** in `templates/yml/<template>.yml`. Fehlt das
   File, Error mit Liste aller verfügbaren Templates.
2. **Schema-Validierung** des Templates (catch malformed templates).
3. **Ziel-Existenz-Prüfung**: wenn
   `$MONOCEROS_HOME/container-configs/<name>.yml` schon existiert,
   Error. Das verhindert versehentliches Überschreiben einer
   hand-editierten Konfig.
4. **AST-Rewrite** des `name`-Felds: der Template-Default-Name
   (z. B. `name: bare`) wird durch `<name>` ersetzt. Der Rest der yml
   — speziell der Kommentar-Block am Anfang — bleibt 1:1 erhalten.
5. **Write** nach `$MONOCEROS_HOME/container-configs/<name>.yml`.

## Beispiel

```sh
$ monoceros init nodejs-github sandbox
✔ Copied template 'nodejs-github' to container-configs/sandbox.yml
ℹ Edit the file, then run `monoceros apply sandbox` to materialize a dev-container.
```

Resultat:

```yaml
# Monoceros solution-config — `nodejs-github` template.
# …
schemaVersion: 1
name: sandbox

features:
  - ref: ghcr.io/devcontainers/features/github-cli:1

# repos:
#   - url: https://github.com/your-org/your-repo.git
```

Danach kannst du die Konfig:

- direkt editieren (z. B. `repos:` einkommentieren),
- via `monoceros add-* sandbox …` mutieren (Comment-preserving),
- mit `monoceros apply sandbox` als Dev-Container materialisieren.

## Verwandte Befehle

- `monoceros apply <name>` — materialisiert die Konfig ([apply.md](./apply.md))
- `monoceros add-*` / `monoceros remove-*` — editieren die Konfig

## Fail-Modi

- **`Unknown template: <name>`** — Tippfehler oder Template fehlt.
  Verfügbare Templates werden in der Fehlermeldung gelistet.
- **`Config already exists: <path>`** — die Ziel-Datei existiert
  schon. Lösung: alte manuell löschen, oder anderen `<name>` wählen.
- **`Invalid config name`** — `<name>` enthält Slash, Space oder
  Shell-Meta. Nur `[A-Za-z0-9._-]+` erlaubt.
- **Template-Schema-Fehler** — das ausgelieferte Template ist kaputt.
  Bug-Report öffnen.
