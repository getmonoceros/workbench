# `monoceros remove-language`

Inverse zu [`add-language`](../README.md#hinzufügen). Entfernt einen
Sprach-Eintrag aus der Container-Konfig.

## Synopsis

```sh
monoceros remove-language <containername> <lang> [--yes]
```

## Mechanik

Editiert die yml unter `$MONOCEROS_HOME/container-configs/<name>.yml`:
der Eintrag in `languages:` wird entfernt; wird die Liste leer, fällt
das Feld komplett raus. Comment-preserving — andere Einträge und
Kommentare bleiben unverändert.

Nach dem Aufruf muss `monoceros apply <containername>` laufen, damit
der Container die Änderung übernimmt.

## Idempotenz

`remove-language sandbox python` zweimal in Folge → zweiter Aufruf ist
no-change.

## Beispiel

```sh
monoceros remove-language sandbox python --yes
monoceros apply sandbox
```

## Verwandte Befehle

- `monoceros add-language` — Inverse
- `monoceros apply <name>` — Materialisierung nach der Edit
