# Docker auf Linux einrichten

> Draft, 2026-05-24. Ergänzt + verfeinert sich im Laufe von M5.
> Ziel: alles was zum Docker-Setup für Monoceros relevant ist an
> einer Stelle, statt verstreut in install.sh-Error-Boxen und
> Backlog-Notizen.

Diese Seite ist für Builder die **lokal auf einem Linux-Desktop**
arbeiten (z.B. Ubuntu in einer VM, oder native Linux-Workstation).

Für macOS und Windows ist Docker Desktop der dokumentierte Pfad — da
gibt es das hier beschriebene Gruppen-Drama nicht, weil Docker Desktop
seine eigene Access-Mechanik mitbringt.

---

## TL;DR — drei Befehle und fertig

```sh
sudo -v
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Das war's. **Kein `newgrp docker`**, kein Logout, kein Reboot.
Monoceros' CLI erkennt den „User ist in `/etc/group`, aber meine
Shell weiß nichts davon"-Zustand und fängt's intern ab (siehe
[„Auto-Recovery in Monoceros"](#auto-recovery-in-monoceros) unten).

Danach `curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | bash`
und du bist durch.

---

## Was die drei Befehle bedeuten

### 1. `sudo -v`

Cached das sudo-Passwort für die nächsten ~15 Minuten. Wirkt
trivial, ist aber wichtig: ohne dieses Pre-Caching fragt sudo
**später** im Block nach dem Passwort, und in einem Paste-Block
würde der nachfolgende Befehl als „Tippeingabe für den Passwort-
Prompt" interpretiert werden — er ginge silent unter.

Wenn du die Befehle einzeln tippst und brav auf jeden Prompt
wartest, ist `sudo -v` redundant. In der Praxis kopiert man den
Block, deshalb ist's drin.

### 2. `curl -fsSL https://get.docker.com | sudo sh`

Installiert **Docker Engine im rootful Modus**. Das ist der von
Monoceros unterstützte Pfad. Der Docker-Daemon läuft als root,
managed von systemd, Socket unter `/run/docker.sock`.

Am Ende druckt das Skript einen Hinweis-Block:

```
To run Docker as a non-privileged user, consider setting up
the Docker daemon in rootless mode for your user:

    dockerd-rootless-setuptool.sh install
```

**Den Block ignorieren.** Das ist eine alternative
Installations-Variante (rootless mode), kein Schritt der noch zu
tun ist. Monoceros unterstützt rootless aktuell nicht (siehe
[„Rootless Docker — nicht unterstützt"](#rootless-docker--nicht-unterstützt)).

### 3. `sudo usermod -aG docker $USER`

Fügt deinen Benutzer in die `docker`-Gruppe ein. Der Daemon-Socket
ist root-owned (Mode `0660`, Eigentümer `root:docker`); ohne
Gruppen-Mitgliedschaft müsstest du jeden `docker`-Aufruf mit
`sudo` machen — UX-Tod.

**Sicherheits-Kontext:** Wer in der docker-Gruppe ist, ist auf
einer normalen Linux-Maschine **effektiv root**. Man kann einen
Container mit `--privileged -v /:/host` starten und damit das
gesamte Host-System modifizieren.

Auf einer **Single-User-Dev-VM** (dein Setup) ist das kein neues
Sicherheits-Loch — du hast eh schon `sudo`-Rechte. Die docker-
Gruppe ist nur ein bequemerer Weg dahin, kein zusätzlicher.

Auf einem **Multi-User-Server** wäre die Gruppe relevant: ein
unprivilegierter Nutzer, dem du `docker` gibst, ist plötzlich
root-äquivalent. Andere Bedrohungslage, anderes Setup — nicht
Monoceros' Anwendungsfall.

---

## Die GNOME-Session-Falle

Nach `sudo usermod -aG docker $USER` steht dein User in
`/etc/group` — sofort, persistent. Was du tun **kannst**:

```sh
getent group docker
# → docker:x:984:parallels   ✓ du bist drin
```

Was du **nicht** kannst: `docker info` ausführen. Ergebnis:

```
permission denied while trying to connect to the docker API
at unix:///var/run/docker.sock
```

**Warum?** Linux liest Gruppen-Memberships beim **Login** ein
(über PAM) und legt sie als unveränderbare Liste in den Prozess-
Credentials jedes neu gestarteten Prozesses ab. Es gibt **keinen
Kernel-Syscall**, der einem laufenden Prozess von außen neue
Gruppen-Memberships hinzufügen kann — das ist Absicht (sonst
könnte ein böser Prozess sich selbst Privilegien geben).

Deine GNOME-Desktop-Session wurde gestartet **bevor** du `usermod`
ausgeführt hast. Sie hat eine eingefrorene Gruppen-Liste **ohne**
docker. Jeder Prozess, der von dieser Session abstammt — jedes
Terminal-Fenster, jeder Editor, jeder Tab — erbt diese veraltete
Liste.

### Was tatsächlich funktioniert

Drei Wege, um Docker-Zugriff in deine Shell zu kriegen, ohne neu
zu booten:

| Befehl                 | Wirkung                                                | Geltungsdauer        |
| ---------------------- | ------------------------------------------------------ | -------------------- |
| `newgrp docker`        | öffnet Sub-Shell mit docker-Gruppe primär gesetzt      | nur diese Sub-Shell  |
| `sg docker -c "<cmd>"` | führt EINEN Befehl mit docker-Gruppe aus               | nur dieser Befehl    |
| `su - $USER`           | startet frische PAM-Login-Session, fragt nach Passwort | nur dieser Sub-Shell |

**Permanent für alle zukünftigen Terminals**: full GNOME-Session-
Logout (nicht „Terminal schließen", sondern „aus der grafischen
Session ausloggen"), dann wieder einloggen. Beim Login liest PAM
`/etc/group` frisch ein.

Reboot tut's auch — ist aber overkill (Logout reicht).

---

## Auto-Recovery in Monoceros

Hier kommt der Trick: **Monoceros wartet nicht darauf, dass du
das Gruppen-Drama von Hand erledigst.**

Beim Start jedes `monoceros …`-Aufrufs läuft ein Bootstrap
(`packages/cli/src/devcontainer/docker-group-bootstrap.ts`):

1. Probe: `docker info` — funktioniert?
2. Wenn ja: nichts zu tun, weiter wie normal.
3. Wenn nein **und** der User in `/etc/group`s docker-Zeile steht
   (= `usermod` ist durchgelaufen, nur die Shell weiß's nicht):
   monoceros re-exec'ed sich selbst via `sg docker -c "node …"`.
   `sg` (shadow-utils) liest `/etc/group` frisch und führt den
   Befehl mit aktiver docker-Gruppe aus.
4. Wenn der User **nicht** in `/etc/group` steht: klare Fehler-
   meldung mit `usermod`-Hinweis.

Aus deiner Sicht: du tippst `monoceros apply hello`, es funktioniert.
Bash sieht **einen** Befehl, History bekommt **eine** Zeile,
↑-Pfeil funktioniert. Der `sg`-Sub-Prozess lebt nur so lange wie
die monoceros-Ausführung, dann ist er weg.

Overhead: zwei `spawnSync`-Aufrufe (`docker --version` +
`docker info`) pro monoceros-Aufruf, zusammen ~50 ms.

Nach dem nächsten natürlichen GNOME-Logout (Feierabend, Reboot,
Update) propagiert sich die Gruppe ohnehin: `docker info` in der
Probe klappt sofort, der `sg`-Re-Exec schaltet sich automatisch
ab.

**Dasselbe in install.sh:** wenn du install.sh ausführst während
deine Shell noch in der „usermod-aber-nicht-geladen"-Falle steckt,
re-execed sich install.sh ebenfalls via `sg docker`. Das curl-bash-
Setup ist tricky (stdin ist schon konsumiert), wir re-downloaden
in einen tmpfile und exec'en `sg docker -c "bash $tmpfile"`.

---

## Rootless Docker — nicht unterstützt

Docker hat einen rootless-Modus
(`dockerd-rootless-setuptool.sh install`), in dem der Daemon als
unprivilegierter User läuft. Klingt verlockend, ist für Monoceros'
Devcontainer-Workflow aber problematisch:

- **Bind-Mount-UID-Shift**: in rootless wird der Host-User auf
  Container-UID 0 (root) gemappt; der Container-Default-User
  (`node` mit UID 1000) auf Host-UID 65536+999. Files, die der
  Container als `node` schreibt, landen auf dem Host mit einer
  UID, die der Builder-User nicht editieren kann ohne sudo. Bricht
  das „edit auf Host, run im Container"-Modell.

- **`idmap`-Mount-Option, die das lösen würde**, existiert im
  Linux-Kernel — aber **Docker exponiert sie nicht via `--mount`**
  (verifiziert in [Docker bind-mounts docs](https://docs.docker.com/engine/storage/bind-mounts/)).
  Podman tut's, Docker noch nicht. Ohne idmap kein sauberer Fix.

- **Workaround „Container als root laufen lassen"** würde
  funktionieren (host-User mapped auf container-root, file-
  ownership stimmt), bringt aber HOME-Pfad-Mismatches (Container-
  Tools suchen Configs unter `/root/.x`, nicht `/home/node/.x`),
  npm-as-root-Warnings und allgemeine Reibung.

Wenn du rootless Docker explizit brauchst (Compliance, Multi-User-
Server-Policy), ist Monoceros heute nicht das richtige Werkzeug.
Falls echte Builder-Nachfrage kommt, kann das ein eigenes Feature
oder eine ADR-Diskussion werden — aktuell ist's bewusst raus.

**Hinweis auf den Pfad zurück zu rootful**, falls du versehentlich
rootless installiert hast:

```sh
# Rootless deaktivieren
systemctl --user stop docker.service docker.socket 2>/dev/null || true
dockerd-rootless-setuptool.sh uninstall
rootlesskit rm -rf ~/.local/share/docker
unset DOCKER_HOST DOCKER_CONTEXT

# Rootful aktivieren (sollte vom get.docker.com-Install schon
# da sein, sonst install.sh nochmal)
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

Plus: `~/.bashrc` / `~/.profile` auf `DOCKER_HOST` und
`DOCKER_CONTEXT`-Reste checken — der rootless-Setup-Tool schreibt
da gerne was rein, was sonst neue Shells weiter zum rootless-Socket
schickt:

```sh
grep -E 'DOCKER_HOST|DOCKER_CONTEXT' ~/.bashrc ~/.profile 2>/dev/null
```

Wenn da Treffer kommen → editieren oder per `sed -i` rausstreichen.

Verifizieren:

```sh
docker info | grep -i rootless   # → muss leer sein
docker info | grep "Docker Root Dir"   # → /var/lib/docker
```

Wenn `docker info` Permission-Denied wirft, hat deine aktuelle
Shell die docker-Gruppe noch nicht geladen — einfach `newgrp docker`
oder direkt `monoceros apply <name>` aufrufen, der Auto-Recovery-
Bootstrap fängt's ab.

---

## Häufige Fehlermeldungen + Diagnose

### `permission denied while trying to connect to the docker API`

Klassiker. Heißt: Docker-Daemon läuft, aber deine Shell hat keinen
Zugriff. Mögliche Ursachen:

1. **User nicht in `docker`-Gruppe**: `getent group docker`. Wenn
   du nicht in der letzten Spalte stehst, `sudo usermod -aG docker
$USER` ausführen.
2. **User ist in `docker`-Gruppe, aber Shell hat's nicht geladen**:
   GNOME-Session-Falle. Monoceros-Auto-Recovery sollte das abfangen
   — falls nicht: `newgrp docker` einmal manuell.
3. **Docker rootless ohne dass du's wolltest**: `docker info | grep
-i rootless` → wenn da was steht, siehe Hinweis-Block oben.

### `Cannot connect to the Docker daemon`

Daemon läuft nicht. `sudo systemctl status docker` und ggf.
`sudo systemctl start docker`. Wenn er nicht startet, im Journal
suchen (`journalctl -u docker.service -n 50`).

### `getent group docker` ist leer

Die Gruppe wurde nicht angelegt. Ungewöhnlich nach
`get.docker.com`. Manuell anlegen:

```sh
sudo groupadd docker
sudo usermod -aG docker $USER
```

---

## Referenzen

- [ADR 0006 — HTTPS-only Repo-Auth](./adr/0006-https-only-repo-auth.md) —
  warum SSH-Repo-Auth aus dem Scope ist (verwandtes Cross-Plattform-Thema)
- [Docker Engine Install — official docs](https://docs.docker.com/engine/install/)
- [Docker Engine Post-Installation Steps](https://docs.docker.com/engine/install/linux-postinstall/) —
  upstream-Doku der docker-Gruppen-Thematik
- [`packages/cli/src/devcontainer/docker-group-bootstrap.ts`](../packages/cli/src/devcontainer/docker-group-bootstrap.ts) —
  Source des Auto-Recovery-Mechanismus
