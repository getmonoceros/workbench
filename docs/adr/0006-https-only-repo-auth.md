# ADR 0006 — HTTPS-only Repo-Auth

- Status: accepted
- Datum: 2026-05-23

## Kontext

Monoceros klont Git-Repos in `projects/<path>/` während der
`post-create`-Phase des Dev-Containers. Konfiguriert werden die
Repos via `init --with-repo=<url>` oder `monoceros add-repo <name>
<url>` und persistiert in der Container-yml unter `repos:`.

Beim End-to-End-Walkthrough für M4 Task 9 (auf Linux nativ und macOS
Docker Desktop) trat eine Reihe von Reibungspunkten auf, die alle
auf einen gemeinsamen Punkt zurückgehen: **SSH-Style-URLs
(`git@github.com:…`, `ssh://…`) erzwingen Host-OS-spezifische Auth-
Mechaniken, die der „deklarativ + reproduzierbar"-Versprechen aus
[`docs/concept.md`](../concept.md) widersprechen.**

Konkret beobachtet:

- **macOS Docker Desktop**: Der host-seitige `SSH_AUTH_SOCK` lebt
  unter `/private/tmp/com.apple.launchd.<id>/Listeners`, einem launchd-
  managed Pfad der nicht in Docker Desktops File-Sharing-Liste
  steht. Direkter Bind-Mount des Sockets scheitert mit
  `bind source path does not exist`. Workaround: Docker Desktop's
  bundled SSH-Agent-Proxy (`/run/host-services/ssh-auth.sock`) —
  aber der ist nur verfügbar wenn der Builder "Use SSH agent" in
  Docker Desktop → Settings → Resources togglet. Manueller GUI-
  Konfig-Schritt verletzt die deklarative Annahme.

- **Windows Docker Desktop**: Der Windows SSH-Agent liefert einen
  Named Pipe (`\\.\pipe\openssh-ssh-agent`), keinen Unix-Socket.
  Bind-Mount im Linux-Container-Modus geht direkt nicht. Auch hier
  gibt's einen Docker-Desktop-Toggle als Workaround, derselbe
  manuelle Setup-Schritt.

- **Linux native**: Funktioniert ohne Setup — `SSH_AUTH_SOCK` ist
  direkt mountbar, kein VM-Sandboxing. Asymmetrie zwischen den drei
  Plattformen.

- **Multi-Identity (mehrere GitHub-Accounts pro Builder)**: Verlangt
  entweder `~/.ssh/config`-Host-Aliases mit URL-Umschreibung
  (`git@github-work:org/repo.git` statt der echten GitHub-URL) oder
  per-Repo `core.sshCommand`-Pinning. Beides müsste Monoceros
  sauber wrappen — der Bauplan wäre ein neues `sshKey:`-Schema-Feld
  auf drei Ebenen, mounted Key-Files pro unique Key, Pre-Flight-
  Checks (Key vorhanden, nicht passphrase-encrypted, korrekte
  Permissions), Konsistenz-Constraint zwischen `sshKey` und
  `user.email` … einige Hundert Zeilen Code plus Test-Surface plus
  Doku.

- **Passphrase-encrypted Keys**: Im non-interaktiven post-create-
  Kontext gibt's keinen sauberen Weg, die Passphrase einzuspielen.
  Würde explizit als „nicht supported" dokumentiert werden müssen.

Parallel dazu gibt es bereits einen funktionierenden HTTPS-Auth-Pfad
(M1, Commit `3aaaf72`): `apply` ruft host-seitig `git credential
fill protocol=https host=<host>` für jeden unique HTTPS-Host und
schreibt die Antworten nach
`<container-dir>/.monoceros/git-credentials`. Im Container
konfiguriert post-create.sh `git config --global credential.helper
"store --file=…"` mit demselben Pfad. Beim Clone findet git die
Credentials, authentifiziert, klont. Das funktioniert
**plattformübergreifend ohne Docker-Desktop-Settings**, weil
Bind-Mounts unter dem Container-Root standardmäßig erreichbar sind.

Es gibt im realistischen Builder-Umfeld 2026 quasi keinen Git-Host,
der ausschließlich SSH supportet: GitHub.com, GitLab.com,
Bitbucket.org, selbstgehostetes Gitea, selbstgehostetes GitLab,
Bitbucket Server — alle unterstützen HTTPS first-class mit Personal-
Access-Tokens, Deploy-Tokens oder App-Passwords als Auth. Der
host-side Credential-Helper (`osxkeychain`, `libsecret`, `wincred`,
oder `gh auth setup-git` für GitHub) liefert für jeden dieser Hosts
die richtige Antwort.

## Entscheidung

**Monoceros unterstützt Repo-URLs ausschließlich im HTTPS-Format.**
SSH-style URLs (`git@host:…`, `ssh://…`, `git://…`) werden auf
Schema-Ebene abgelehnt (`config/schema.ts` REPO_URL_RE verlangt
`^https://`).

Begründung — Kompromiss zwischen Coverage und Komplexität:

- **Was wir aufgeben**: SSH-Style-URLs aus dem Clone-Dialog von
  GitHub/GitLab/etc. — Builder muss bewusst die HTTPS-URL kopieren,
  nicht die SSH-URL. Edge-Case-Hosts, die nur SSH supporten
  (selbstgehostete Gitea ohne HTTP-Frontend o.ä.), werden nicht
  abgedeckt. Builder-Muskelgedächtnis das auf SSH-URLs gepolt ist
  muss umlernen.

- **Was wir gewinnen**: Konsistentes Verhalten zwischen Linux, macOS
  Docker Desktop, Windows Docker Desktop. Keine Host-GUI-
  Konfigurationsschritte. Keine schema-Erweiterung für `sshKey`-
  Felder auf drei Ebenen. Keine Passphrase-Edge-Cases. Keine
  Multi-Identity-Wiring per `core.sshCommand`. Keine SSH-Agent-
  Forwarding-Plattform-Spezifik. Per-Repo-`git.user`-Identität
  funktioniert weiterhin (Task 8) — Multi-Identity-Use-Cases bleiben
  abgedeckt, weil Commit-Identität von SSH-Key-Wahl unabhängig ist.

Konkret im Schema:

```ts
// REPO_URL_RE: must start with https://
const REPO_URL_RE = /^https:\/\/[A-Za-z0-9@:/+_~.#=&?-]+$/;
```

Fehlermeldung bei Verstoß:

> Invalid repo URL. Only HTTPS URLs are supported (`https://...`).
> SSH-style URLs (`git@host:...`, `ssh://...`) are not in scope —
> see ADR 0006.

## Folgen

- **`packages/cli/src/create/scaffold.ts`**: SSH-Agent-Forwarding-
  Infrastruktur (`hasSshRepo`, `sshAgentMountSource`,
  `buildRepoAuthMounts`, `buildRepoAuthEnv`, `SSH_AGENT_TARGET`,
  `GIT_SSH_COMMAND`) komplett entfernt. Auch der Compose-yaml-
  Generator setzt kein `SSH_AUTH_SOCK`/`GIT_SSH_COMMAND` mehr.
  ContainerEnv und `mounts` im devcontainer.json sind frei von
  SSH-Spezifika.

- **Defense-in-Depth in `devcontainer/credentials.ts`**: Die
  `uniqueHttpsHosts`-Funktion filtert weiterhin non-HTTPS-URLs
  defensiv heraus. Das schadet nicht — Schema fängt SSH-URLs vor
  dem Runtime-Layer ab, aber der Filter ist Belt-and-Suspenders für
  fehlerhafte Test-Fixtures oder zukünftige Caller.

- **Doku** (`README.md`, `docs/commands/add-repo.md`): explizite
  Aussage „Repo URLs müssen HTTPS sein, SSH ist nicht in Scope". Pro
  Major-Provider ein Hinweis wo die HTTPS-URL zu finden ist (im
  GitHub-Clone-Dialog: HTTPS-Tab).

- **Provider-Deklaration** (Schema-Feld `repos[].provider`,
  `RepoEntrySchema`): kanonische Hosts (`github.com`, `gitlab.com`,
  `bitbucket.org`) werden auto-erkannt. Alle anderen HTTPS-Hosts
  (selbstgehostetes GitLab unter `git.firma.de`, Gitea/Forgejo unter
  `code.acme.com`, Bitbucket Data Center …) verlangen einen expliziten
  `provider:`-Eintrag, sonst bricht der Apply-Pre-Flight mit einer
  klaren Fehlermeldung ab. Hintergrund: aus dem Hostname allein lässt
  sich kein verlässlicher Provider-Schluss ziehen — eine frühere
  Heuristik (`startsWith('gitlab.')`) hat genau die selbst gehosteten
  Fälle übersehen, die am häufigsten den Provider-Hinweis brauchen.
  Unterstützte Provider-Werte: `github` (Cloud + Enterprise),
  `gitlab` (Cloud + Self-Hosted), `bitbucket` (Cloud + Data Center),
  `gitea` (deckt auch Forgejo ab — gleiche API + UI). `monoceros
add-repo` setzt das Feld via `--provider=…`-Flag; `monoceros init
--with-repo` akzeptiert nur kanonische Hosts, weil Provider-Eingabe
  via CLI-Flag in `init` selten genug ist, um die Syntax nicht damit
  zu belasten.

- **Backlog M5 Task 4 (Test-Plan-Rewrite)**: Die in M4 Task 9
  hinzugefügte „SSH-Repo-
  Strecke explizit testen" wird gestrichen. Stattdessen: „HTTPS-Repo
  - Clone + Commit + Push" als Pflichtfall pro Plattform, plus
    „SSH-URL in der yml → klare Fehlermeldung" als Validations-Test.

## Re-Evaluation falls echte Builder-Nachfrage

Wenn ein Builder bei Monoceros aufschlägt und sagt „mein primärer
Workflow geht über SSH-Auth und ich kann/will nicht auf HTTPS
umsteigen", liegt der Design-Entwurf aus dem Diskussions-Thread
(Chat-Verlauf 2026-05-23) auf dem Tisch:

- `sshKey:`-Feld in `defaults.git`, Container-`git`, `repos[].git`
  mit Fallback-Hierarchie
- Pre-Flight-Check auf Key-Existenz + Permissions + nicht-encrypted
- Bind-Mount unter `~/.ssh/<key>` pro unique Key
- Per-Repo `core.sshCommand "ssh -i ~/.ssh/<key> -o IdentitiesOnly=yes"`
  im post-create.sh nach Clone und Persist
- Konsistenz-Doku: `sshKey` + `user.email` müssen dieselbe GitHub-
  Identität repräsentieren

Geschätzter Aufwand: ~250–300 LOC + vergleichbar viel Test-Surface,
plus eigene ADR (0006a o.ä.) die die Trade-offs neu bewertet.
Heute nicht relevant — würde bei realer Nachfrage als eigenes
Backlog-Item aufgemacht.
