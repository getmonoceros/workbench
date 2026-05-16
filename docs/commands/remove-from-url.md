# `monoceros remove-from-url`

Inverse zu [`add-from-url`](./add-from-url.md). Entfernt einen
Install-URL-Eintrag aus der Konfig.

## Synopsis

```sh
monoceros remove-from-url <url> [--yes] [--project=<path>]
```

Die URL muss exakt der in der Konfig hinterlegten entsprechen.

## Mechanik

Bei Phase-3: yml-Eintrag in `installUrls:` wird entfernt. Bei Legacy:
`stack.json.installUrls` wird gefiltert; im nächsten `apply` fällt der
URL-Aufruf aus `.devcontainer/post-create.sh` raus.

**Achtung — das Install-Script-Ergebnis bleibt im Container.** Wenn
der ursprüngliche URL-Install ein Binary installiert hat, ist das
nach `apply` zwar nicht mehr Teil des Build-Prozesses, aber im
bestehenden Container weiterhin vorhanden, bis der Container
re-created wird. Für einen vollständig sauberen Zustand:

```sh
monoceros remove-from-url https://example.com/install --yes
monoceros down       # Container weg, Volumes bleiben
monoceros apply      # neu hochfahren, ohne den Install-Step
```

## Idempotenz

URL nicht in der Liste → no-change.

## Verwandte Befehle

- `monoceros add-from-url` — Inverse
- `monoceros down` — Container neu erzeugen, damit die Installation
  wirklich verschwindet
- `monoceros apply` — Materialisierung
