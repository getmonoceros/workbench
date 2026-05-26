# `monoceros remove-feature`

Inverse zu [`add-feature`](./add-feature.md). Entfernt einen
Devcontainer-Feature-Eintrag aus der Container-Konfig.

## Synopsis

```sh
monoceros remove-feature <containername> <feature> [--yes]
```

`<feature>` ist — wie bei [`add-feature`](./add-feature.md) — entweder
ein **Katalog-Kurzname** (`atlassian`, `atlassian/twg`, `claude`,
`github` — siehe `monoceros list-components`) oder eine **vollständige
OCI-Ref** (z. B. `ghcr.io/devcontainers/features/docker-in-docker:2`).
Der Kurzname wird über denselben Resolver wie `add-feature` auf die
OCI-Ref aufgelöst, sodass `monoceros remove-feature sandbox atlassian`
den Eintrag findet, der per `add-feature sandbox atlassian` gesetzt
wurde.

## Mechanik

Der entsprechende Array-Eintrag in `features:` wird aus der yml
entfernt — inklusive des per-Feature-Doku-Kommentarblocks, den
`add-feature` / `init` darüber gesetzt haben. Wenn die Liste leer
wird, fällt `features:` ganz raus.

## Idempotenz

Feature nicht in der Konfig → no-change.

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
