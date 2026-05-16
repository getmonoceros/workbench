# `monoceros remove-apt-packages`

Inverse zu [`add-apt-packages`](./add-apt-packages.md). Entfernt einen
oder mehrere apt-Pakete aus der Konfig.

## Synopsis

```sh
monoceros remove-apt-packages [--yes] [--project=<path>] -- <pkg> [<pkg> …]
```

Wie bei `add-apt-packages` wird die Paketliste **nach `--`** übergeben,
damit Namen mit `-`-Prefix nicht von citty als Flags geparst werden.

## Mechanik

- Bei Phase-3: yml-Einträge in `aptPackages:` werden entfernt. Die
  umliegenden Kommentare an erhaltenen Paketen bleiben unverändert.
- Bei Legacy: `stack.json.aptPackages` wird gefiltert. Wenn dadurch
  keine Pakete mehr übrig sind, wird der entsprechende Devcontainer-
  Feature-Eintrag aus `devcontainer.json` entfernt.

## Idempotenz

Pakete, die schon nicht in der Liste stehen, werden ignoriert. Wenn
alle aufgeführten Pakete bereits fehlen → no-change.

## Beispiel

```sh
monoceros remove-apt-packages --yes -- make jq
monoceros apply
```

## Verwandte Befehle

- `monoceros add-apt-packages` — Inverse
- `monoceros apply` — Materialisierung
