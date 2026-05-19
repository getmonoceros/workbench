# ADR 0003 — Per-Container-Home: persistenter Tool-State unter `container/<name>/home/`

- Status: accepted
- Datum: 2026-05-17

## Kontext

Bis M3-pre hatten wir zwei Versuche, Tool-Auth zwischen Host und
Container zu teilen, beide unbefriedigend:

1. **Bind-Mount des Host-Home-Subpfads.** `claude-code` mountete
   ursprünglich `~/.claude` direkt vom Host in den Container. Bequem,
   aber: jeder Container schreibt rückwärts auf den Host, ein
   `claude /logout` im Container nimmt den Host-Login mit, mehrere
   Container überschreiben sich gegenseitig, Container-spezifische
   Session-Pfade verschmutzen die Host-Projects-Liste. Bricht das
   Versprechen "Container-Isolation als Default" und ist
   nicht-skalierbar bei mehreren Containern.

2. **API-Token-Pipe aus `monoceros-config.yml`.** Funktioniert für
   ACLI (`acli rovodev auth login --token` ist non-interaktiv), aber
   nicht für OAuth-Browser-Flows (Claude-Code-Subscription, twg).
   Macht auch Inhalt wie Skills/Agents/CLAUDE.md nicht persistent.

## Entscheidung

Jeder Container bekommt ein eigenes Home-Verzeichnis sichtbar auf
dem Host unter `<container-dir>/home/`:

```
<MONOCEROS_HOME>/container/<name>/
  .devcontainer/   ← Rezept (apply schreibt bei jedem Lauf neu)
  .monoceros/      ← Monoceros-Buchhaltung (apply schreibt: state.json, git-credentials, gitconfig)
  home/            ← Container-Home (Container schreibt zur Laufzeit, apply lässt es in Ruhe)
  data/            ← Compose-Service-Daten (postgres/, mysql/, redis/ — Bind-Mounts)
  projects/        ← Workspaces (`monoceros add-repo` klont hier rein)
  <name>.code-workspace
  .gitignore       ← schließt /home/, /.monoceros/ und /data/ aus
```

Jedes Monoceros-Feature deklariert in seiner `devcontainer-feature.json`
ein Monoceros-spezifisches Feld:

```json
"x-monoceros": {
  "persistentHomePaths": [".claude"]
}
```

Beim `monoceros apply` liest der Scaffold diese Liste aus, legt
`<container-dir>/home/.claude/` an, und generiert einen Bind-Mount
in der `devcontainer.json`:

```json
"mounts": [
  "source=${localWorkspaceFolder}/home/.claude,target=/home/node/.claude,type=bind"
]
```

Im Compose-Modus läuft derselbe Mount als Volume auf den
`workspace`-Service in `compose.yaml`.

### Compose-Service-Daten unter `<container-dir>/data/`

DB-Daten (Postgres, MySQL, Redis) sind ebenfalls Container-State
und gehören damit unter `<container-dir>/`. Wir nutzen für sie
**keine docker-named-Volumes** mehr, sondern Bind-Mounts:

```yaml
services:
  postgres:
    volumes:
      - ../data/postgres:/var/lib/postgresql
```

Damit erscheinen `data/postgres/`, `data/mysql/` etc. direkt im
Container-Verzeichnis auf der Host-Disk. Konsequenzen:

- `ls`, `du`, `tar`, `cp -r` über `container/<name>/data/`
  funktionieren ohne docker-Volume-Indirektion.
- Das Backup, das `monoceros remove` schreibt, enthält die
  DB-Daten automatisch (es ist eine plain Datei-Kopie).
- Der Service-Eintrag im `SERVICE_CATALOG` deklariert nur den
  Container-seitigen Mount-Pfad (`dataMount`); den Host-Pfad
  generiert der Scaffold deterministisch aus dem Service-Namen.

Linux-Caveat: Postgres läuft als uid 999 im Container. Auf
Docker-Desktop (macOS / Windows) übernimmt das uid-Mapping die
Filesharing-Schicht. Auf einem nackten Linux-Host kann der
pre-created `data/postgres/`-Pfad als Host-User unbeschreibbar
für den Container sein → wir dokumentieren das wenn ein Builder
darüber stolpert.

## Konsequenzen

- **Host bleibt unberührt.** Es gibt keinen Bind-Mount mehr auf
  Host-Home-Subpfade. Was im Container passiert, bleibt im Container.
- **Login überlebt `monoceros apply`.** Re-Apply schreibt nur das
  Scaffold (`.devcontainer/`, `.monoceros/`, Scaffold-Dateien),
  `home/` wird nicht angefasst. Container-Rebuild → Mount fasst den
  vorhandenen Login wieder auf.
- **Pro Container ein eigener Login.** Sandbox und Klient-X können
  unterschiedliche Atlassian-Mandanten / Anthropic-Accounts nutzen,
  ohne sich zu beißen.
- **Skills/Agents/CLAUDE.md sind nicht automatisch zwischen Containern
  geteilt.** Builder kopiert sie explizit zwischen
  `container/<a>/home/.claude/skills/` und `container/<b>/...`, oder
  setzt selbst Symlinks. Bewusst — Magic-Sharing würde wieder
  Cross-Contamination einführen, manuelles Kopieren ist explizit
  und vorhersagbar.
- **Secrets liegen auf der Host-Disk** unter
  `container/<name>/home/<tool>/<credentials-file>`. Die `.gitignore`
  am Container-Root schließt `/home/` aus, damit ein versehentliches
  `git init` im Container-Root nichts committet. Builder muss sich
  trotzdem bewusst sein, dass z.B. ein `tar` über den Container-Dir
  Secrets mit einsammelt.
- **Auto-Login für Tools mit non-interaktivem Login-Pfad.** Wenn die
  Container-yml (oder `monoceros-config.yml → defaults.features`)
  z.B. für das `atlassian`-Feature `instance`, `email` und `apiToken`
  setzt, drop't das Feature-`install.sh` ein Skript unter
  `/usr/local/share/monoceros/post-create.d/<feature>.sh` ab.
  Scaffold's `post-create.sh` ruft alle dort liegenden Skripte beim
  Container-Start auf. Idempotent: wenn die Auth-Datei unter
  `home/.config/acli/...` schon valide ist, wird der Login
  übersprungen.
- **Verzeichnis-Ownership.** Scaffold erstellt die Subpaths in
  `home/` vorab, sodass Docker nicht beim Container-Start eine
  root-owned Mount-Source anlegt. Auf macOS handelt Docker Desktop
  das UID-Mapping transparent; auf Linux muss die Host-UID mit der
  Container-`node`-UID (1000) übereinstimmen, sonst gibt es
  Permission-Probleme im Container — gleiches Caveat wie bei jedem
  anderen Bind-Mount.

## Nicht-Ziele dieser ADR

- **Shared Skills zwischen Host und Containern.** Wer das will, macht
  bewusst einen Symlink `container/<name>/home/.claude/skills →
~/.claude/skills`. Monoceros bietet das nicht als Default an.
- **Multi-Account-Git.** Heute nutzt jeder Container die
  Host-Credential-Helper-Daten via `git credential fill`. Pro Remote
  unterschiedliche Tokens braucht eine eigene Mechanik; offen
  notiert im Backlog.
- **`monoceros duplicate <a> <b>`.** Idee aus dem Designgespräch zu
  diesem Modell: Container-Dir klonen, Projects/.devcontainer
  resetten, Login bleibt erhalten. Vorgemerkt im Backlog.
