# `monoceros remove-service`

Inverse zu [`add-service`](./add-service.md). Entfernt einen
Compose-Service aus der Konfig.

## Synopsis

```sh
monoceros remove-service <service> [--yes] [--project=<path>]
```

## Mechanik

- Bei Phase-3: yml-Eintrag in `services:` wird entfernt.
- Bei Legacy: `stack.json` mutiert; wenn dadurch keine Services mehr
  übrig sind, wird `compose.yaml` weggeräumt und der Devcontainer
  fällt auf Image-Mode zurück.

**Wichtig:** Volumes (z. B. `postgres-data`) bleiben bestehen und
werden **nicht** automatisch entfernt. Wenn du wirklich auch die Daten
loswerden willst:

```sh
monoceros down --volumes
monoceros remove-service postgres --yes
monoceros apply
```

## Idempotenz

Wenn der Service nicht in der Liste steht → no-change.

## Beispiel

```sh
monoceros remove-service redis --yes
monoceros apply
```

## Verwandte Befehle

- `monoceros add-service` — Inverse
- `monoceros down --volumes` — Service-Daten manuell entfernen
- `monoceros apply` — Materialisierung
