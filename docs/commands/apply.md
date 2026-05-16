# `monoceros apply`

Materialisiert eine Container-Konfig in einem Dev-Container-Verzeichnis
und fährt den Container hoch. Hat zwei Aufruf-Formen:

```sh
monoceros apply <name> [<path>]    # explizit: Konfig → Verzeichnis
monoceros apply                    # implizit: aktueller Container neu anwenden
```

## Zweck

Eine Container-Konfig (`.local/container-configs/<name>.yml`) ist die
**Wahrheit** eines Dev-Containers. Sie kann von mehreren
Dev-Container-Verzeichnissen referenziert werden. `monoceros apply`
ist der Schritt, der diese Wahrheit konkret aufs Dateisystem schreibt:

1. Generiert `.devcontainer/devcontainer.json`, `compose.yaml` (falls
   Services), `post-create.sh`, `<name>.code-workspace`,
   `.claude/settings.json`, `.monoceros/.gitignore`.
2. Schreibt `.monoceros/state.json` mit `origin: <name>` als Rück-
   zeiger auf die Konfig.
3. Holt host-seitig die Git-Identity und (für HTTPS-Repos) die
   Credentials.
4. Fährt den Container hoch (`devcontainer up`, ggf. mit Compose-
   Teardown davor).

Idempotent: ein zweiter Apply mit derselben Konfig + selbem Pfad
überschreibt die Scaffold-Files mit der aktuellen Konfig-Version und
startet den Container neu.

## Form 1: `monoceros apply <name> [<path>]`

```sh
monoceros apply sandbox             # Materialisiert sandbox.yml in cwd
monoceros apply sandbox ./play/foo  # …in ./play/foo
```

Pfad-Resolution: relativ zur cwd; absoluter Pfad akzeptiert.

Default-Pfad: cwd.

**Safety-Check**: der Zielordner muss entweder leer sein oder bereits
eine `state.json` mit passendem `origin: <name>` tragen. Andernfalls
error — schützt davor, dass du versehentlich in eine fremde Solution
oder in einen Projekt-Folder überschreibst.

## Form 2: `monoceros apply` (ohne Argumente)

```sh
cd ~/play/sandbox
monoceros apply
```

Walks-Up von cwd nach einer `.devcontainer/`-Direktive, liest die
`state.json` und re-applied gegen die Konfig, auf die `origin` zeigt.
Ideal nach `monoceros add-*`/`remove-*`-Aufrufen, die die Konfig
mutieren.

### Migration von Legacy-Solutions

Solutions, die mit `monoceros create` (M1/M2) angelegt wurden, tragen
eine `stack.json` statt `state.json`. Beim ersten `monoceros apply` in
so einem Verzeichnis wird automatisch migriert:

1. yml-Konfig wird aus `stack.json` generiert und in
   `.local/container-configs/<stack.name>.yml` abgelegt.
2. `state.json` wird mit `origin: <stack.name>` geschrieben.
3. `stack.json` wird in `stack.json.legacy` umbenannt (bleibt für
   Post-Mortem-Diffing erhalten, wird nicht mehr gelesen).
4. Der normale Apply-Pfad läuft direkt im Anschluss.

Folge-Applies finden `state.json` und routen direkt durch — keine
erneute Migration.

**Wenn unter `.local/container-configs/<stack.name>.yml` schon eine
yml liegt** (z. B. weil du parallel `monoceros init` gemacht hast),
wird die Migration abgebrochen. Lösung: yml manuell löschen oder den
Solution-Namen ändern.

## Synopsis

```sh
monoceros apply [<name> [<path>]] [--project=<path>]
```

| Flag / Arg         | Bedeutung                                                                |
| ------------------ | ------------------------------------------------------------------------ |
| `<name>`           | Konfig-Name (Form 1). Resolves zu `.local/container-configs/<name>.yml`. |
| `<path>`           | Ziel-Verzeichnis (Form 1). Default: cwd.                                 |
| `--project=<path>` | Solution-Root explizit (Form 2). Default: walks-up von cwd.              |

## Mechanik im Detail

### Form 1 (explizit)

1. **Name-Validierung** (`[A-Za-z0-9._-]+`).
2. **yml laden** + schema-validieren.
3. **Catalog-Validierung**: Sprachen/Services müssen im
   `LANGUAGE_CATALOG`/`SERVICE_CATALOG` existieren.
4. **Safe-Dir-Check** (leer ODER bestehende state.json mit gleichem
   origin).
5. **Scaffold schreiben** (siehe Liste oben).
6. **state.json** schreiben.
7. **Git-Identity** host-seitig holen (`git config --global --get`).
8. **HTTPS-Credentials** pro Host holen (`git credential fill`) —
   nur wenn ein HTTPS-Repo in der Konfig steht.
9. **Container-Cycle**:
   - Compose-Mode (Services konfiguriert): Force-Remove der bestehenden
     Container nach Label-Filter, dann `devcontainer up`.
   - Image-Mode (keine Services): `devcontainer up
--remove-existing-container`.

### Form 2 (implizit, Phase-3-Solution)

`findSolutionRoot(cwd)` → `state.json` lesen → `runApplyFromYml`
mit `name = state.origin` und `targetDir = solution-root` — also genau
Form 1, nur die Argumente kommen aus state.json.

### Form 2 (implizit, Legacy-Solution)

`findSolutionRoot(cwd)` → keine `state.json`, aber `stack.json` →
Migration (siehe oben) → `runApplyFromYml`.

## Beispiele

Erst-Setup einer neuen Solution:

```sh
$ monoceros init nodejs-github sandbox
$ vim .local/container-configs/sandbox.yml      # repos: einkommentieren
$ mkdir -p .local/play/sandbox && cd .local/play/sandbox
$ monoceros apply sandbox .
```

Zweiter Container, gleiche Konfig:

```sh
$ mkdir -p .local/play/sandbox-clone
$ monoceros apply sandbox .local/play/sandbox-clone
```

Edit der Konfig + Re-Apply aus dem Container:

```sh
$ vim .local/container-configs/sandbox.yml      # add a service
$ cd .local/play/sandbox
$ monoceros apply                                # picks up state.json → sandbox.yml
```

Migration einer Legacy-Solution (erster Apply nach Workbench-Upgrade):

```sh
$ cd ~/old-solution
$ monoceros apply
✔ Migrated /Users/.../old-solution to the yml model. yml: …/old-solution.yml, stack.json archived as stack.json.legacy.
✔ Materialized config 'old-solution' into /Users/.../old-solution. Starting container…
```

## Verwandte Befehle

- `monoceros init` — Konfig erstellen ([init.md](./init.md))
- `monoceros add-*` / `monoceros remove-*` — Konfig editieren (Comment-
  preserving). Nach jedem Aufruf `monoceros apply` zum
  Materialisieren.
- `monoceros down [--volumes]` — Container entfernen vor einem
  destruktiven Re-Apply.

## Fail-Modi

- **`No such config: <path>`** — die Konfig existiert nicht. Lösung:
  `monoceros init <template> <name>` first.
- **`Refusing to materialize into non-empty directory`** — Zielordner
  hat fremde Inhalte und keine state.json. Lösung: anderen Pfad
  wählen oder Zielordner aufräumen.
- **`already materialized from config 'X', not 'Y'`** — Zielordner
  gehört zu einer anderen Konfig. Lösung: `monoceros apply X` (re-
  apply gegen die ursprüngliche Konfig) oder Ordner löschen.
- **`Migration aborted: yml at <path> already exists`** — bei der
  Legacy-Migration: unter `<stack.name>` liegt bereits eine yml. Eine
  davon manuell entfernen.
- **`Unknown language: X` / `Unknown service: X`** — Catalog-Eintrag
  fehlt. Schema-Validierung ist passiert, aber der Wert ist nicht in
  der Liste der unterstützten Sprachen/Services.
- **`No .devcontainer/ found at or above <dir>`** — Form 2 hat den
  Solution-Root nicht gefunden. Erst `apply <name> <dir>` machen.
