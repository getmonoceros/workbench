# `monoceros remove-feature`

Inverse zu [`add-feature`](./add-feature.md). Entfernt einen
Devcontainer-Feature-Eintrag aus der Konfig.

## Synopsis

```sh
monoceros remove-feature <ref> [--yes] [--project=<path>]
```

Der Ref muss exakt dem in der Konfig hinterlegten entsprechen (inkl.
Tag), z. B. `ghcr.io/devcontainers/features/docker-in-docker:2`.

## Mechanik

- Bei Phase-3: Der entsprechende Array-Eintrag in `features:` wird
  aus der yml entfernt. Wenn die Liste leer wird, wird `features:`
  ganz gedroppt.
- Bei Legacy: `stack.json.features[<ref>]` wird gelöscht; der Feature
  verschwindet aus `devcontainer.json`.

## Idempotenz

Ref nicht in der Konfig → no-change.

## Optionen ändern

`remove-feature` plus `add-feature` ist der vorgesehene Weg, um
Options eines Features zu ändern. `add-feature` weigert sich, einen
bestehenden Ref mit anderen Options stillschweigend zu überschreiben.

```sh
monoceros remove-feature ghcr.io/devcontainers/features/docker-in-docker:2 --yes
monoceros add-feature ghcr.io/devcontainers/features/docker-in-docker:2 --option version=20.10 --yes
monoceros apply
```

## Verwandte Befehle

- `monoceros add-feature` — Inverse / Options ändern
- `monoceros apply` — Materialisierung
