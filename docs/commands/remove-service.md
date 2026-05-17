# `monoceros remove-service`

Inverse zu [`add-service`](../README.md#hinzufügen). Entfernt einen
Compose-Service aus der Container-Konfig.

## Synopsis

```sh
monoceros remove-service <containername> <service> [--yes]
```

## Mechanik

yml-Eintrag in `services:` wird entfernt. Wenn dadurch keine Services
mehr übrig sind, fällt der Container beim nächsten Apply auf Image-Mode
zurück und `compose.yaml` wird weggeräumt.

**Wichtig:** Volumes (z. B. `postgres-data`) bleiben bestehen und
werden **nicht** automatisch entfernt. Wenn du wirklich auch die Daten
loswerden willst:

```sh
monoceros down sandbox --volumes
monoceros remove-service sandbox postgres --yes
monoceros apply sandbox
```

## Idempotenz

Service nicht in der Liste → no-change.

## Beispiel

```sh
monoceros remove-service sandbox redis --yes
monoceros apply sandbox
```

## Verwandte Befehle

- `monoceros add-service` — Inverse
- `monoceros down <name> --volumes` — Service-Daten manuell entfernen
- `monoceros apply <name>` — Materialisierung
