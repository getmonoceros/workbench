# `monoceros init`

Erzeugt eine Container-Konfig unter
`$MONOCEROS_HOME/container-configs/<name>.yml`. Zwei Modi:

```sh
monoceros init <name>                                   # documented mode
monoceros init <name> --with-languages=… --with-features=… \
  --with-services=… --with-apt-packages=… \
  --with-repos=… --with-ports=…                         # composed mode
```

Ohne ein `--with-*`-Flag schreibt init eine dokumentierte Vorlage (alles
auskommentiert). Sobald **eine** Kategorie gesetzt ist, wird eine
sofort applybare yml komponiert.

## Zweck

Eine Container-Konfig ist die Wahrheit eines Dev-Containers. Sie liegt
**außerhalb** des Container-Verzeichnisses und kann frei editiert werden,
bevor `monoceros apply <name>` daraus einen Container materialisiert.
`monoceros init` ist der Erst-Setup-Schritt — er produziert die yml,
nicht den Container.

## Kategorie-Flags

Statt eines Magic-Bags hat jede Kategorie ihr eigenes Flag. Alle nehmen
eine Komma-Liste oder wiederholte Vorkommen:

| Flag                  | Inhalt                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--with-languages`    | Sprach-Runtimes, kuratiert. Optional `:version` (`java:17`). Katalog: `monoceros list-components`.                                                     |
| `--with-features`     | Features. Katalog-Kurzname (`claude`, `atlassian/twg`) **oder** volle OCI-Ref (`ghcr.io/foo/bar:1`).                                                   |
| `--with-services`     | Backing-Services. Kuratierter Name (`postgres`) → voller Block; beliebiges Image (`rustfs/rustfs:latest`) → name+image + auskommentiertes Grundgerüst. |
| `--with-apt-packages` | Beliebige apt-Pakete (`openssl`, `make`). Kein Katalog.                                                                                                |
| `--with-repos`        | Git-URLs, geklont nach `projects/` beim ersten Apply. Nur kanonische Hosts (github.com / gitlab.com / bitbucket.org).                                  |
| `--with-ports`        | Interne Container-Ports → Traefik-Routing. Erster Eintrag = `<name>.localhost`.                                                                        |

Kuratiert vs. beliebig: bei **Features** und **Services** entscheidet
der Katalog — ist der Name bekannt, wird er expandiert; sonst als
OCI-Ref bzw. Image interpretiert. **Sprachen** sind kuratiert (es gibt
nur eine Handvoll Runtimes).

## Documented mode — `monoceros init <name>` (ohne `--with-*`)

Schreibt eine **dokumentierte Vorlage**: jede Katalog-Komponente
erscheint auskommentiert mit Erklärung. Der Builder kommentiert die
gewünschten Zeilen aus, fertig.

```sh
$ monoceros init sandbox
✔ Wrote documented default to container-configs/sandbox.yml. Un-comment what you need, then `monoceros apply sandbox`.
```

## Composed mode

Verknüpft die genannten Pieces zu einer sofort applybaren yml.
Auth-Optionen aus den Feature-Manifesten (z. B. `apiKey`, `apiToken`)
tauchen kommentiert unter den aktiven Options auf.

```sh
$ monoceros init sandbox \
    --with-languages=node \
    --with-services=postgres,rustfs/rustfs:latest \
    --with-features=claude \
    --with-apt-packages=make \
    --with-ports=3000
```

Erzeugt (gekürzt):

```yaml
schemaVersion: 1
name: sandbox

languages:
  - node

aptPackages:
  - make

services:
  - name: postgres # kuratiert → voller Block
    image: postgres:18
    port: 5432
    env:
      POSTGRES_USER: monoceros
      POSTGRES_PASSWORD: monoceros
      POSTGRES_DB: monoceros
    volumes:
      - data:/var/lib/postgresql
  - name: rustfs # Custom-Image → name+image + Grundgerüst
    image: rustfs/rustfs:latest
    # port: 8080
    # env:
    #   KEY: ${SOME_VAR}
    # volumes:
    #   - data:/data

features:
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
    # options:
    #   apiKey:

routing:
  ports:
    - 3000
```

## Versionen für Sprachen

Sprach-Einträge akzeptieren ein optionales `:version`-Suffix, das an das
upstream-Devcontainer-Feature als `version`-Option durchgereicht wird:

```sh
monoceros init sandbox --with-languages=java:17,node:20,python:3.12
```

Sonderfall `node`: ohne Version bleibt es ein Built-in der Basis-Image-
Runtime (Node 22); `node:<version>` schaltet auf das upstream-Feature um.

## Sub-Komponenten (Features)

Manche Features haben Sub-Komponenten für partielle Installs:

| Eintrag             | Effekt                          |
| ------------------- | ------------------------------- |
| `atlassian`         | Rovo Dev + twg (beide aktiv)    |
| `atlassian/rovodev` | nur Rovo Dev (twg explizit aus) |
| `atlassian/twg`     | nur twg (Rovo Dev explizit aus) |

Kombinieren ist additiv:
`--with-features=atlassian/rovodev,atlassian/twg` liefert dasselbe wie
`--with-features=atlassian`. Beim Mergen kollidierender boolescher
Optionen gewinnt `true`.

## Schreibweisen

Alle Flags akzeptieren Komma-Liste, Wiederholung und Shell-getrennte
Token mit Leerzeichen:

```sh
monoceros init sandbox --with-languages=java,node
monoceros init sandbox --with-languages=java --with-languages=node
monoceros init sandbox --with-languages="java, node"
```

## Verwandte Befehle

- [`monoceros list-components`](./list-components.md) — Katalog anzeigen
- [`monoceros apply <name>`](./apply.md) — Konfig materialisieren
- [`monoceros add-service`](./add-service.md) / `add-feature` / … —
  Konfig nachträglich mutieren (comment-preserving)

## Fail-Modi

- **`Unknown language: <name>`** — kein bekannter Runtime. Bekannte
  werden gelistet.
- **`Unknown feature: <name>`** — kein Katalog-Kurzname und keine gültige
  OCI-Ref. Nutze einen Kurznamen oder `ghcr.io/…/<name>:<tag>`.
- **`Invalid apt package name`** — nur `[a-z0-9][a-z0-9.+-]*`.
- **`Two --with-services entries resolve to the service name '<x>'`** —
  Namenskollision. Einen Service nach dem Init mit
  `monoceros add-service <name> <image> --as=<other>` hinzufügen.
- **`Config already exists: <path>`** — Ziel-Datei existiert. yml löschen
  oder anderen `<name>` wählen.
- **`Invalid config name`** — nur `[A-Za-z0-9._-]+`.
- **`--with-repos only supports github.com / gitlab.com / bitbucket.org`**
  — nicht-kanonischer Host. Erst `monoceros init <name>`, dann
  `monoceros add-repo <name> <url> --provider=…`.
