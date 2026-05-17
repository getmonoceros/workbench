# `monoceros remove-feature`

Inverse zu [`add-feature`](./add-feature.md). Entfernt einen
Devcontainer-Feature-Eintrag aus der Container-Konfig.

## Synopsis

```sh
monoceros remove-feature <containername> <ref> [--yes]
```

Der Ref muss exakt dem in der Konfig hinterlegten entsprechen (inkl.
Tag), z. B. `ghcr.io/devcontainers/features/docker-in-docker:2`.

## Mechanik

Der entsprechende Array-Eintrag in `features:` wird aus der yml
entfernt. Wenn die Liste leer wird, fällt `features:` ganz raus.

## Idempotenz

Ref nicht in der Konfig → no-change.

## Optionen ändern

`remove-feature` plus `add-feature` ist der vorgesehene Weg, um Options
eines bestehenden Features zu ändern. `add-feature` weigert sich
explizit, einen bestehenden Ref mit anderen Options stillschweigend zu
überschreiben.

```sh
monoceros remove-feature sandbox ghcr.io/devcontainers/features/docker-in-docker:2 --yes
monoceros add-feature sandbox ghcr.io/devcontainers/features/docker-in-docker:2 --yes -- version=20.10
monoceros apply sandbox
```

## Verwandte Befehle

- `monoceros add-feature` — Inverse / Options ändern
- `monoceros apply <name>` — Materialisierung
