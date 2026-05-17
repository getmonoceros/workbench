# `monoceros remove-apt-packages`

Inverse zu [`add-apt-packages`](./add-apt-packages.md). Entfernt einen
oder mehrere apt-Pakete aus der Container-Konfig.

## Synopsis

```sh
monoceros remove-apt-packages <containername> [--yes] -- <pkg> [<pkg> …]
```

Wie bei `add-apt-packages` wird die Paketliste **nach `--`** übergeben,
damit Namen mit `-`-Prefix nicht von citty als Flags geparst werden.

## Mechanik

yml-Einträge in `aptPackages:` werden entfernt. Umliegende Kommentare an
**erhaltenen** Paketen bleiben unverändert. Fällt die Liste leer, fliegt
das Feld komplett raus.

## Idempotenz

Pakete, die schon nicht in der Liste stehen, werden ignoriert. Wenn alle
aufgeführten Pakete bereits fehlen → no-change.

## Beispiel

```sh
monoceros remove-apt-packages sandbox --yes -- make jq
monoceros apply sandbox
```

## Verwandte Befehle

- `monoceros add-apt-packages` — Inverse
- `monoceros apply <name>` — Materialisierung
