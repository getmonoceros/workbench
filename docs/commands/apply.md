# `monoceros apply`

Materialisiert eine Container-Konfig nach
`$MONOCEROS_HOME/container/<name>/` und fährt den Dev-Container hoch.

```sh
monoceros apply <name>
```

## Zweck

`monoceros apply` ist der Schritt, der eine yml-Konfig konkret aufs
Dateisystem schreibt:

1. Liest `$MONOCEROS_HOME/container-configs/<name>.yml`.
2. Validiert Schema (Felder, Regex-Constraints) und Catalog (existieren
   die referenzierten Sprachen/Services?).
3. Generiert in `$MONOCEROS_HOME/container/<name>/`:
   - `.devcontainer/devcontainer.json`, ggf. `compose.yaml`
   - `.devcontainer/post-create.sh`
   - `<name>.code-workspace`
   - `.claude/settings.json`
   - `.monoceros/.gitignore`
4. Schreibt `.monoceros/state.json` mit `origin: <name>`,
   `schemaVersion`, `monocerosCliVersion`, `materializedAt`.
5. Holt host-seitig die Git-Identity (siehe Priorität unten) und für
   HTTPS-Repos die Credentials.
6. Fährt den Container hoch — Compose-Mode mit Force-Remove +
   `devcontainer up`, Image-Mode mit
   `devcontainer up --remove-existing-container`.

Idempotent: ein zweiter Apply mit derselben Konfig überschreibt die
Scaffold-Files und startet den Container neu.

cwd ist irrelevant — der Befehl funktioniert von überall.

## Synopsis

```sh
monoceros apply <name>
```

## Argument

| Argument | Bedeutung                                                                |
| -------- | ------------------------------------------------------------------------ |
| `<name>` | Konfig-Name. Resolves zu `$MONOCEROS_HOME/container-configs/<name>.yml`. |

## Safety-Check

Der Zielordner `$MONOCEROS_HOME/container/<name>/` muss entweder leer
sein oder bereits eine `state.json` mit passendem `origin: <name>`
tragen. Andernfalls Error — schützt davor, dass ein bestehender
Dev-Container, der zu einer **anderen** Konfig gehört, versehentlich
überschrieben wird.

## Git-Identity-Auflösung

In dieser Reihenfolge wird `user.name` / `user.email` für den
Container ermittelt:

1. **Container-yml** `git.user` (höchste Priorität — explizite
   Per-Container-Wahl)
2. **`$MONOCEROS_HOME/monoceros-config.yml`** `defaults.git.user`
   (workbench-weite Defaults)
3. **Host** `git config --global --get user.name|email`
4. **Wert aus früherem Apply** in `.monoceros/gitconfig`
5. **Interaktiver Prompt** (nur in TTY-Sessions; sonst undefined)

Wenn der Prompt greift (Stufe 5 ist die einzige Quelle), fragt
Monoceros zusätzlich, wo die eingegebenen Werte persistiert werden
sollen:

- **`g` (Global)** — `monoceros-config.yml` `defaults.git.user`. Wird
  zum Default für jeden Container auf dieser Maschine. Default-Wahl,
  weil sie meistens passt.
- **`c` (Container)** — `<name>.yml` `git.user`. Nur dieser Container.
- **`b` (Beide)** — globaler Default plus container-spezifischer
  Override.

In nicht-interaktiven Sessions (CI, Scripts) wird `g` automatisch
gewählt — die Werte bleiben sonst nur in `.monoceros/gitconfig`
dieses Containers und müssten beim nächsten neuen Container neu
eingegeben werden.

## Beispiele

Erst-Setup:

```sh
$ monoceros init nodejs-github sandbox
$ monoceros apply sandbox
✔ Materialized config 'sandbox' into …/container/sandbox. Starting container…
```

Edit + Re-Apply:

```sh
$ monoceros add-service sandbox postgres --yes
$ monoceros apply sandbox
```

Zweite Konfig im selben Home:

```sh
$ monoceros init python data-pipeline
$ monoceros apply data-pipeline
```

Beide Container koexistieren unter `$MONOCEROS_HOME/container/`.

## Verwandte Befehle

- `monoceros init` — Konfig erstellen ([init.md](./init.md))
- `monoceros add-*` / `monoceros remove-*` — Konfig editieren
  (Comment-preserving). Nach jedem Aufruf `monoceros apply <name>`
  zum Materialisieren.
- `monoceros down <name> [--volumes]` — Container entfernen vor einem
  destruktiven Re-Apply.

## Fail-Modi

- **`No such config: <path>`** — die Konfig existiert nicht.
  Lösung: `monoceros init <template> <name>` first.
- **`already materialized from config 'X', not 'Y'`** — Zielordner
  gehört zu einer anderen Konfig. Lösung: `monoceros apply X`
  (re-apply gegen die ursprüngliche Konfig) oder Ordner löschen.
- **`Refusing to materialize into non-empty directory`** — Zielordner
  hat fremde Inhalte und keine state.json. Lösung: Ordner löschen
  oder anderen Konfig-Namen wählen.
- **`Unknown language: X` / `Unknown service: X`** — Catalog-Eintrag
  fehlt. Schema-Validierung ist passiert, aber der Wert ist nicht in
  der Liste der unterstützten Sprachen/Services.
- **`Invalid config name`** — Name enthält Slash, Space oder
  Shell-Meta-Zeichen. Nur `[A-Za-z0-9._-]+` erlaubt.
- **`Missing Git credentials for <host>`** — der Apply holt für jeden
  `repos:`-Host **host-seitig** die HTTPS-Credentials (über den
  Credential-Helper) und mountet sie in den Container, damit der Clone
  dort authentifiziert ist. Findet er keine, bricht er **vor** dem
  Docker-Build mit provider-spezifischen Hinweisen ab (z. B.
  `gh auth login`). Das ist ein **lokaler** Check (kein Netzzugriff auf
  den Git-Host) — er prüft nur, ob ein Credential vorhanden ist.
- **Repo-Clone schlägt fehl** — Repos werden **im Container** geklont
  (post-create.sh, mit dem gemounteten Credential-Helper). Schlägt ein
  Clone fehl (falsches/abgelaufenes Token, getippter URL, Host nicht
  erreichbar), erscheint die echte git-Meldung im Container-Build-Log.
  Häufige Fälle: `could not read Username` → kein Credential; `Invalid
username or token` → Token abgelaufen / ohne Org-Zugriff (GitHub-SSO!)
  / ohne `repo`-Scope. Den Clone nutzt die **Container**-Umgebung —
  Host-spezifische Eigenheiten (VPN-DNS, VS-Code-`GIT_ASKPASS`) spielen
  hier bewusst keine Rolle mehr.
