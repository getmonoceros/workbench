# `monoceros init`

Erstellt eine **wiederverwendbare Container-Konfig** unter
`.local/container-configs/<name>.yml` aus einer mitgelieferten Vorlage.

## Zweck

Eine Konfig ist die Wahrheit eines Dev-Containers. Sie liegt **außerhalb**
des Dev-Container-Verzeichnisses und kann von mehreren Containern
gleichzeitig referenziert werden. Edits an der Konfig propagieren beim
nächsten `monoceros apply` in jeden Container, der sie nutzt.

`monoceros init` ist der Erst-Setup-Schritt:

1. kopiert eine Template-Datei aus `templates/yml/<template>.yml` nach
   `.local/container-configs/<name>.yml`,
2. überschreibt das `name`-Feld im Ziel-File mit `<name>`,
3. preserved jeden Kommentar im Template — Builder lesen die yml danach
   als Inline-Doku und können sie hand-editieren.

Was es **nicht** ist:

- Kein Dev-Container-Setup (das macht `monoceros apply`)
- Keine Erst-Bootstrap-Routine im klassischen Sinn — du kannst die
  Konfig auch händisch anlegen, `init` ist nur der schnelle Weg
- Kein Auto-Update bei Template-Änderungen — die Kopie ist eigenständig
  ab dem Init-Aufruf

## Synopsis

```sh
monoceros init <template> <name>
```

## Argumente

| Argument     | Bedeutung                                                                      |
| ------------ | ------------------------------------------------------------------------------ |
| `<template>` | Template-Name. Datei-Basename unter `templates/yml/` (z. B. `bare`, `python`). |
| `<name>`     | Wunschname für die Konfig. Landet als `.local/container-configs/<name>.yml`.   |

## Mitgelieferte Templates

| Template        | Stack                                       |
| --------------- | ------------------------------------------- |
| `bare`          | Node (Base-Image), sonst nichts             |
| `nodejs-github` | Node (Base) + GitHub CLI (`gh`)             |
| `python`        | Python (Feature) + lokaler Postgres-Service |

Weitere Templates können unter `templates/yml/` ergänzt werden — siehe
[`templates/yml/README.md`](../../templates/yml/README.md).

## Mechanik

1. **Template-Lookup** in `templates/yml/<template>.yml`. Fehlt das
   File, error mit Liste aller verfügbaren Templates.
2. **Schema-Validierung** des Templates (catch malformed templates
   ohne, die du beim Anpassen erst später beim Apply gemerkt hättest).
3. **Ziel-Existenz-Prüfung**: wenn `.local/container-configs/<name>.yml`
   schon da ist, error. Das verhindert versehentliches Überschreiben
   einer hand-editierten Konfig.
4. **AST-Rewrite** des `name`-Felds: Template-Default (z. B. `name: bare`)
   wird durch `<name>` ersetzt. Der Rest der yml — speziell der
   Kommentar-Block am Anfang — bleibt 1:1 erhalten.
5. **Write** nach `.local/container-configs/<name>.yml`.

## Beispiel

```sh
$ monoceros init nodejs-github sandbox
✔ Copied template 'nodejs-github' to .local/container-configs/sandbox.yml
ℹ Edit the file, then run `monoceros apply sandbox <dir>` to materialize a dev-container.
```

Resultat:

```yaml
# Monoceros solution-config — `nodejs-github` template.
#
# Profile for a TypeScript/Node-first solution backed by GitHub repos.
# …
schemaVersion: 1
name: sandbox

aptPackages:
  - make
  - jq

# repos:
#   - url: git@github.com:your-org/your-repo.git
```

Danach kannst du die Konfig:

- direkt editieren (z. B. `repos:` einkommentieren),
- via `monoceros add-repo <url>` mutieren (aus jedem Container, der
  diese Konfig nutzt — der Befehl findet die Konfig über state.json),
- mit `monoceros apply sandbox <dir>` in einem konkreten
  Dev-Container-Verzeichnis materialisieren.

## Verwandte Befehle

- `monoceros apply <name> <dir>` — materialisiert die Konfig in einem
  Dev-Container-Verzeichnis (siehe [apply.md](./apply.md))
- `monoceros add-*` / `monoceros remove-*` — editieren die Konfig, auf
  die der aktive Dev-Container via `state.json` zeigt

## Fail-Modi

- **`Unknown template: <name>`** — Tippfehler oder neues Template
  fehlt. Verfügbare Templates werden in der Fehlermeldung gelistet.
- **`Config already exists: <path>`** — die Ziel-Datei existiert
  schon. Lösung: alte manuell löschen, oder anderen `<name>` wählen.
- **`Invalid config name`** — `<name>` enthält Slash, Space oder Shell-
  Meta. Nur `[A-Za-z0-9._-]+` erlaubt.
- **`Invalid template name`** — `<template>` enthält ungültige
  Zeichen (gleiche Regel wie `<name>`).
- **Template-Schema-Fehler** — das ausgelieferte Template ist kaputt.
  Bug-Report öffnen; ein zusätzlicher Lauf der `templates.test.ts`
  sollte das vor dem Release fangen.
