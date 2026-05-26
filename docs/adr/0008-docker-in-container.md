# ADR 0008 — Docker-im-Container als opt-in Feature

- Status: proposed
- Datum: 2026-05-26

## Kontext

Manche Projekte arbeiten zur Entwicklungszeit mit Docker — der typische
Fall ist ein `npm run dev` (oder ein `make dev` etc.), das im
Hintergrund `docker compose up --build` oder `docker build` aufruft und
ein App-Image baut bzw. einen App-Container startet. Solange der
Builder direkt auf seinem Host arbeitet, ist das unauffällig: der
Docker-Daemon des Hosts macht das Bauen.

In Monoceros ist das nicht so. Der Builder arbeitet **im**
Monoceros-Container, der selbst ein Docker-Container ist. Im
Default-Setup gibt es im Monoceros-Container weder einen Docker-
Daemon noch einen `docker`-CLI noch einen Zugriff auf den Host-Socket.
Ein `docker build` im Container schlägt fehl. Für den Anteil der
Builder, deren Dev-Loop Docker braucht, ist Monoceros damit heute
nicht nutzbar.

Drei Beobachtungen zum Kontext, bevor wir entscheiden:

1. **Der häufigste „lokaler Dev mit Docker"-Fall ist bereits gelöst.**
   Postgres, Redis, MySQL, RabbitMQ etc. via `docker-compose.yml`
   neben der App ist Mainstream — aber genau das deckt Monoceros mit
   `services:` in der Container-yml bereits ab, sogar sauberer (yml-
   Schema, Backups, atomares `remove`). Der unter dem Stichwort
   „Docker im Dev" wirklich offene Fall ist der engere: Builder will
   im Dev-Loop **selbst Images bauen oder Container starten**.
2. **Container-Isolation ist eine zentrale Monoceros-Wette** (siehe
   konzept.md, „Container-Isolation als Default"). Jede Mechanik, die
   dem Container Zugriff auf Docker gibt, untergräbt diese Wette,
   weil Docker-Daemon-Zugriff in der Praxis Host-Root-Äquivalenz ist.
3. **Devcontainers haben für das Problem zwei etablierte Lösungen.**
   `ghcr.io/devcontainers/features/docker-outside-of-docker` (DooD —
   Host-Socket-Mount) und `ghcr.io/devcontainers/features/docker-in-docker`
   (DinD — Daemon im Container, privileged). Beide sind ausgereift,
   wir müssen die Mechanik nicht selbst erfinden — die Frage ist nur
   welche, und wie wir sie in Monoceros einbetten.

## Entscheidung

**Wir liefern Docker-Support als opt-in Feature
`ghcr.io/getmonoceros/monoceros-features/docker-in-docker:1`. Wir
wählen DinD (nicht DooD). Wir lenken in der Doku aktiv zuerst auf
`services:` um, bevor wir die Feature-Konsequenzen erklären.**

### Warum DinD und nicht DooD

Beide brechen die Container-Isolation, das ist beiden gemein und
unausweichlich — sobald der Dev-Loop Docker-Operationen ausführen
darf, gibt es einen Pfad zur Host-Kompromittierung. Die Frage ist
welche der beiden Brüche die kleineren operativen Folgekosten hat.

| Konsequenz                       | DooD (Host-Socket)                   | DinD (Daemon im Container)             |
| -------------------------------- | ------------------------------------ | -------------------------------------- |
| Lifecycle: `remove` räumt sauber | nein, Sub-Container sind Sibs        | ja, Sub-Container sind Kinder          |
| Volume-Mount `$(pwd):/app`       | kaputt (Host-Pfad existiert nicht)   | funktioniert ohne Workaround           |
| Image-Cache geteilt mit Host     | ja                                   | nein, pro Container eigener            |
| Build-Performance                | nativ                                | spürbar langsamer (overlay-on-overlay) |
| Traefik-Integration (ADR 0007)   | komplex (Sub-Container im Proxy-Net) | trivial (geht durch Parent)            |
| Sicherheits-Bruch                | Socket → Host-Root                   | privileged → Host-Root                 |

DooD ist schneller und billiger an Disk-Space, DinD ist sauberer im
Modell. Die zwei Punkte, die den Ausschlag geben:

- **Zombie-Container nach `remove`** (DooD): Sub-Container sind
  Geschwister, nicht Kinder — `monoceros remove` weiß nichts von
  ihnen, sie bleiben übrig. Wir haben das genaue Problem in M4
  Task 9 (Linux-Walkthrough) als ernsten UX-Fund bestätigt, als ein
  Image-Mode-Container nach `remove` einen Zombie hinterließ; der
  vierte Container-Filter über `label=devcontainer.local_folder=…`
  ist dafür da, dass `remove` _atomar_ ist. DooD würde diesen
  Pfad bewusst wieder aufmachen.
- **Volume-Mount-Footgun** (DooD): `docker-compose.yml` mit
  `volumes: [.:/app]` ist Standard. Im Monoceros-Container expandiert
  `.` zu `/workspaces/<name>`, ein Pfad, den der Host nicht kennt.
  Der Host-Daemon mountet einen leeren Ordner, der Dev-Server
  startet ohne Code. Das ist nicht abstrakt, das ist der erste
  Bug-Report, den wir kriegen würden.

DinD kostet uns Geschwindigkeit und Disk-Space, gibt uns aber atomares
Lifecycle und funktionierende Mounts ohne Anpassung am Projekt-
Compose. Das wiegt in der Gesamtbilanz schwerer.

### Doku-Strategie als aktiver Teil der Entscheidung

Die Sicherheits-Implikation darf nicht zwischen Boilerplate-Warnungen
verschwinden. Drei Schichten:

1. **`x-monoceros.usageNotes` im Feature-Manifest** — wird beim
   `init --with=docker-in-docker` als Kommentar in die generierte yml
   gespiegelt (dieser Mechanismus existiert seit M4). Inhalt: Reflex-
   Check ob `services:` reicht, plus ein Satz zur Privileged-
   Konsequenz.
2. **`docs/features/docker-in-docker.md`** — strukturierte
   Detail-Seite mit dem Aufbau: erst die Frage „brauchst du das?" mit
   `services:`-Beispiel als Alternative; dann die Konsequenzen
   (privileged, Performance, Disk); dann erst die technische
   Verwendung.
3. **Manifest-Hint beim `monoceros list-components`** — das Feature
   bekommt in der Komponenten-Liste einen sichtbaren Marker (z. B.
   „⚠ privileged"), damit es nicht versehentlich wie ein normales
   Tool wirkt.

### Scope des Features

- Installer wrapper-en den Upstream-`ghcr.io/devcontainers/features/docker-in-docker`
  oder dessen Install-Skript, statt eigene Daemon-Setup-Mechanik zu
  pflegen.
- Option `version: 'latest' | <docker-version>` analog zu anderen
  Features (Default `latest`).
- Option `installDockerComposePlugin: boolean` (Default `true`),
  damit `docker compose` direkt funktioniert.
- State unter `home/.docker/` via `x-monoceros.persistentHomePaths`,
  damit Login-State (Registry-Auth) über `apply` hinweg überlebt.
- Container-yml-seitig wird der Container automatisch als
  `privileged: true` markiert, wenn dieses Feature gesetzt ist. Das
  passiert im Scaffold, nicht im Builder-yml — Builder soll
  `privileged: true` nicht versehentlich anderswo setzen können.

### Networking mit Traefik

Sub-Container leben im inneren Docker des Monoceros-Containers, sind
vom Host und vom `monoceros-proxy`-Network unsichtbar. Das ist kein
Problem: Traefik routet bereits heute auf den Monoceros-Container, der
seinerseits intern an den Sub-Container weiterleitet — der Builder
deklariert seinen Dev-Server-Port wie üblich in `routing.ports:`, und
sorgt _im Container_ dafür, dass der Sub-Container auf diesem Port
lauscht (z. B. via `docker run -p 3000:3000` im inneren Daemon, oder
Compose-Port-Mapping). Aus Traefik-Sicht ändert sich nichts.

## Bewusst nicht entschieden / aufgeschoben

### DooD als zweite Option ausliefern

Naheliegender Reflex: beide Features anbieten und den Builder wählen
lassen. Verworfen, weil die DooD-Konsequenzen (Zombies, kaputte
Volume-Mounts) genau die Sorte Footgun ist, gegen die Monoceros sich
ansonsten stellt. Wenn ein Builder DooD wirklich braucht, kann er
heute auch über `add-from-url` einen rohen Devcontainer-Feature-Ref
einbauen — der Pfad existiert. Eine kuratierte DooD-Variante mit
unserem Namen drauf signalisiert dagegen, dass wir das empfehlen.
Tun wir nicht.

### Rootless Docker / Podman im Container

Theoretisch interessant — Rootless-Docker oder Podman im Container
würde den Privileged-Cost vermeiden. Praktisch heute nicht ausgereift
genug: Podman-in-Docker stößt regelmäßig auf User-Namespace-Konflikte,
Rootless-Docker hat Performance-Probleme mit overlayfs auf overlayfs.
Re-Evaluation, wenn die Upstream-Situation sich beruhigt.

### Auto-Detection bestehender `Dockerfile`/`docker-compose.yml` im Repo

Reizvoll: `monoceros init --with-repo=…` sieht ein `Dockerfile` und
schlägt das Feature vor. Verworfen für die erste Iteration — würde
suggerieren, dass jeder Dev-Loop mit Docker-File auch DinD braucht,
was nicht stimmt (siehe `services:`-Pfad). Erst Feature stabilisieren,
dann ggf. Detection-Heuristik.

## Folgen

- **Neues Feature** unter `images/features/docker-in-docker/` mit
  `devcontainer-feature.json` + `install.sh` (wrapper über das
  Upstream-DinD-Feature), `x-monoceros.usageNotes`, `x-monoceros.optionHints`,
  `x-monoceros.persistentHomePaths: [.docker]`.
- **Scaffold-Erweiterung** — wenn das Feature in `features:` der yml
  enthalten ist, fügt der Scaffold `privileged: true` zur generierten
  devcontainer.json bzw. dem entsprechenden Service-Block im Compose
  hinzu. Builder kann das nicht selbst setzen.
- **Komponente** unter `templates/components/docker-in-docker.yaml`
  mit `displayName` + `description` + `category: tooling` plus einem
  Warnung-Marker, damit `init --with=docker-in-docker` und
  `list-components` das Feature konsistent anzeigen.
- **Doku** — `docs/features/docker-in-docker.md` (neu, Schwerpunkt
  „brauchst du das?"-Reflex-Check) und ein Verweis aus
  `docs/ai-tools.md` bzw. dem Komponenten-Katalog.
- **Test-Plan** (M5 Task 4 Rewrite) — eine Stage für „init
  `--with=node,docker-in-docker` → apply → `docker build` im Container
  → `docker run` im Container → `monoceros remove` räumt alles weg,
  kein Zombie im Host-`docker ps`".
- **GHCR-Release** — über die bestehende `release-features.yml`
  Pipeline (M4 Task 3), kein Workflow-Eingriff nötig.

## Status-Bezug

Die Umsetzung gehört nicht in M5 (der Test-Plan + AI-Library-
Erweiterung sind dort schon viel) — sondern als eigenes kleines Item
nach M5, parallel oder im Anschluss an „AI-Tool-Library erweitern".
Eintrag im Backlog unter „Vorgemerkt für später (jenseits M5)".
