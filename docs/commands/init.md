# `monoceros init`

Erzeugt eine Container-Konfig unter
`$MONOCEROS_HOME/container-configs/<name>.yml`. Zwei Modi:

```sh
monoceros init <name>                          # documented mode
monoceros init <name> --with=<components>      # composed mode
```

## Zweck

Eine Container-Konfig ist die Wahrheit eines Dev-Containers. Sie
liegt **außerhalb** des Container-Verzeichnisses und kann frei
editiert werden, bevor `monoceros apply <name>` daraus konkret einen
Container materialisiert.

`monoceros init` ist der Erst-Setup-Schritt — er produziert die yml,
nicht den Container.

## Komponenten statt Templates

Die Workbench liefert keine vorgefertigten "Templates" mehr (wie
`bare`, `nodejs-github`, `python`). Stattdessen gibt es einen
Komponenten-Katalog unter
[`templates/components/`](../../templates/components/). Jede
Komponente ist ein kleines yaml-Snippet, das einen Baustein
beschreibt:

| Kategorie  | Beispiele                                                             |
| ---------- | --------------------------------------------------------------------- |
| `language` | `node`, `python`, `java`, `go`, `rust`, `dotnet`                      |
| `service`  | `postgres`, `mysql`, `redis`                                          |
| `feature`  | `claude`, `github`, `atlassian`, `atlassian/twg`, `atlassian/rovodev` |

Der vollständige Katalog kann jederzeit per
[`monoceros list-components`](./list-components.md) angezeigt
werden.

## Documented mode — `monoceros init <name>` (ohne `--with`)

Schreibt eine **dokumentierte Vorlage**, in der jede Komponente aus
dem Katalog auskommentiert mit Erklärung erscheint. Der Builder
liest die Datei, kommentiert die gewünschten Zeilen aus, fertig.

```sh
$ monoceros init sandbox
✔ Wrote documented default to container-configs/sandbox.yml. Un-comment what you need, then `monoceros apply sandbox`.
```

Beispiel-Output (gekürzt):

```yaml
schemaVersion: 1
name: sandbox

# Languages — runtime toolchains.
# languages:
#   - node     # Node 22 + pnpm
#   - python   # Python 3.x via devcontainers/features/python

# Features — devcontainer features installed inside the container.
# features:
#
#   # Anthropic Claude Code CLI
#   # Installs the Claude Code CLI via npm …
#   - ref: ghcr.io/monoceros/features/claude-code:1
#     # Optional — override monoceros-config.yml defaults.features:
#     # options:
#     #   apiKey:
```

## Composed mode — `monoceros init <name> --with=<names>`

Verknüpft die genannten Komponenten zu einer **sofort
applybaren** yml. Auth/Credential-Optionen aus den Feature-
Manifesten (z. B. `apiKey`, `apiToken`) tauchen kommentiert direkt
unter den aktiven Options auf, damit der Builder im File sieht
welche Schlüssel das Feature versteht.

```sh
$ monoceros init sandbox --with=node,postgres,github,claude
✔ Composed 4 component(s) into container-configs/sandbox.yml: node, postgres, github, claude
ℹ Edit the file if you need to tweak, then `monoceros apply sandbox`.
```

Beispiel-Output:

```yaml
schemaVersion: 1
name: sandbox

languages:
  - node

services:
  - postgres

features:
  - ref: ghcr.io/monoceros/features/github-cli:1
    # Optional — override monoceros-config.yml defaults.features:
    # options:
    #   apiToken:
  - ref: ghcr.io/monoceros/features/claude-code:1
    # Optional — override monoceros-config.yml defaults.features:
    # options:
    #   apiKey:
```

## Sub-Komponenten

Manche Features haben Sub-Komponenten für partielle Installs:

| Komponente          | Effekt                          |
| ------------------- | ------------------------------- |
| `atlassian`         | Rovo Dev + twg (beide aktiv)    |
| `atlassian/rovodev` | nur Rovo Dev (twg explizit aus) |
| `atlassian/twg`     | nur twg (Rovo Dev explizit aus) |

Kombinieren ist additiv: `--with=atlassian/rovodev,atlassian/twg`
liefert dasselbe wie `--with=atlassian`. Beim Mergen kollidierender
boolescher Optionen gewinnt `true` — sodass eine Sub-Komponente
allein die andere ausschließt, mehrere Sub-Komponenten zusammen
aber alle aktivieren.

## Argumente

| Argument         | Bedeutung                                                                               |
| ---------------- | --------------------------------------------------------------------------------------- |
| `<name>`         | Wunschname für die Konfig. Landet als `container-configs/<name>.yml`.                   |
| `--with=<names>` | Komma-Liste von Komponenten aus dem Katalog (s. `monoceros list-components`). Optional. |

**Zur `--with`-Syntax**: alle drei Schreibweisen funktionieren:

```sh
monoceros init sandbox --with=node,postgres,github,claude
monoceros init sandbox --with="node, postgres, github, claude"
monoceros init sandbox --with=node, postgres, github, claude
```

Die unquoted Variante mit Leerzeichen wird vom Shell zwar in
mehrere Argumente zerlegt; der Befehl liest aber `rawArgs` mit
und sammelt die abgetrennten Token wieder ein.

## Verwandte Befehle

- [`monoceros list-components`](./list-components.md) — Katalog der
  verfügbaren Komponenten anzeigen
- [`monoceros apply <name>`](./apply.md) — die fertige Konfig in einen
  Container materialisieren
- `monoceros add-*` / `remove-*` — Konfig nachträglich mutieren
  (comment-preserving)

## Fail-Modi

- **`Unknown component: <name>`** — Tippfehler oder Komponente
  existiert nicht. Verfügbare Komponenten werden in der
  Fehlermeldung gelistet.
- **`Config already exists: <path>`** — die Ziel-Datei existiert
  bereits. Lösung: vorhandene yml entweder löschen oder einen
  anderen `<name>` wählen.
- **`Invalid config name`** — `<name>` enthält Slash, Space oder
  Shell-Metazeichen. Erlaubt: `[A-Za-z0-9._-]+`.
- **`No components found`** — die Workbench-Installation hat den
  `templates/components/`-Ordner nicht. Workbench-Checkout
  reparieren.
