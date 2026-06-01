# ADR 0011 — WSL-only auf Windows

- Status: accepted
- Datum: 2026-06-01

## Kontext

Bis 1.11 hatte Monoceros zwei Install-Pfade auf Windows:

1. **Windows-Host** — `install.ps1` lief in PowerShell, installierte
   Monoceros als Windows-native Node-CLI über npm, schrieb State nach
   `%USERPROFILE%\.monoceros`.
2. **WSL** — `install.sh` aus einer WSL-Distro heraus, Monoceros lief
   als reguläres Linux-Tool, State unter `~/.monoceros` in der Distro,
   Docker via Docker-Desktop's WSL Integration.

Die Dual-Path-Variante war als Komfort gedacht: Windows-User, die
nicht in WSL leben, sollten Monoceros direkt aus PowerShell nutzen
können. In der Praxis akkumulierten sich aber Windows-Host-spezifische
Reibungspunkte, die jeder einzeln gelöst werden mussten:

- **Drive-Letter-Case** in Docker-Labels: devcontainer-cli lowercased
  den Drive-Letter (`c:\…`), `path.join` auf Windows liefert ihn
  uppercase (`C:\…`), Docker-Filter sind byte-exact → Container blieben
  bei `remove` als Zombies stehen.
- **cmd.exe-Quoting**: Shell-Scripts (für Cleanup-Pipelines) liefen auf
  Windows via WSL-bash mit MSYS-/9P-Translation, was Backslash-Pfade
  in Args verstümmelte.
- **npm's `.ps1`-Shim** wurde von PowerShell mit Vorrang vor `.cmd`
  resolved und kollidierte mit PowerShell's Komma-als-Array-Operator
  → `monoceros init foo --with=a, b` parste `a b` als ein Component-
  Name statt zwei.
- **`taskkill` statt SIGINT**: Windows hat keine POSIX-Process-Groups,
  `process.kill(-pid, sig)` warf EINVAL → eigene Teardown-Logik für
  background-Spawns.
- **Traefik-File-Watch-Defekt** auf Docker-Desktop's gRPC-FUSE-Bind-
  Mount: inotify-Events kamen nicht an, dynamic-config-Änderungen
  wurden vom laufenden Proxy übersehen → explizite `docker restart`
  nach jedem yml-Write.
- **Git-Credential-Manager**: `git credential fill` triggert OAuth aber
  ruft nie `git credential store` → jeder Apply fragte erneut nach
  Browser-Auth.
- **PATHEXT-Lookup** für `.cmd`-Shims aus Node-spawn auf Windows
  (post-CVE-2024-27980 Lockdown).
- **e2e-Test-Spezifika**: `.localhost`-Auflösung, Process-Tree-Kill,
  Shim-Parsing für e2e's spawn-Aufrufe.

Jeder dieser Punkte ist isoliert lösbar gewesen, aber zusammen war's
einerseits viel Wartungsaufwand und andererseits eine Aufforderung an
neue Features sich künftig in beiden Welten zu beweisen.

Gleichzeitig stellte sich raus: **WSL ist auf Windows ohnehin Pflicht
für Docker Desktop.** Es gibt keinen Monoceros-User auf Windows, der
nicht schon WSL installiert hat. Der „direkt-aus-PowerShell"-Pfad
sparte also keinerlei Tooling-Aufwand, nur einen Terminal-Tab-Wechsel.

## Entscheidung

Ab 1.12 ist **WSL der einzige unterstützte Windows-Pfad**. Konkret:

- `install.ps1` wird entfernt.
- `docs/install-windows.md` dokumentiert den WSL-Setup als Standard-
  und einzigen Weg: WSL aktivieren, Docker Desktop installieren, WSL-
  Integration für die Distro einschalten, Linux Node+npm in WSL
  installieren, `install.sh` aus der WSL-Distro heraus laufen lassen.
- Sämtlicher Code, der spezifisch existierte um die Windows-Host-
  Variante über die Reibungspunkte zu hieven, wird entfernt:
  - `bootstrapWslBackend()` in `bin.ts` (war ein Pre-Flight für „kein
    WSL-Distro registriert" beim Aufruf von Windows-host-monoceros)
  - `kickProxyReload()` in `proxy/index.ts` (Traefik-Restart-Workaround)
  - `dockerLocalFolderLabel()` in `devcontainer/compose.ts` (Drive-
    Letter-Normalisierung)
  - winget-Branch in `installCommandForOS()` in `credentials.ts`
- Im e2e-Repo wird analog der gesamte Windows-Spezial-Code entfernt:
  Shim-Parsing in `cli.ts`, Windows-Branch in `cli-background.ts`,
  `dockerLocalFolderLabel`-Duplikat in `docker.ts`.

## Konsequenzen

- **−547 Zeilen Code im Workbench-Repo**, −170 Zeilen im e2e-Repo. Die
  Codebase reflektiert wieder die ursprüngliche Annahme: Monoceros ist
  ein Linux-Tool (mit macOS als nahem Verwandten), und wo Linux nicht
  nativ ist, wird's via WSL bereitgestellt.
- **Eine Test-Matrix-Achse weniger.** Vorher: macOS / Linux / Windows-
  Host / WSL. Jetzt: macOS / Linux / WSL — und WSL ist von Linux nur
  durch das `/etc/resolv.conf`-Setup zu unterscheiden (siehe
  e2e-with-port-Probe, die Host-Header-Trick statt `*.localhost`-
  Resolution nutzt — die einzige WSL-spezifische Anpassung die geblieben
  ist).
- **Breaking für Windows-Host-User pre-1.12.** Wer mit `install.ps1`
  installiert hatte, muss auf den WSL-Pfad migrieren. Wenig wahrscheinlich
  ein großer Pool — Monoceros ist erst seit 1.0.0 (≈ Ende Mai 2026)
  öffentlich, der Windows-Host-Pfad war nie als „lock-in for the long
  term"-Pfad gepitcht. README und `docs/install-windows.md` zeigen den
  WSL-Weg, fertig.
- **Setup-Hürde auf Windows ist marginal höher**: Wer Monoceros zum
  ersten Mal anfasst muss eine WSL-Distro öffnen statt PowerShell, und
  Linux Node+npm via apt holen. Das war's. Davon ausgehend dass der
  User schon Docker Desktop laufen hatte (sonst hätte er Monoceros
  vorher gar nicht ausprobieren können), ist WSL eh schon da; die
  Distro öffnet sich aus dem Start-Menü.
- **ADR 0005 § „Install-Skripte als Bouncer"** wird angepasst: nur
  noch `install.sh`, kein PowerShell-Pendant mehr.

## Nicht-Ziele dieser ADR

- **Generelles Verbot von Windows-Host-Code.** Wenn künftig ein
  konkreter Use-Case sauber begründbar wäre (z.B. eine systemd-freie
  Windows-Variante für ein konkretes Enterprise-Szenario), kann das
  wieder neu evaluiert werden. Diese ADR sagt nur: in 1.x ist's nicht
  drin, es kostet mehr als es einbringt.
- **WSL-1-Support.** Monoceros braucht Docker Desktop, das braucht
  WSL 2. WSL 1 ist nicht in Scope.
- **Native-Windows-Container.** Docker Desktop's Windows-Container-
  Modus läuft nicht auf WSL-2-Backend, wird also nicht supported.
  Monoceros war eh nie für Windows-Container gebaut — Linux-Container
  sind die Annahme der ganzen Image-Pipeline.

## Referenzen

- [`install.sh`](../../install.sh) — der einzige Installer
- [`docs/install-windows.md`](../install-windows.md) — WSL-Setup-Doc
- ADR 0005 § „Install-Skripte als Bouncer" (`install.ps1`-Pfad
  abgelöst durch diese ADR)
- ADR 0007 § „Port-Management via Traefik" (file-provider-Pfad bleibt;
  der Windows-spezifische Restart-Hack ist mit dieser ADR entfallen)
