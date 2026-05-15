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
monoceros add-repo <url> [--name=<n>] [--branch=<b>] [--yes] [--project=<path>]
```

## Optionen

| Flag               | Bedeutung                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `--name=<n>`       | Override des Folder-Namens unter `projects/`. Default: aus URL abgeleitet (`bar.git` → `bar`). |
| `--branch=<b>`     | Spezifischen Branch klonen. Default: Repo-Default-Branch.                                      |
| `--yes` / `-y`     | Confirm-Prompt überspringen                                                                    |
| `--project=<path>` | Solution-Root explizit                                                                         |

## Mechanik

1. **stack.json** bekommt einen Eintrag in `repos: Array<{ url, name, branch? }>`. Reihenfolge bleibt erhalten — wenn Klone aufeinander aufbauen, in der gewünschten Reihenfolge hinzufügen.
2. **`.devcontainer/post-create.sh`** bekommt am Ende einen Idempotenz-Block pro Repo:
   ```bash
   if [ ! -d "projects/bar" ]; then
     echo "→ Cloning bar from https://github.com/foo/bar.git…"
     git clone "https://github.com/foo/bar.git" "projects/bar"
   else
     echo "→ projects/bar already exists, skipping clone"
   fi
   ```
   Bei `--branch develop` kommt `--branch develop` ans `git clone` dran.
3. **`<solution>.code-workspace`** bekommt einen zusätzlichen Folder-Root für `projects/<name>/`. Beim Öffnen in VS Code erscheint das Repo als eigene Spalte im Explorer.
4. Beim nächsten `monoceros apply` läuft `git clone`. Dafür braucht der Container `git` im PATH — kommt im Default-Runtime-Image mit.

## Idempotenz

- **Selbe URL, selber Name, selber Branch** → no-op
- **Selber Name, andere URL** → Validierungsfehler (`Duplicate repo name`). `--name` zur Disambiguierung nutzen.
- **Wenn der Folder unter `projects/<name>/` schon existiert** → der Clone-Step skippt; deine lokalen Änderungen bleiben unangetastet. Auch nach `monoceros apply` mit Container-Rebuild — der Bind-Mount des Workspace-Folders überlebt das.

## Name-Derivation

Aus URL wird der Folder-Name automatisch abgeleitet (Last-Segment, `.git` entfernt):

| URL                                   | abgeleiteter Name |
| ------------------------------------- | ----------------- |
| `https://github.com/foo/bar.git`      | `bar`             |
| `https://github.com/foo/bar`          | `bar`             |
| `git@github.com:foo/bar.git`          | `bar`             |
| `ssh://git@github.com:22/foo/bar.git` | `bar`             |

Override via `--name=<n>` wenn der Default-Name ungünstig ist
(`docs.git` → `docs` ist klar, aber zwei Repos namens `cli` aus
unterschiedlichen Orgs kollidieren).

## Beispiele

Einzelnes öffentliches Repo:

```sh
monoceros add-repo https://github.com/foo/bar.git
monoceros apply
ls projects/bar/
```

Mit Branch und Custom-Name:

```sh
monoceros add-repo --name=ui --branch=develop https://github.com/foo/bar.git
monoceros apply
```

Mehrere Repos:

```sh
monoceros add-repo https://github.com/myorg/api.git
monoceros add-repo https://github.com/myorg/web.git
monoceros add-repo --name=shared https://github.com/myorg/types.git
monoceros apply
```

Workspace-Layout danach:

```
sandbox/
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

Sobald in `stack.json.repos` mindestens ein Eintrag steht, wird der
Dev-Container automatisch so vorbereitet, dass git im Container
dieselben Auth-Wege nutzen kann wie auf dem Host. **Du musst nichts
host-seitig neu konfigurieren** — wenn `git clone <url>` auf deinem
Host läuft, funktioniert es auch im Container.

**Zwei Mechanismen, parallel — je nachdem welche URL du nutzt:**

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

Sobald in `stack.json.repos` mindestens ein Eintrag steht, schreibt
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

- `monoceros apply` — Container neu bauen, damit die Klone wirklich passieren
- `monoceros run -- git status` — Git-Operationen im Container (cwd via `monoceros shell` + `cd projects/<name>`)

## Fail-Modi

- **`Invalid repo URL`** — URL enthält verbotene Zeichen. Häufige Ursachen: versehentlich kopierte Anführungszeichen, Tab im String.
- **`Invalid repo name`** — Name enthält Slash oder Space. Mit `--name=safer-name` overriden.
- **`Duplicate repo name`** — zwei Repos beanspruchen denselben `projects/<name>/`-Slot. Mit `--name` einen davon umbenennen.
- **Clone scheitert mit `Permission denied (publickey)`** — SSH-Agent läuft host-seitig nicht oder hat den falschen Key. Host: `ssh-add -l` sollte den Key zeigen; falls leer, `ssh-add ~/.ssh/id_ed25519` (macOS: `--apple-use-keychain` mit dazu). Danach `monoceros apply` erneut.
- **`Could not open a connection to your authentication agent`** im Container — der SSH-Agent-Socket-Mount ist leer (Host hatte keinen Agent zur Compose-Up-Zeit). Compose fällt auf `/dev/null` zurück; ssh weiß damit nichts anzufangen. Host-Agent starten, dann `monoceros apply`.
- **Clone scheitert mit `Repository not found`** — URL falsch oder Repo privat. Auth-Setup prüfen.
