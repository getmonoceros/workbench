# `monoceros add-repo`

Registriert ein Git-Repository, das beim nächsten Container-Build nach
`projects/<name>/` geklont wird.

## Zweck

Eine Solution besteht aus einem Workspace-Wrapper (`.devcontainer/`,
`.monoceros/`, `.claude/`) und einem oder mehreren Code-Repos in
`projects/`. `add-repo` macht diese Repos deklarativ — einmal
hinzufügen, danach klont jeder Container-Rebuild und jeder neue
Builder, der die Solution übernimmt, automatisch dieselben Sourcen.

Was es **nicht** ist:

- Kein `git clone` ad-hoc (das passiert beim nächsten `monoceros apply`,
  nicht beim `add-repo`-Aufruf selbst)
- Kein Push-Mechanism (Workflow: in der Shell `git push` wie üblich —
  funktioniert via SSH-Agent-Forwarding, siehe unten)
- Keine HTTPS-Credential-Helper-Magie (siehe Auth-Sektion unten)

## Synopsis

```sh
monoceros add-repo <containername> <url> [--as=<folder>] [--branch=<b>] [--yes]
```

## Optionen

| Flag           | Bedeutung                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `--as=<n>`     | Override des Folder-Namens unter `projects/`. Default: aus URL abgeleitet (`bar.git` → `bar`). |
| `--branch=<b>` | Spezifischen Branch klonen. Default: Repo-Default-Branch.                                      |
| `--yes` / `-y` | Confirm-Prompt überspringen                                                                    |

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
   Bei `--branch develop` kommt `--branch develop` ans `git clone` dran.
3. `<containername>.code-workspace` bekommt einen zusätzlichen Folder-
   Root für `projects/<folder>/`. Beim Öffnen in VS Code erscheint das
   Repo als eigene Spalte im Explorer.
4. Beim Container-Build läuft `git clone`. Dafür braucht der Container
   `git` im PATH — kommt im Default-Runtime-Image mit.

## Idempotenz

- **Selbe URL, selber Name, selber Branch** → no-op
- **Selber Name, andere URL** → Validierungsfehler beim Apply
  (`Duplicate repo name`). `--as` zur Disambiguierung nutzen.
- **Wenn der Folder unter `projects/<folder>/` schon existiert** → der
  Clone-Step skippt; deine lokalen Änderungen bleiben unangetastet.
  Auch nach `monoceros apply` mit Container-Rebuild — der Bind-Mount
  des Workspace-Folders überlebt das.

## Name-Derivation

Aus URL wird der Folder-Name automatisch abgeleitet (Last-Segment, `.git` entfernt):

| URL                                   | abgeleiteter Folder-Name |
| ------------------------------------- | ------------------------ |
| `https://github.com/foo/bar.git`      | `bar`                    |
| `https://github.com/foo/bar`          | `bar`                    |
| `git@github.com:foo/bar.git`          | `bar`                    |
| `ssh://git@github.com:22/foo/bar.git` | `bar`                    |

Override via `--as=<n>` wenn der Default-Name ungünstig ist (zwei
Repos namens `cli` aus unterschiedlichen Orgs kollidieren).

## Beispiele

Einzelnes öffentliches Repo:

```sh
monoceros add-repo sandbox https://github.com/foo/bar.git
monoceros apply sandbox
ls $MONOCEROS_HOME/container/sandbox/projects/bar/
```

Mit Branch und Custom-Folder:

```sh
monoceros add-repo sandbox https://github.com/foo/bar.git --as=ui --branch=develop
monoceros apply sandbox
```

Mehrere Repos:

```sh
monoceros add-repo sandbox https://github.com/myorg/api.git
monoceros add-repo sandbox https://github.com/myorg/web.git
monoceros add-repo sandbox https://github.com/myorg/types.git --as=shared
monoceros apply sandbox
```

Layout im materialisierten Container danach:

```
$MONOCEROS_HOME/container/sandbox/
  .claude/  .devcontainer/  .monoceros/
  sandbox.code-workspace
  projects/
    api/      ← geklont
    shared/   ← geklont
    web/      ← geklont
```

## Validierung

- **URL**: nur URL-safe Zeichen, kein Shell-Meta (`;`, `|`, `$`, backtick, …). Akzeptiert HTTPS, SSH (`git@host:path`), `ssh://`, `git://`.
- **Name**: muss `[A-Za-z0-9._-]+` matchen (kein Slash, kein Space). Folder-Safe.
- **Branch**: `[A-Za-z0-9._/-]+` (Slashes erlaubt für `feature/foo`-Konventionen).

## Auth

Sobald in `der `repos:`-Liste der Container-yml` mindestens ein Eintrag steht, wird der
Dev-Container automatisch so vorbereitet, dass git im Container
dieselben Auth-Wege nutzen kann wie auf dem Host. **Du musst nichts
host-seitig neu konfigurieren** — wenn `git clone <url>` auf deinem
Host läuft, funktioniert es auch im Container.

**Zwei Mechanismen, parallel — je nachdem welche URL du nutzt:**

### Identity (`user.name` / `user.email`)

Damit `git commit` im Container nicht mit „Author identity unknown"
abbricht, wird bei jedem `monoceros create` / `monoceros apply` die
Host-Identity extrahiert:

1. `git config --global --get user.name` host-seitig
2. Falls leer → existierendes `.monoceros/gitconfig` (von einem
   früheren Lauf) wird benutzt
3. Falls auch leer → Monoceros prompted interaktiv (überspringbar wenn
   non-TTY: nur Warning, Wert bleibt leer)

Resultat landet in `<dev-container>/.monoceros/gitconfig`:

```
[user]
    name = Thorsten Kamann
    email = thorsten@example.com
```

post-create.sh setzt `git config --global include.path /workspaces/<name>/.monoceros/gitconfig`,
sodass die Container-Identity diese Werte erbt.

**Builder mit per-Repo-Identities** (kein `--global`): beim ersten
`create` einmal eingeben, danach persistiert. Spätere Applies fragen
nicht erneut, solange `.monoceros/gitconfig` existiert.

### HTTPS-URLs (`https://github.com/foo/bar.git`)

Bei jedem `monoceros apply` läuft host-seitig `git credential fill`
pro Host (github.com, gitlab.com, deine Gitea-Instanz, …):

- Host-git fragt deinen lokalen Credential-Helper (macOS-Keychain,
  Windows Credential Manager, Linux libsecret, oder was bei dir
  konfiguriert ist) — _das ist OS-Detail, das du nie merkst, weil dein
  Host das schon kennt_.
- Resultat: Username + Token landen in
  `.monoceros/git-credentials` (Mode `0o600`, automatisch
  gitignored via `.monoceros/.gitignore`).
- Container-git ist auf `credential.helper = store --file=…/git-credentials`
  konfiguriert → liest die Datei → klont/pusht ohne Prompt.

Wenn dein Host-Helper für einen Host noch nichts gespeichert hat
(z. B. Erst-Setup eines neuen Hosts), prompted die Host-Helper-UI
während `monoceros apply` — Keychain-Popup, GCM-Window, Terminal-
Prompt, je nach OS und Setup. Nach diesem einmaligen Schritt ist's
gespeichert und Folge-Applies sind silent.

Die Credentials-Datei wird **bei jedem Apply neu geschrieben** —
gestale Tokens (revoked, expired) werden automatisch durch fresh-vom-
Host-gefetchte ersetzt.

### SSH-URLs (`git@github.com:foo/bar.git`, `ssh://…`)

Sobald in `der `repos:`-Liste der Container-yml` mindestens ein Eintrag steht, schreibt
`monoceros create` / `monoceros add-repo` automatisch SSH-Agent-
Forwarding in den Devcontainer:

- **Image-Mode** (`devcontainer.json`): Mount
  `${localEnv:SSH_AUTH_SOCK} → /ssh-agent` plus
  `containerEnv.SSH_AUTH_SOCK = /ssh-agent`
- **Compose-Mode** (`compose.yaml`): Volume
  `${SSH_AUTH_SOCK:-/dev/null}:/ssh-agent` auf dem `workspace`-Service
  plus `environment.SSH_AUTH_SOCK = /ssh-agent`
- In beiden Modi: `GIT_SSH_COMMAND = "ssh -o StrictHostKeyChecking=accept-new"`,
  damit der erste Connect zu einem neuen Git-Host (`github.com`,
  `gitlab.com`, …) nicht interaktiv „Are you sure?" fragt und
  post-create.sh dadurch hängt.

**Builder-Voraussetzung — einmalig pro Host-OS:**

| OS          | Wie ein lokaler SSH-Agent läuft + Key lädt                                  |
| ----------- | --------------------------------------------------------------------------- |
| macOS       | `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` — Agent läuft via Keychain |
| Linux       | `eval $(ssh-agent)` + `ssh-add ~/.ssh/id_ed25519` (z. B. in `~/.zshrc`)     |
| Windows-WSL | wie Linux, oder OpenSSH-Service via `systemctl --user enable ssh-agent`     |

Damit funktionieren SSH-URLs (`git@github.com:…`, `git@gitlab.com:…`,
`git@bitbucket.org:…`, self-hosted Gitea) sowohl beim Klonen
(post-create.sh) als auch bei `git push`/`pull`/`fetch` interaktiv im
Container — der Host-Agent verteilt die Keys.

**HTTPS-Auth ist automatisiert** (siehe Abschnitt oben — `git credential fill`
pro Apply, Datei wird gemountet). Public-HTTPS-Klone funktionieren auch
ohne diesen Mechanismus weil kein Token nötig ist.

**Wenn host-seitig kein SSH-Agent läuft** (und du SSH-URLs nutzt): im
Compose-Mode greift das `:-/dev/null`-Fallback und der Container
startet sauber, aber der Klon im post-create scheitert mit einer
klaren SSH-Error-Message. Im Image-Mode ohne Agent wird devcontainer-
cli den leeren Mount-Source melden. Lösung: SSH-Agent host-seitig
starten und Key laden, dann `monoceros apply` erneut.

**Wenn host-seitig kein Credential-Helper konfiguriert ist** (und du
HTTPS-URLs nutzt): `git credential fill` returns leer, Container-Klon
prompted. Lösung: host-seitig einen Helper konfigurieren (`git config
--global credential.helper osxkeychain` auf macOS, `manager-core` auf
Windows, `store` als universeller Fallback), dann `monoceros apply`
erneut.

## Verwandte Befehle

- `monoceros apply <name>` — Container neu bauen, damit die Klone wirklich passieren
- `monoceros run <name> -- git status` — Git-Operationen im Container
- `monoceros remove-repo <name> <url-or-folder>` — Inverse

## Fail-Modi

- **`Invalid repo URL`** — URL enthält verbotene Zeichen. Häufige Ursachen: versehentlich kopierte Anführungszeichen, Tab im String.
- **`Invalid repo name`** — Folder-Name enthält Slash oder Space. Mit `--as=safer-name` overriden.
- **`Duplicate repo name`** — zwei Repos beanspruchen denselben `projects/<folder>/`-Slot. Mit `--as` einen davon umbenennen.
- **Clone scheitert mit `Permission denied (publickey)`** — SSH-Agent läuft host-seitig nicht oder hat den falschen Key. Host: `ssh-add -l` sollte den Key zeigen; falls leer, `ssh-add ~/.ssh/id_ed25519` (macOS: `--apple-use-keychain` mit dazu). Danach `monoceros apply <name>` erneut.
- **`Could not open a connection to your authentication agent`** im Container — der SSH-Agent-Socket-Mount ist leer (Host hatte keinen Agent zur Compose-Up-Zeit). Host-Agent starten, dann `monoceros apply <name>`.
- **Clone scheitert mit `Repository not found`** — URL falsch oder Repo privat. Auth-Setup prüfen.
