# `monoceros remove-language`

Inverse zu [`add-language`](./add-language.md). Entfernt einen
Sprach-Eintrag aus der Konfig.

## Synopsis

```sh
monoceros remove-language <lang> [--yes] [--project=<path>]
```

## Mechanik

Bei einem Phase-3-Container (state.json vorhanden) editiert der Befehl
die yml, auf die `state.json.origin` zeigt. Comment-preserving. Bei
einer Legacy-Solution wird stattdessen die `stack.json` mutiert und
devcontainer.json/`compose.yaml`/`post-create.sh` direkt neu
generiert.

Nach dem Aufruf muss `monoceros apply` laufen, damit der Container die
Änderung übernimmt.

## Idempotenz

`remove-language python` zweimal in Folge → zweiter Aufruf ist
no-change.

## Beispiel

```sh
monoceros remove-language python --yes
monoceros apply
```

## Verwandte Befehle

- `monoceros add-language` — Inverse
- `monoceros apply` — Materialisierung nach der Edit
