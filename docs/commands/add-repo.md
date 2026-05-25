# `monoceros add-repo`

Registriert ein Git-Repository, das beim nächsten Container-Build nach
`projects/<path>/` geklont wird.

## Zweck

Eine Solution besteht aus einem Workspace-Wrapper (`.devcontainer/`,
`.monoceros/`, `home/`) und einem oder mehreren Code-Repos in
`projects/`. `add-repo` macht diese Repos deklarativ — einmal
hinzufügen, danach klont jeder Container-Rebuild und jeder neue
Builder, der die Solution übernimmt, automatisch dieselben Sourcen.

Was es **nicht** ist:

- Kein `git clone` ad-hoc (das passiert beim nächsten `monoceros apply`,
  nicht beim `add-repo`-Aufruf selbst).
- Kein Push-Mechanismus (im Container `git push` wie üblich — Auth
  funktioniert über den Host-Credential-Helper, siehe unten).
- Keine SSH-Auth (siehe [ADR 0006](../adr/0006-https-only-repo-auth.md) —
  Monoceros unterstützt HTTPS-URLs).

## Synopsis

```sh
monoceros add-repo <containername> <url> [--path=<folder>] \
                   [--git-name=<name> --git-email=<email>] \
                   [--provider=github|gitlab|bitbucket|gitea] [--yes]
```

## Optionen

| Flag                  | Bedeutung                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--path=<folder>`     | Override des Zielpfads unter `projects/`. Subfolders erlaubt (`apps/web`). Default: aus URL abgeleitet (`bar.git` → `bar`).                                                                                                                                                                                                                                           |
| `--git-name=<name>`   | Per-Repo Git-Committer-Name. Override für das Container-Level `git.user.name`. Mit `--git-email` koppeln.                                                                                                                                                                                                                                                             |
| `--git-email=<email>` | Per-Repo Git-Committer-Email. Mit `--git-name` koppeln. Beide gemeinsam oder gar nicht.                                                                                                                                                                                                                                                                               |
| `--provider=<name>`   | Git-Provider-Hinweis (`github` \| `gitlab` \| `bitbucket` \| `gitea`). **Pflicht für Hosts außerhalb von `github.com` / `gitlab.com` / `bitbucket.org`.** Steuert, welche CLI-Setup-Anleitung der Pre-Flight zeigt, wenn Credentials fehlen. Für die drei kanonischen Hosts überflüssig (auto-detect). `gitea` deckt auch Forgejo ab — gleiche API, gleicher UI-Flow. |
| `--yes` / `-y`        | Confirm-Prompt überspringen.                                                                                                                                                                                                                                                                                                                                          |

## Mechanik

1. Die Container-yml `$MONOCEROS_HOME/container-configs/<containername>.yml`
   bekommt einen Eintrag in `repos:`. Reihenfolge bleibt erhalten —
   wenn Klone aufeinander aufbauen, in der gewünschten Reihenfolge
   hinzufügen. Kommentare und andere Felder bleiben unangetastet.
2. Beim nächsten `monoceros apply <containername>` regeneriert sich
   `.devcontainer/post-create.sh`. Pro Repo kommt ein Idempotenz-Block:
   ```bash
   if [ ! -d "projects/bar" ]; then
     echo "→ Cloning bar from https://github.com/foo/bar.git…"
     git clone "https://github.com/foo/bar.git" "projects/bar"
   else
     echo "→ projects/bar already exists, skipping clone"
   fi
   ```
   Falls per-Repo `git.user` gesetzt ist, kommen direkt danach zwei
   `git -C projects/bar config user.name/email`-Zeilen.
3. `<containername>.code-workspace` bekommt einen zusätzlichen Folder-
   Root für `projects/<path>/`. Beim Öffnen in VS Code erscheint das
   Repo als eigene Spalte im Explorer.
4. Beim Container-Build läuft `git clone`. Auth via HTTPS-Credentials
   die von `monoceros apply` aus dem Host-Git-Credential-System gezogen
   werden (siehe Auth-Sektion unten).

## URL-Format

**HTTPS-only.** Akzeptierte URLs:

| URL                                                  | Folder unter `projects/` |
| ---------------------------------------------------- | ------------------------ |
| `https://github.com/foo/bar.git`                     | `bar`                    |
| `https://github.com/foo/bar`                         | `bar`                    |
| `https://gitlab.com/group/sub/repo.git`              | `repo`                   |
| `https://github.com/foo/bar.git` + `--path=apps/web` | `apps/web`               |

SSH-URLs (`git@github.com:…`, `ssh://…`) werden vom Schema abgelehnt
mit klarer Fehlermeldung. Siehe
[ADR 0006](../adr/0006-https-only-repo-auth.md) für die Begründung —
zusammengefasst: HTTPS deckt alle realistischen Git-Hosts ab (GitHub,
GitLab, Gitea, Bitbucket — alle haben Personal-Access-Tokens) und
vermeidet plattformspezifische SSH-Agent-Forwarding-Komplexität auf
macOS und Windows Docker Desktop.

**Du nimmst die URL aus dem "Clone" / "Clone or download"-Dialog des
Git-Hosts** — meistens gibt's dort einen HTTPS-Tab neben dem SSH-Tab.

## Idempotenz

- **Selbe URL, selber Path** → no-op.
- **Selbe URL, anderer Path** → neuer Eintrag (zweiter Klon des Repos
  in einen anderen Folder — selten, aber zulässig).
- **Selber Path, andere URL** → Validierungsfehler beim Apply
  („Duplicate repo path"). Mit `--path` einen davon umbenennen.
- **Wenn der Folder unter `projects/<path>/` schon existiert** → der
  Clone-Step skippt; deine lokalen Änderungen bleiben unangetastet.
  Auch nach `monoceros apply` mit Container-Rebuild.

## Path-Derivation

Aus URL wird der Default-Path automatisch abgeleitet (Last-Segment,
`.git` entfernt). Override via `--path=<folder>` wenn der Default-Name
ungünstig ist oder Subfolder gewünscht sind:

```sh
monoceros add-repo sandbox https://github.com/foo/bar.git              # → projects/bar
monoceros add-repo sandbox https://github.com/foo/bar.git --path=ui    # → projects/ui
monoceros add-repo sandbox https://github.com/foo/web.git --path=apps/web   # → projects/apps/web
```

## Beispiele

Einzelnes öffentliches Repo:

```sh
monoceros add-repo sandbox https://github.com/foo/bar.git
monoceros apply sandbox
ls $MONOCEROS_HOME/container/sandbox/projects/bar/
```

Mit Subfolder-Pfad:

```sh
monoceros add-repo sandbox https://github.com/foo/web.git --path=apps/web
monoceros apply sandbox
```

Mehrere Repos:

```sh
monoceros add-repo sandbox https://github.com/myorg/api.git
monoceros add-repo sandbox https://github.com/myorg/web.git
monoceros add-repo sandbox https://github.com/myorg/types.git --path=shared
monoceros apply sandbox
```

Self-hosted GitLab (`provider` ist Pflicht, sonst weiß der Pre-Flight
nicht, welche CLI-Anleitung er zeigen soll):

```sh
monoceros add-repo dev https://git.firma.de/team/app.git --provider=gitlab
monoceros apply dev
```

Self-hosted Gitea (oder Forgejo — gleicher Provider-Wert, gleicher
Auth-Flow):

```sh
monoceros add-repo dev https://gitea.deine-firma.de/team/app.git --provider=gitea
monoceros apply dev
```

Per-Repo Committer-Identität (work vs personal):

```sh
monoceros add-repo dev https://github.com/conciso/api.git \
  --git-name="Thorsten Kamann" --git-email=thorsten.kamann@conciso.de
monoceros add-repo dev https://github.com/kamann-info/blog.git \
  --git-name="Thorsten Kamann" --git-email=thorsten@kamann.info
```

Layout im materialisierten Container danach:

```
$MONOCEROS_HOME/container/sandbox/
  home/  .devcontainer/  .monoceros/
  sandbox.code-workspace
  projects/
    api/      ← geklont
    shared/   ← geklont
    web/      ← geklont
    apps/web/ ← geklont (Subfolder)
```

## Validierung

- **URL**: muss mit `https://` anfangen, nur URL-safe Zeichen. SSH-
  Style-URLs (`git@host:…`, `ssh://…`, `git://…`) werden mit
  Fehlermeldung abgelehnt.
- **Path**: muss `[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*` matchen. Slashes
  für Subfolders erlaubt, kein führendes / trailing `/`, keine `..`-
  oder `.`-Segmente.
- **Git-Identität**: `--git-name` und `--git-email` nur gemeinsam.
  Email muss `<...>@<...>.<...>` matchen.
- **Provider**: Nur `github` / `gitlab` / `bitbucket` erlaubt. Bei
  Host `github.com` / `gitlab.com` / `bitbucket.org` ist der Wert
  redundant (auto-detect) und darf höchstens dem kanonischen Provider
  entsprechen — Widerspruch wird abgelehnt. Bei anderen Hosts ist
  `--provider` Pflicht, sonst Fehlermeldung.

## Auth

### HTTPS-Credentials

Bei jedem `monoceros apply` läuft host-seitig `git credential fill`
pro unique Host (`github.com`, `gitlab.com`, deine Gitea-Instanz, …):

- Host-git fragt deinen lokalen Credential-Helper (macOS-Keychain,
  Windows Credential Manager, Linux libsecret, `gh auth setup-git` für
  GitHub specifically) — das ist OS-Detail, das du nie merkst, weil
  dein Host das schon konfiguriert hat.
- Resultat: Username + Token landen in
  `<container-dir>/.monoceros/git-credentials` (Mode `0o600`).
- Im Container ist `credential.helper = store --file=<workspace>/.monoceros/git-credentials`
  konfiguriert → liest die Datei → klont/pusht ohne Prompt.

Wenn dein Host-Helper für einen Host noch nichts gespeichert hat,
prompted die Host-Helper-UI während `monoceros apply` (Keychain-Popup,
GCM-Window, Terminal-Prompt — je nach OS). Nach diesem einmaligen
Schritt ist's gespeichert und Folge-Applies sind silent.

Die Credentials-Datei wird **bei jedem Apply neu geschrieben** — stale
Tokens (revoked, expired) werden automatisch durch fresh-vom-Host-
gefetchte ersetzt.

**Wenn host-seitig kein Credential-Helper konfiguriert ist**:
`git credential fill` returnt leer, Container-Clone scheitert mit
„could not read Username for `<host>`: No such device or address".
Setup-Anleitung pro OS findest du in der `monoceros init`-Doku unter
„Voraussetzungen".

### Commit-Identität (`user.name` / `user.email`)

Auflösung pro Repo (höchste Priorität gewinnt):

1. Per-Repo `git.user` aus der Container-yml (gesetzt via
   `--git-name`/`--git-email`)
2. Container-Level `git.user`
3. `defaults.git.user` aus `~/.monoceros/monoceros-config.yml`
4. Host-seitiges `git config --global --get user.name/email`
5. Persisted in `.monoceros/gitconfig` (von früherem Apply)
6. Interaktiver Prompt (falls TTY)

post-create.sh setzt `git -C projects/<path> config user.name/email`
direkt nach dem Clone, sodass die Per-Repo-Identität ab dem ersten
Commit greift.

## On-the-fly-Clone bei laufendem Container

Wenn der Container für den Namen gerade läuft, klont `add-repo` den
Repo direkt nach `projects/<path>/` im Container — kein `monoceros
apply` nötig. Mechanik:

1. Container über Docker-Label `devcontainer.local_folder` finden.
   Nicht laufend → Fall-back: nur yml aktualisieren, Hinweis zeigt
   den `apply`-Befehl für später.
2. Host-seitige HTTPS-Credentials für den Repo-Host abholen
   (gleicher Mechanismus wie beim Apply-Pre-Flight). Keine
   Credentials → yml bleibt aktualisiert, Hinweis zeigt was zu tun
   ist (`gh auth login` etc.).
3. `docker exec` im laufenden Container: `mkdir -p projects/<parent>`,
   dann `git clone <url> projects/<path>`. Idempotent — wenn der
   Folder schon existiert, wird übersprungen.
4. Wenn `--git-name`/`--git-email` gesetzt war: `git -C projects/<path>
config user.name/email` direkt nach dem Clone.

Alle Fehler im on-the-fly-Pfad lassen die yml-Änderung **bestehen**
— ein späterer `monoceros apply` holt nach. Die yml ist die Wahrheit;
der Container-Klon ist Bequemlichkeit.

## Verwandte Befehle

- `monoceros init <name> --with-repo=<url>` — Repo direkt beim Erstellen
  der Container-yml mit reinziehen. Löst auch den Identity-Prompt
  aus wenn nötig.
- `monoceros apply <name>` — Container neu bauen, falls der
  on-the-fly-Clone nicht greift (Container war nicht da, etc.).
- `monoceros run <name> -- git status` — Git-Operationen im Container.
- `monoceros remove-repo <name> <url-or-path>` — Inverse.

## Fail-Modi

- **`Invalid repo URL. Only HTTPS URLs are supported`** — du hast eine
  SSH-Style-URL hingeschrieben. Nimm die HTTPS-Variante aus dem Clone-
  Dialog des Git-Hosts.
- **`Invalid repo path`** — Path enthält verbotene Zeichen oder
  `..`/`.`-Segmente. Charset prüfen, kein führendes/trailing `/`.
- **`Duplicate repo path`** — zwei Repos beanspruchen denselben
  `projects/<path>/`-Slot. Mit `--path` einen davon umbenennen.
- **Clone scheitert mit `could not read Username for '<host>'`** —
  host-seitig kein Credential-Helper, oder Helper hat keinen Eintrag
  für diesen Host. Auf macOS `gh auth setup-git` für GitHub, oder
  manuell `git config --global credential.helper osxkeychain` + einmal
  `git ls-remote <https-url>` zum Speichern eines Tokens.
- **Clone scheitert mit `Repository not found`** — URL falsch oder
  Repo privat _und_ Token hat keine Zugriffsrechte. Token-Scopes auf
  GitHub prüfen (mindestens `repo` für private Repos).

- **`Cannot reach declared repo: …` beim `monoceros apply`** —
  Pre-Flight Stage 2 hat host-seitig `git ls-remote <url>`
  ausgeführt und einen Fehler bekommen. Drei häufige Ursachen:
  - **Repository not found / may not have access** → URL prüfen (case-
    sensitive), Workspace-Mitgliedschaft prüfen, Token-Scope erweitern
    (GitHub: `repo`, GitLab: `read_repository`, Bitbucket: repo read).
  - **Authentication failed** (Creds präsent, abgelehnt) → Token
    abgelaufen oder revoked. Neu generieren, `gh auth login` /
    `glab auth login` neu durchlaufen.
  - **Could not resolve host** → DNS / VPN / offline. Bei
    Firmen-Hosts: VPN check.
