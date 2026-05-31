# Monoceros auf Windows einrichten

Diese Seite ist für Builder, die Monoceros **auf Windows** nutzen
wollen. Sie deckt den Normalfall ab plus die Stolpersteine, die in
der Praxis auftauchen — vor allem die irreführende Meldung
„Virtualization support not detected" und den Fall ohne Adminrechte.

Auf macOS und Linux ist der Pfad ein anderer; für Linux siehe
[`docker-on-linux.md`](docker-on-linux.md).

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

## Standard-Weg (mit Adminrechten)

Der getestete, empfohlene Ablauf auf einer frischen Maschine:

1. **PowerShell als Administrator öffnen**
   (Rechtsklick auf PowerShell → „Als Administrator ausführen").

2. **WSL installieren:**

   ```powershell
   wsl --install
   ```

   Das aktiviert die nötigen Windows-Features, installiert **Ubuntu**
   und setzt **WSL 2 als Default**. Wenn anschließend die Linux-Shell
   aufgeht, mit `exit` wieder verlassen. Verlangt Windows einen
   Neustart, jetzt neu starten.

3. **Docker Desktop installieren:**

   ```powershell
   winget install Docker.DockerDesktop
   ```

4. **Docker Desktop starten** und warten, bis das Wal-Symbol nicht
   mehr animiert. Die Anmelde-Aufforderung kannst du überspringen —
   sie ist für den Betrieb nicht nötig.

5. **Execution-Policy freigeben** (einmalig, kein Admin nötig). Bei
   Windows-Default `Restricted` laufen die von npm angelegten
   `.ps1`-Wrapper für `npm` **und** `monoceros` nicht — der Installer
   bricht sonst kryptisch an `npm.ps1` ab:

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```

   Persistent für deinen User, damit auch künftige Tabs `monoceros`
   ausführen können. Der Installer prüft die Policy und weist auf
   genau diesen Befehl hin, falls er fehlt.

6. **Monoceros-Installer in einer NEUEN, normalen PowerShell**
   (ohne Admin) ausführen:
   ```powershell
   iwr -useb https://raw.githubusercontent.com/getmonoceros/workbench/main/install.ps1 | iex
   ```

Bei Bedarf zwischendurch einen Neustart einlegen, wenn Windows danach
fragt.

---

## Erster `monoceros apply` — die „No manifest found"-Zeile

Beim allerersten `apply` zieht Docker das Multi-Arch-Runtime-Image.
devcontainer-cli loggt dabei eine Zeile, die nach Fehler aussieht,
aber **harmlos** ist:

```
Error fetching image details: No manifest found for ghcr.io/getmonoceros/monoceros-runtime:1.
```

Danach lädt Docker ~1–2 Minuten ohne weitere Ausgabe. Monoceros
schiebt direkt nach dieser Zeile einen Hinweis ein, dass der Download
läuft — die Zeile ist also kein Abbruch. Einfach warten; folgende
`apply`-Läufe sind gecached und schnell.

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

`monoceros` erkennt diesen Zustand selbst: Läuft ein Befehl, während
Docker nicht erreichbar ist und keine WSL-2-Distro registriert ist,
gibt die CLI denselben Hinweis samt der drei `wsl`-Befehle aus, statt
nur einen generischen Docker-Fehler zu zeigen.

> Den Schalter „Use the WSL 2 based engine" suchst du in neueren
> Docker-Desktop-Versionen vergeblich — WSL 2 ist dort das einzige
> Backend (Hyper-V gibt es u.a. auf Windows Home gar nicht). Der
> Schalter ist absichtlich weg, kein Fehler.

---

## Fall: keine Adminrechte (managed/Firmen-Laptop)

Docker Desktop kann **ohne Admin** installiert werden — im
**Per-User-Modus**. Der installiert nach
`%LOCALAPPDATA%\Programs\DockerDesktop` und braucht keine erhöhten
Rechte.

Direkt mit dem offiziellen Installer:

```powershell
Start-Process 'Docker Desktop Installer.exe' -Wait -ArgumentList 'install','--user'
```

Oder über winget, indem die Installer-Argumente durchgereicht werden
(`winget install Docker.DockerDesktop` allein nimmt sonst den
All-Users-Pfad mit UAC/Admin):

```powershell
winget install Docker.DockerDesktop --override "install --user --accept-license"
```

Einschränkungen des Per-User-Modus:

- **nur WSL-2-Backend** (kein Hyper-V) — für Monoceros genau richtig
- **keine Windows-Container**

**Wichtiger Haken:** `wsl --install` selbst **braucht Admin**. Der
No-Admin-Weg für Docker funktioniert also nur, wenn **WSL bereits
aktiviert** ist (z.B. von der IT vorinstalliert). Ist WSL noch gar
nicht da und du hast keinen Admin, führt kein Weg an der IT vorbei.

---

## Adminrechte — was braucht was?

| Befehl                                | Admin nötig? |
| ------------------------------------- | ------------ |
| `wsl --install`                       | ja           |
| `wsl --update`                        | ja           |
| `wsl --set-default-version 2`         | empfohlen \* |
| `wsl --install -d Ubuntu`             | empfohlen \* |
| `winget install Docker.DockerDesktop` | ja (UAC)     |
| Docker Desktop per-user (`--user`)    | nein         |
| Monoceros-Installer (`install.ps1`)   | nein         |

\* Technisch nicht zwingend, aber da der Setup-Block ohnehin in einer
Admin-PowerShell läuft, ist „alles als Admin" die einfache Ansage.

Der Monoceros-Installer läuft bewusst **als normaler User** — er
macht nur ein `npm install -g` und einen `$PROFILE`-Eintrag für die
Completion. Deshalb am Ende eine **neue, normale PowerShell** öffnen.

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
- [`docker-on-linux.md`](docker-on-linux.md) — das Pendant für Linux
