# `monoceros remove-from-url`

Inverse zu [`add-from-url`](./add-from-url.md). Entfernt einen
Install-URL-Eintrag aus der Container-Konfig.

## Synopsis

```sh
monoceros remove-from-url <containername> <url> [--yes]
```

Die URL muss exakt der in der Konfig hinterlegten entsprechen.

## Mechanik

yml-Eintrag in `installUrls:` wird entfernt. Im nächsten `apply` fällt
der URL-Aufruf aus `.devcontainer/post-create.sh` raus.

**Achtung — das Install-Script-Ergebnis bleibt im Container.** Wenn der
ursprüngliche Install ein Binary installiert hat, ist das nach
`remove-from-url` + `apply` zwar nicht mehr Teil des Build-Prozesses,
aber im bestehenden Container weiterhin vorhanden, bis dieser
re-created wird. Für einen vollständig sauberen Zustand:

```sh
monoceros remove-from-url sandbox https://example.com/install --yes
monoceros down sandbox       # Container weg, Volumes bleiben
monoceros apply sandbox      # neu hochfahren, ohne den Install-Step
```

## Idempotenz

URL nicht in der Liste → no-change.

## Verwandte Befehle

- `monoceros add-from-url` — Inverse
- `monoceros down <name>` — Container neu erzeugen
- `monoceros apply <name>` — Materialisierung
