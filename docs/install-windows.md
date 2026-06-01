# Monoceros auf Windows einrichten

Monoceros läuft auf Windows **inside WSL** — also als Linux-Tool in
einer WSL-2-Distro (typisch Ubuntu). Docker Desktop stellt den
Daemon, WSL stellt die Linux-Umgebung, in der Monoceros installiert
und betrieben wird. Es gibt keinen separaten Windows-Host-Installer
mehr — die alte `install.ps1`-Variante hatte zu viele Reibungspunkte
(Drive-Letter-Case, cmd.exe-Quoting, GCM-Auth-Dance, Traefik-File-
Watch-Defekt auf gRPC-FUSE-Bind-Mounts) und ist mit 1.12 entfallen.

Auf macOS und nativ-Linux ist der Pfad ein anderer; für native Linux
siehe [`docker-on-linux.md`](docker-on-linux.md).

---

## Worauf Docker Desktop auf Windows aufsetzt

Docker Desktop läuft auf Windows über das **WSL-2-Backend**. Das
bedeutet drei Bausteine, die zusammenpassen müssen:

1. **Hardware-Virtualisierung** (VT-x / AMD-V) — im BIOS aktiviert.
2. **WSL 2** — die Plattform _und_ mindestens eine installierte
   Linux-Distro.
3. **Docker Desktop** selbst, im WSL-2-Modus.

Fehlt Baustein 2, startet Docker Desktop nicht und meldet — etwas
irreführend — „Virtualization support not detected", obwohl die
Virtualisierung an sich in Ordnung ist.

---

## Setup-Schritte

Der getestete Ablauf auf einer frischen Maschine. **Nur Schritt 1
braucht eine Admin-PowerShell**, der Rest läuft als normaler User in
der WSL-Distro.

### Schritt 1: WSL 2 + Ubuntu installieren

PowerShell als Administrator öffnen (Rechtsklick → „Als
Administrator ausführen") und:

```powershell
wsl --install
```

Das aktiviert die nötigen Windows-Features, installiert **Ubuntu**
und setzt **WSL 2 als Default**. Wenn die Linux-Shell aufgeht, mit
`exit` verlassen. Verlangt Windows einen Neustart, jetzt neu starten.

### Schritt 2: Docker Desktop installieren

Eine **neue, normale PowerShell** (ohne Admin):

```powershell
winget install Docker.DockerDesktop --override "install --user --accept-license"
```

`--override "install --user --accept-license"` installiert per-user
(nach `%LOCALAPPDATA%\Programs\DockerDesktop`) ohne UAC/Admin. Ohne
das Flag würde winget den All-Users-Pfad nehmen und Admin
anfordern.

Docker Desktop starten und warten, bis das Wal-Symbol nicht mehr
animiert. Die Anmelde-Aufforderung kannst du überspringen.

### Schritt 3: Docker Desktop's WSL Integration aktivieren

In Docker Desktop: **Settings → Resources → WSL Integration** →
Toggle für **Ubuntu** anschalten, Apply & Restart.

Damit ist der `docker`-Befehl IN der WSL-Distro verfügbar und redet
mit dem gleichen Daemon wie ein Windows-Docker (das wir aber gar
nicht installieren).

> **Wichtig:** **NICHT** zusätzlich `apt install docker.io` o.ä. in
> der WSL-Distro ausführen — das wäre ein zweiter, konkurrierender
> Docker-Daemon. Docker Desktop + WSL Integration ist der einzige
> unterstützte Weg.

### Schritt 4: Node + npm in WSL installieren

Aus WSL Ubuntu heraus:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs npm
```

NodeSource bringt eine aktuelle Node-Version, `nodejs npm` zusammen
installieren stellt sicher, dass beide auf Linux-Seite landen (sonst
springt PATH-Interop ein und liefert das Windows-npm aus dem
Docker-Desktop-Bundle, was uns nicht hilft).

Verifizieren:

```sh
which node && which npm
```

Beides sollte auf `/usr/bin/...` zeigen, nicht auf `/mnt/c/...`.

### Schritt 5: Monoceros installieren

Aus WSL Ubuntu heraus, derselbe Befehl wie auf nativ-Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | bash
```

Verifizieren:

```sh
monoceros --version
```

---

## Wo arbeiten? Tipps für den WSL-Workflow

- **Windows Terminal mit Ubuntu-Profil** ist der natürlichste
  Einstieg. Im Default startet Ubuntu im Linux-Home (`~`), nicht in
  einem `/mnt/c/...`-Windows-Pfad. Falls du WSL aus PowerShell
  startest: `wsl ~` statt `wsl`, sonst landest du in der aktuellen
  PowerShell-cwd.

- **VS Code mit dem WSL-Remote-Extension** lässt dich direkt im
  WSL-Filesystem arbeiten und Dev-Container darin öffnen.

- **Browser-Zugriff** auf Container-Ports funktioniert ohne weitere
  Konfiguration: Docker Desktop's WSL Integration spiegelt von WSL
  gebundene Ports automatisch auf die Windows-Loopback-Adresse,
  also gehen `http://<container>.localhost/`-URLs aus
  Chrome/Edge/Firefox auf Windows direkt zum WSL-seitigen Traefik.

---

## Fall: „Virtualization support not detected"

Symptom: Docker Desktop startet nicht, meldet „Virtualization support
not detected" — **obwohl** die Virtualisierung im BIOS aktiviert ist
und `wsl --version` sauber durchläuft.

Ursache: Die WSL-**Plattform** ist installiert, aber es gibt **keine
WSL-2-Distro**. `wsl --version` zeigt nur die Plattform-Version, nicht
ob eine Distro vorhanden ist. Docker Desktops WSL-2-Backend hat damit
kein Fundament.

Prüfen:

```powershell
wsl -l -v
```

Wenn die Liste leer ist oder nur eine WSL-1-Distro zeigt, ist das die
Ursache. Reparatur in einer **PowerShell als Administrator:**

```powershell
wsl --set-default-version 2
wsl --update
wsl --install -d Ubuntu
```

Danach **Neustart**, Docker Desktop starten und die Distro unter
**Settings → Resources → WSL Integration** aktivieren.

> Den Schalter „Use the WSL 2 based engine" suchst du in neueren
> Docker-Desktop-Versionen vergeblich — WSL 2 ist dort das einzige
> Backend (Hyper-V gibt es u.a. auf Windows Home gar nicht). Der
> Schalter ist absichtlich weg, kein Fehler.

---

## Fall: keine Adminrechte (managed/Firmen-Laptop)

Der Per-User-Docker-Install aus Schritt 2 braucht keinen Admin. Aber:

**Wichtiger Haken:** `wsl --install` selbst **braucht Admin**. Der
gesamte No-Admin-Pfad funktioniert also nur, wenn **WSL bereits
aktiviert** ist (z.B. von der IT vorinstalliert). Ist WSL noch gar
nicht da und du hast keinen Admin, führt kein Weg an der IT vorbei.

Einschränkungen des Docker-Per-User-Modus:

- **nur WSL-2-Backend** (kein Hyper-V) — für Monoceros genau richtig
- **keine Windows-Container**

---

## Adminrechte — was braucht was?

| Befehl                                                              | Admin nötig? |
| ------------------------------------------------------------------- | ------------ |
| `wsl --install`                                                     | ja           |
| `wsl --update`                                                      | ja           |
| `wsl --set-default-version 2`                                       | empfohlen \* |
| `wsl --install -d Ubuntu`                                           | empfohlen \* |
| `winget install Docker.DockerDesktop --override "install --user …"` | nein         |
| `sudo apt install -y nodejs npm` (innerhalb WSL)                    | nein \*\*    |
| Monoceros-Installer (`install.sh` innerhalb WSL)                    | nein         |

\* Technisch nicht zwingend, aber da der WSL-Setup-Block ohnehin in
einer Admin-PowerShell läuft, ist „alles als Admin" die einfache
Ansage.

\*\* `sudo` darin ist eine WSL-User-Berechtigung, kein Windows-Admin.

---

## WSL wieder restlos entfernen

Alles in einer **PowerShell als Administrator**, in dieser Reihenfolge:

```powershell
wsl --shutdown
wsl --unregister Ubuntu
wsl --uninstall
Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
Disable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
```

Danach **Neustart**. Zeigt `wsl -l -v` mehr als nur „Ubuntu", für
jeden weiteren Eintrag `wsl --unregister <Name>` ausführen, bevor du
`wsl --uninstall` machst.

> `wsl --unregister` löscht **unwiderruflich** alle Daten der Distro.
> Und: Docker Desktop läuft auf genau diesen beiden Features — wer sie
> abschaltet, killt damit auch Docker Desktops Backend.

---

## Referenzen

- [Install Docker Desktop on Windows — Docker Docs](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Understand permission requirements for Windows — Docker Docs](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/)
- [How to install Linux on Windows with WSL — Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/install)
- [`docker-on-linux.md`](docker-on-linux.md) — das Pendant für native Linux
