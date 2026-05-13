# `monoceros add-apt-packages`

Installiert beliebige Debian/Ubuntu-apt-Pakete im Devcontainer.

## Zweck

Schnelles, deklaratives Hinzufügen kleiner Tools, die im Base-Image
fehlen (`make`, `jq`, `openssh-client`, `vim`, `tmux`, `tree`, `rsync`, …).
Ohne diesen Befehl müsste der Builder entweder `devcontainer.json` von
Hand editieren oder `apt install …` im Container manuell ausführen —
letzteres ist nicht persistent, geht beim nächsten `monoceros apply`
verloren.

Was das ist _nicht_:

- Kein Ersatz für `add-language` (Sprach-Toolchains haben eigene
  Devcontainer-Features mit zusätzlichem Setup)
- Kein Ersatz für `add-feature` (Tools, die ihr eigenes Devcontainer-
  Feature haben — z. B. `gh`, `kubectl`, `terraform` — gehören da hin,
  weil deren Feature mehr macht als `apt install`)

## Synopsis

```sh
monoceros add-apt-packages [--yes] [--project=<path>] -- <pkg> [<pkg> …]
```

Das `--` trennt Monoceros-Flags von der Paketliste. Pflicht, weil sonst
Pakete wie `--ignore-me` als Flag interpretiert würden (theoretisch —
in der Praxis selten, aber die Konvention ist konsistent mit
`monoceros run -- <cmd>`).

## Optionen

| Flag               | Bedeutung                                              |
| ------------------ | ------------------------------------------------------ |
| `--yes` / `-y`     | Confirm-Prompt überspringen (für Skripte / CI)         |
| `--project=<path>` | Solution-Root explizit (Default: Aufwärtswalk von cwd) |

## Mechanik

`add-apt-packages` schreibt in zwei Dateien:

1. `.monoceros/stack.json` → akkumuliert die Paketliste in
   `aptPackages: string[]` (alphabetisch sortiert, dedupliziert)
2. `.devcontainer/devcontainer.json` → schreibt das Devcontainer-Feature
   [`ghcr.io/devcontainers-contrib/features/apt-packages:1`](https://github.com/devcontainers-contrib/features/tree/main/src/apt-packages)
   mit kommaseparierter `packages`-Option

Beim nächsten Container-Build (Trigger: `monoceros apply` oder ein
fresh `start`) führt das Feature `apt-get update && apt-get install -y <list>`
aus. Reproduzierbar: jeder Builder, der die Solution klont und den
Container hochfährt, hat dieselben Pakete im PATH.

## Validierung

Erlaubte Zeichen pro Paketname: `[a-z0-9][a-z0-9.+-]*`. Das blockt
Shell-Metacharacters (`;`, `&`, `|`, `$`, `(`, …), damit ein Tipp-Fehler
keine Shell-Injection ins `apt-get install` einschleusen kann.

Es gibt **keinen kuratierten Whitelist** — der Builder weiß selbst, was
er installieren will. Wenn der Name nicht im apt-Repo existiert,
scheitert der Container-Build mit einer klaren `apt-get`-Fehlermeldung
(`E: Unable to locate package …`).

## Idempotenz

Mehrfach-Aufruf mit denselben oder einer Teilmenge der Pakete →
"No changes — solution is already in the desired state.", Exit 0,
keine Datei-Änderung.

Mehrfach-Aufruf mit zusätzlichen Paketen → akkumuliert die Liste,
Diff-Preview, dann Schreiben.

## Beispiele

Ein Basis-Set für die meisten Solutions:

```sh
monoceros add-apt-packages --yes -- make jq openssh-client tree
monoceros apply
```

Postgres-Client für DB-Probes ergänzen:

```sh
monoceros add-apt-packages --yes -- postgresql-client
monoceros apply
monoceros run -- psql -h postgres -U postgres -c '\dt'
```

Build-Essentials für native Node-Module:

```sh
monoceros add-apt-packages --yes -- build-essential libssl-dev
monoceros apply
```

## Verwandte Befehle

- `monoceros add-language <lang>` — Sprach-Toolchains (Python, Java, Go, …)
- `monoceros add-feature <ref>` — Devcontainer-Features mit eigenen
  Install-Skripten (`gh`, `kubectl`, `docker-in-docker`, …)
- `monoceros apply` — Container neu bauen, damit die Pakete drinlanden

## Fail-Modi

- **`Invalid apt package name: "…"`** — Name enthält Zeichen außerhalb
  `[a-z0-9.+-]`. Tipp-Fehler? Bei Sonderzeichen den Namen prüfen,
  z. B. `lib-...` (Bindestrich erlaubt) vs. `lib_…` (Unterstrich nicht).
- **`No package names given`** — Kein Paket nach `--` übergeben.
  Synopsis prüfen.
- **Container-Build scheitert mit `E: Unable to locate package …`** —
  Paket existiert nicht in den konfigurierten Repos. Korrekten Namen
  via `apt-cache search <stichwort>` im Container suchen
  (`monoceros run -- apt-cache search <stichwort>`) oder die
  Debian-/Ubuntu-Paketsuche im Web nutzen.
