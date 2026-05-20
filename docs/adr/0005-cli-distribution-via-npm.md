# ADR 0005 — CLI-Distribution via npm

- Status: accepted
- Datum: 2026-05-20

## Kontext

ADR 0004 hatte für die CLI plattformspezifische Tarballs vorgesehen
(`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
`windows-x64`) plus Install-Skripte als Wrapper. Die Idee dahinter
war „Docker ist die einzige Host-Voraussetzung" — der CLI-Build
sollte Node intern mitbringen, sodass User ohne Node-Installation
auskommen.

Beim Detaillieren tauchten zwei Probleme auf:

1. **Devcontainer-CLI ist ein eingebetteter Node-Subprozess.**
   Monoceros referenziert `@devcontainers/cli` als npm-Dependency und
   spawnt deren JS-Bin via `node <path>` (siehe
   [`packages/cli/src/devcontainer/cli.ts`](../../packages/cli/src/devcontainer/cli.ts)).
   Ein Single-Executable-Build via Node-SEA oder Bun könnte unseren
   eigenen Code bundlen — aber `process.execPath` würde dann auf
   unser eigenes Binary zeigen, nicht auf ein generisches Node, und
   SEA hat per Design keinen zweiten Entry-Point. Ohne signifikanten
   Architekturumbau (devcontainer-cli in-process, Subprocess-
   Isolation und Secret-Masking verlieren) oder eine
   Zweit-SEA-Konstruktion (Tarball-Größe verdoppelt) bleibt Node als
   Voraussetzung ohnehin notwendig.

2. **Die CLI ist pure JS.** Es gibt keinen plattformspezifischen
   Code, keine Native-Bindings, kein Binary-Layer. Fünf plattform-
   spezifische Tarballs zu bauen, nur um Node zu vermeiden,
   dupliziert Arbeit, die die npm-Registry kostenlos macht.

## Entscheidung

CLI-Distribution erfolgt über die npm-Registry als
`@getmonoceros/workbench`. Ein Artefakt pro Version, plattform-
übergreifend, ohne Binary-Bundling.

**Voraussetzungen auf der User-Maschine:**

- **Docker** (Daemon erreichbar — wir prüfen `docker info`, nicht
  nur die Binary-Existenz)
- **Node ≥ 20** (mit `npm` aus derselben Installation)

Wenn beides fehlt, kann Monoceros nicht installiert werden. Punkt.
Wir versuchen nicht, Docker oder Node selbst zu installieren — der
User behält die Kontrolle, was sich seinen Weg in seine Toolchain
bahnt.

**Install-Skripte als Bouncer.** Im Repo-Root liegen
[`install.sh`](../../install.sh) (macOS + Linux) und
[`install.ps1`](../../install.ps1) (Windows). Jedes prüft der Reihe
nach Docker und Node, gibt bei Fehlen eine plattform-spezifische
Anleitung mit Links + exit 1 aus, und führt sonst
`npm install -g @getmonoceros/workbench` aus. Aus User-Sicht:

```sh
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | sh
```

(oder das PowerShell-Pendant). Bei fehlender Voraussetzung
Nachinstallieren und erneut ausführen.

**Was die Skripte NICHT tun:**

- Sie installieren weder Docker noch Node automatisch.
- Sie machen keine `nvm`/`fnm`/`volta`-Setups im Hintergrund.
- Sie ändern keine System-Konfiguration außer dem `npm install -g`-
  Aufruf (der wiederum von der npm-Konfiguration des Users abhängt
  — Standardmäßig User-Scope auf Windows, System-Scope auf
  Unix-Setups via Homebrew/apt).

**Node-Installations-Hinweise** in den Skripten listen beide
gebräuchlichen Pfade auf — System-Pakete (`brew install node`,
`winget install OpenJS.NodeJS`, `apt install nodejs`) und Per-User-
Manager (`nvm`, `fnm`, `volta`, Direkt-ZIP) — ohne dass das Skript
selbst eine Wahl trifft.

**Release-Mechanik** folgt dem Muster aus ADR 0004 § „Version-
getriggerte Pipelines". Der CLI-Release-Workflow
(`release-cli.yml`):

- Trigger: `paths: ['packages/cli/**']` auf `main`, plus
  `workflow_dispatch`
- Liest die Version aus `packages/cli/package.json`
- Vergleicht gegen die npm-Registry (`npm view @getmonoceros/workbench@<version>`)
- Bei neu: `npm publish --access public`, sonst skip

Auth über `NPM_TOKEN`-Secret im Repository (Automation-Token, das die
2FA-Pflicht auf Publish umgeht).

## Konsequenzen

- **ADR 0004 § „Plattform-Matrix für die CLI" ist abgelöst.** Die
  fünf Tarballs verschwinden, die Build-Werkzeug-Diskussion (Bun vs
  SEA vs pkg) entfällt. Der Rest von ADR 0004 (drei Artefakt-Typen,
  Version-Detection, kein Staging) bleibt gültig.
- **`packages/cli/package.json` braucht Publish-Setup:**
  `private: true` raus; `version`, `description`, `bin`, `files`
  (nur `dist/`, `package.json`, `README`), `repository`, `homepage`,
  `license`, `engines` ausfüllen; `prepublishOnly`-Script mit
  Typecheck + Test; `build`-Script auf `tsup` (oder gleichwertig)
  für `dist/`-Output.
- **CLI-Tool-Install-Pfad** liegt jetzt wo immer npm sein globales
  Prefix konfiguriert hat (`/usr/local/lib/node_modules/`,
  `%APPDATA%\npm\node_modules\`, Homebrew-Cellar, etc.). Monoceros
  selbst kennt diesen Pfad nicht und braucht ihn nicht zu kennen —
  npm legt den `bin`-Shim auf den PATH und das war's.
- **Backlog M4 Task 5** wird kleiner und konkreter: ein npm-Publish-
  Workflow plus zwei Bouncer-Skripte, statt einer
  Plattform-Matrix-Build-Pipeline.
- **NPM_TOKEN-Setup als zusätzliche Vorbedingung für M4-
  Abschluss:** Automation-Token unter
  <https://www.npmjs.com/settings/getmonoceros/tokens> erzeugen, als
  Repository-Secret `NPM_TOKEN` in `getmonoceros/workbench`
  hinterlegen.

## Nicht-Ziele dieser ADR

- **Userspace-spezifische Windows-Distribution.** Wir bauen keine
  Sonderbehandlung für Locked-Down-Corporate-Windows ohne Admin-
  Rechte. Wenn der User Docker auf seiner Maschine ans Laufen kriegt
  — Docker Desktop braucht prinzipiell Admin — läuft alles andere
  via Userspace-Node-Optionen wie üblich. Wenn nicht, ist das ein
  Showstopper vor Monoceros, kein Monoceros-Problem.
- **Brew-Tap / WinGet-Manifest / Scoop-Bucket.** Wrapper über die
  npm-Distribution, die später entstehen können, falls echte
  Nachfrage entsteht. Erstmal direkter Install-Pfad.
- **Auto-Update der installierten CLI.** Manuell via
  `npm update -g @getmonoceros/workbench` oder Re-Run des
  Install-Skripts. Auto-Update-Mechanik kommt in einer späteren
  Etappe falls überhaupt.
- **Bundling von Devcontainer-CLI in monoceros' Codebase.** Bleibt
  npm-Dependency wie bisher, kommt durch `npm install -g`
  automatisch mit.
