# `monoceros remove-service`

Inverse of [`add-service`](../README.md#hinzufügen). Removes a Compose
service from the container config.

## Synopsis

```sh
monoceros remove-service <containername> <service> [--yes]
```

## Mechanics

The yml entry under `services:` is removed. If this leaves no services,
the container falls back to image mode on the next apply and
`compose.yaml` is cleaned up.

**Important:** Volumes (e.g. `postgres-data`) are kept and are **not**
removed automatically. If you really want to get rid of the data too:

```sh
monoceros down sandbox --volumes
monoceros remove-service sandbox postgres --yes
monoceros apply sandbox
```

## Idempotency

Service not in the list → no-change.

## Example

```sh
monoceros remove-service sandbox redis --yes
monoceros apply sandbox
```

## Related commands

- `monoceros add-service` — inverse
- `monoceros down <name> --volumes` — manually remove service data
- `monoceros apply <name>` — materialization
