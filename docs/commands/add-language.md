# `monoceros add-language`

Fügt eine Sprach-Toolchain zur Container-Konfig hinzu. Idempotent,
zeigt vor dem Schreiben einen Diff.

```sh
monoceros add-language <name> <lang>[:version] [--yes]
```

## Zweck

Editiert die yml unter
`$MONOCEROS_HOME/container-configs/<name>.yml`. Trägt `<lang>` (oder
`<lang>:<version>`) im `languages:`-Block ein. Der Container muss
danach mit `monoceros apply <name>` neu materialisiert werden, damit
die Sprache als Devcontainer-Feature im Container landet.

## Mechanik

1. **Schema-Validierung** der yml (catch eines Sub-Fehlers früh).
2. **Catalog-Check**: `<lang>` muss in der kuratierten Liste
   `node, python, java, go, rust, dotnet` stehen. Unbekannte Werte
   werden mit Liste der erlaubten Sprachen abgewiesen.
3. **Diff-Vorschau** vor dem Schreiben (mit `--yes` übersprungen).
4. **AST-Mutation**: schreibt das `languages:`-Feld comment-
   preserving; existierende Kommentare und Layout bleiben erhalten.

## Argumente

| Argument | Bedeutung                                                                |
| -------- | ------------------------------------------------------------------------ |
| `<name>` | Container-Name.                                                          |
| `<lang>` | Sprach-Name aus dem Katalog, optional mit `:version`-Suffix (`java:17`). |

## Optionen

| Option      | Bedeutung                                       |
| ----------- | ----------------------------------------------- |
| `--yes, -y` | Diff-Confirm-Prompt überspringen (für Scripts). |

## Versions-Suffix

Das `:version`-Suffix wird beim `apply` an das upstream-
Devcontainer-Feature als `version`-Option durchgereicht:

```sh
$ monoceros add-language sandbox java:17
$ monoceros apply sandbox
```

Erzeugt im `devcontainer.json`:

```json
"features": {
  "ghcr.io/devcontainers/features/java:1": { "version": "17" }
}
```

Sonderfall `node`: ohne Version (`node`) bleibt es ein Built-in
der Basis-Image-Runtime (Node 22, keine Feature-Installation).
`node:<version>` schaltet auf das upstream-Feature um.

## Idempotenz

`add-language sandbox python` zweimal in Folge → der zweite Aufruf
ist ein no-change (Datei wird nicht angefasst, Confirm-Prompt
sagt klar dass nichts zu tun ist).

Wenn `python` schon ohne Version in der yml steht und du
`python:3.12` hinzufügst: der erste Eintrag wird ersetzt.

## Verwandte Befehle

- [`remove-language`](./remove-language.md) — Inverse
- [`monoceros apply <name>`](./apply.md) — Änderung wirksam machen
- [`monoceros init <name> --with=<lang>:<version>`](./init.md) —
  Sprache schon beim Init mit Version eintragen

## Fail-Modi

- **`Unknown language: <name>`** — Tippfehler oder Sprache nicht
  im Katalog. Liste der erlaubten Werte in der Fehlermeldung.
- **`No such config`** — Container-yml unter
  `container-configs/<name>.yml` existiert nicht. `monoceros init`
  vorher.
