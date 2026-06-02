# `monoceros add-feature`

Hängt ein beliebiges Devcontainer-Feature an die Solution an.

## Zweck

Schlägt die Lücke zwischen `add-language` (kuratierte Sprachen) und
`add-apt-packages` (reine apt-Installation) — für Tools, die ihr
eigenes Devcontainer-Feature haben und damit mehr machen als nur
`apt-get install`:

- Eigene apt-Repos einrichten (z. B. GitHub-CLI, Microsoft Edge, HashiCorp Vault)
- Binaries direkt herunterladen und installieren (`kubectl`, `helm`, `terraform`)
- Side-Container-Setup (z. B. `docker-in-docker`)
- Shell-/IDE-Integration konfigurieren (`common-utils`, `git-lfs`)

## Synopsis

```sh
monoceros add-feature <containername> <feature> [--yes] [-- <key>=<value> …]
```

- `<containername>` — Konfig-Name unter
  `$MONOCEROS_HOME/container-configs/<name>.yml`
- `<feature>` — entweder ein **Katalog-Kurzname** aus
  `monoceros list-components` (z. B. `atlassian`, `atlassian/twg`,
  `claude`, `github`) oder eine **vollständige OCI-Ref** (z. B.
  `ghcr.io/devcontainers/features/docker-in-docker:2`).
  Beim Kurznamen bringt das Feature seine Katalog-Default-Optionen mit;
  die werden durch `-- key=value`-Paare überschrieben.
- Optionen nach `--` als `key=value`-Paare

## Optionen

| Flag           | Bedeutung                   |
| -------------- | --------------------------- |
| `--yes` / `-y` | Confirm-Prompt überspringen |

## Credential-Optionen + `${VAR}`

Kuratierte Features deklarieren ihre Credential-Optionen (`apiToken`,
`apiKey`, …) im Manifest. `add-feature` schreibt sie als kommentiertes
`${VAR}`-Skelett unter den `- ref:` und **seedet die passenden Keys in
`<name>.env`** (gitignored) — identisch zu `init`:

```yaml
features:
  - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1
    options:
      rovodev: true
      twg: true
    # options:
    #   instance: ${ATLASSIAN_INSTANCE}
    #   apiToken: ${ATLASSIAN_API_TOKEN}
    #   …
```

```sh
# container-configs/<name>.env  (Keys vorab geseedet, nur Werte fehlen)
ATLASSIAN_INSTANCE=
ATLASSIAN_API_TOKEN=
…
```

Var-Name = `<FEATURE>_<OPTION>` (einheitlich). Du strippst das `#` an
der gewünschten Option, füllst den Wert in die `.env`, und `monoceros
apply` setzt ihn ein — so bleibt die yml teilbar, ohne Tokens
mitzugeben. `remove-feature` fasst die `.env` nicht an.

## Feature-Katalog

Es gibt keinen einzelnen "offiziellen" Index, aber drei verlässliche Quellen:

1. [containers.dev/features](https://containers.dev/features) — Suchbare
   Übersicht über alle bekannten Features mit Publisher und Beschreibung.
2. [`devcontainers/features`](https://github.com/devcontainers/features) —
   Microsoft-kurierte Features. Standard für Sprachen, gh, docker-in-docker,
   kubectl, aws-cli, terraform, common-utils, git, …
3. [`devcontainers-contrib/features`](https://github.com/devcontainers-contrib/features) —
   Community-kurierte Features. Long-Tail-Tooling: apt-packages,
   npm-packages, pre-commit, direnv, starship-shell, …

Jedes Feature hat ein eigenes README im Quell-Repo, das die akzeptierten
Optionen dokumentiert — die einzige verlässliche Spec für das jeweilige
Feature.

## Was `:2` heißt (Versions-Tag)

Devcontainer-Features sind OCI-Artefakte, publiziert auf `ghcr.io`. Der
Tag entspricht der Major-Version:

```
ghcr.io/devcontainers/features/docker-in-docker:2
                                                ^
                                                Major-Version 2
```

Pin auf eine konkrete Major-Version (`:1`, `:2`) für Reproduzierbarkeit
— die Feature-Autoren versprechen Backwards-Compat innerhalb eines
Majors. `:latest` zeigt auf den aktuellsten verfügbaren Major und
kann ohne Vorwarnung brechen.

## Optionen-Syntax (Smart-Coercion)

Optionen kommen nach `--` als `key=value`-Tokens. Der Wert wird typ-
gecoerced, weil Devcontainer-Features die richtigen JSON-Typen
erwarten (`{ "moby": true }`, nicht `{ "moby": "true" }`):

| Eingabe            | Wert in `devcontainer.json`                      |
| ------------------ | ------------------------------------------------ |
| `key=true`         | `true` (Boolean)                                 |
| `key=false`        | `false` (Boolean)                                |
| `key=42`           | `42` (Number)                                    |
| `key=-7`           | `-7` (Number)                                    |
| `key=latest`       | `"latest"` (String)                              |
| `key=1.2.3`        | `"1.2.3"` (String — Dot lässt es String bleiben) |
| `key=/usr/local/x` | `"/usr/local/x"` (String)                        |

## Beispiele

Einfaches Feature ohne Optionen:

```sh
monoceros add-feature sandbox ghcr.io/devcontainers/features/github-cli:1 --yes
monoceros apply sandbox
monoceros run sandbox -- gh --version
```

Mit Optionen:

```sh
monoceros add-feature sandbox ghcr.io/devcontainers/features/docker-in-docker:2 \
  --yes -- version=latest moby=true installDockerBuildx=true
monoceros apply sandbox
```

Mehrere Features akkumulieren:

```sh
monoceros add-feature sandbox ghcr.io/devcontainers/features/github-cli:1 --yes
monoceros add-feature sandbox ghcr.io/devcontainers/features/kubectl-helm-minikube:1 --yes
monoceros add-feature sandbox ghcr.io/devcontainers/features/aws-cli:1 --yes
monoceros apply sandbox
```

Beim Container-Build laufen alle Features in Reihe — Reihenfolge wird
vom Devcontainer-CLI nach Feature-Spec-Dependencies bestimmt.

## Idempotenz und Options-Konflikt

- **Selbe Ref, identische Options** → no-op, kein Schreibvorgang.
- **Selbe Ref, abweichende Options** → **Fehler.** Begründung: stilles
  Überschreiben einer getuneten Options-Map ist gefährlich. Wenn du
  Options ändern willst, erst
  `monoceros remove-feature <name> <ref>`, dann `add-feature` neu.
- **Andere Ref** → Feature wird hinzugefügt, Liste akkumuliert.

## Validierung

Feature-Refs müssen dem OCI-Pattern `<host>/<path>:<tag>` entsprechen:

```
^[a-z0-9.-]+(/[a-z0-9._-]+)+:[a-z0-9._-]+$
```

Blockt Shell-Metacharacters und Leerzeichen — schützt davor, dass eine
unsaubere Ref direkt in `devcontainer.json` landet und vom Build-Tool
falsch interpretiert wird.

## Verwandte Befehle

- `monoceros add-language <name> <lang>` — kuratierte Sprach-Features
  (Python, Java, Go, Rust, .NET). Ergonomischer als der volle Feature-Ref.
- `monoceros add-apt-packages <name> -- <pkg> …` — wenn das Tool kein
  eigenes Feature hat und schlicht `apt install` reicht.
- `monoceros remove-feature <name> <ref>` — Inverse, auch der Weg
  Options zu ändern.
- `monoceros apply <name>` — Container neu bauen, damit das Feature
  drinlandet.

## Fail-Modi

- **`Invalid devcontainer feature ref`** — Ref entspricht nicht dem
  OCI-Pattern. Häufige Ursachen: Tag vergessen (`…/feature` statt
  `…/feature:1`), Tippfehler im Pfad, Leerzeichen.
- **`Feature ${ref} is already configured with different options`** —
  Du versuchst dieselbe Ref mit anderen Options-Values hinzuzufügen.
  Lösung: erst `monoceros remove-feature <name> <ref>`, dann
  `add-feature` neu.
- **`Invalid option: "…". Expected key=value`** — Token nach `--` ist
  kein `key=value`-Paar. Schreibweise prüfen, evtl. shell-Quoting
  (`"key=value with spaces"`).
- **Container-Build scheitert mit "Failed to fetch feature"** — die
  Ref ist syntaktisch ok, aber das Feature ist nicht erreichbar (Tippo
  im Pfad, Netzwerk-Problem, GHCR temporär down). Diagnose: Ref im
  Browser öffnen (`https://ghcr.io/…`) oder
  `docker pull <ref>` host-seitig.
