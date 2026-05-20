# ADR 0004 — Release-Modell: N unabhängige Deployments, Version-getriggert

- Status: accepted
- Datum: 2026-05-19

## Kontext

Mit M4 verlässt Monoceros den „ich klone das Workbench-Repo und
arbeite drin"-Status. Ein Builder, der das Repo nie gesehen hat, soll
das Tool installieren und Container hochfahren können. Das wirft
Fragen auf, die der M4-Brief nur halb beantwortet hatte:

- Was genau wird wohin distribuiert?
- Wer triggert wann ein Release?
- Wie weiß die CI, ob es für eine bestimmte Komponente etwas zu tun
  gibt?
- Brauchen wir eine Staging-Umgebung?
- Was kommt physisch auf den Rechner des Nutzers — und was zieht
  Docker zur Laufzeit?
- Windows zählt als Zielplattform.

Beim Versuch, das pragmatisch via Skript + manuellem Publish zu
machen (siehe rückgängig gemachter Commit `ac1c081`), wurde klar, dass
der Brief implizit „eine CLI plus eine Feature-Library" annahm — also
zwei Deployments. Das stimmt nicht. Heute sind es fünf Deployments
(CLI + Runtime-Image + drei Features), und mit jedem weiteren Feature
auf der Backlog-Liste wächst die Zahl. „Feature" ist eine Kategorie,
aber kein gemeinsames Release-Artefakt.

## Entscheidung

### Artefakt-Typen und unabhängige Versionierung

Es gibt drei Typen von Release-Artefakten. Jede Instanz eines Typs
ist ein eigenständiges Deployment mit eigener Versionsnummer, eigenem
Release-Zyklus und eigenem CI-Trigger.

| Typ               | Versionsquelle                                               | Distributionsziel                                          |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| **CLI**           | `packages/cli/package.json` `version`                        | GitHub Releases mit plattformspezifischen Artefakten       |
| **Runtime-Image** | `images/runtime/VERSION` (neu anzulegen)                     | `ghcr.io/getmonoceros/monoceros-runtime:<version>`         |
| **Feature**       | `images/features/<name>/devcontainer-feature.json` `version` | `ghcr.io/getmonoceros/monoceros-features/<name>:<version>` |

Heute heißt das fünf Deployments — eine CLI, ein Runtime-Image, drei
Features (`claude-code`, `atlassian`, `github-cli`). Jedes weitere
Feature unter `images/features/` ist ein zusätzliches Deployment. Sie
entwickeln sich getrennt: `claude-code` springt von `1.1.0` auf
`1.5.0` weil Anthropic was geändert hat, während `atlassian` über
Monate auf `0.3.0` stehen bleibt. Die CLI hat ihren eigenen SemVer-
Track unabhängig von allem.

### Version-getriggerte Pipelines

Eine Pipeline publisht eine Komponente **genau dann, wenn die in der
Quelle deklarierte Version noch nicht im Registry liegt**. Kein
„hat sich seit letzten Commit etwas geändert?", kein expliziter Tag,
keine manuelle Auslösung. Wer was rausgeben will, bumpt die Version,
committet, mergt nach `main` — Rest erledigt sich.

Erkannt wird das mit zwei Stufen:

1. **Pfad-Trigger** spart sich Workflow-Runs, wenn nichts Relevantes
   geändert wurde. Pro Workflow `paths:`-Filter — zum Beispiel
   `images/features/**` für den Features-Workflow.
2. **Version-Vergleich im Workflow** entscheidet pro Artefakt, ob
   wirklich publisht wird:
   - OCI-Artefakte (Features, Runtime-Image):
     `docker manifest inspect <ref>` — exit 0 = liegt da, skip;
     exit non-0 = neu, publishen.
   - GitHub-Release-Artefakte (CLI): `gh release view <tag>` analog.

Das ist idempotent: Re-Runs des Workflows machen nichts, weil keine
Versionsnummer noch fehlt. Es ist explizit im Workflow-Log
sichtbar, welche Komponenten publisht wurden und welche übersprungen.
Es ist race-safe.

### Drei Workflow-Dateien

```
.github/workflows/
├── precheck.yml         ← lint + typecheck + test auf jedem PR
├── release-cli.yml      ← CLI-Release (paths: packages/cli/**)
├── release-runtime.yml  ← Runtime-Image (paths: images/runtime/**)
└── release-features.yml ← Alle Features (paths: images/features/**)
```

Drei Release-Workflows, aber **N Deployments** — der Features-Workflow
iteriert über `images/features/*/` und behandelt jeden Unterordner als
eigenes Artefakt. Wenn morgen `images/features/opencode/` dazukommt,
ändert sich an `release-features.yml` keine Zeile; der Loop findet das
neue Verzeichnis automatisch.

Diese Bündelung gilt nur für Features, weil sie strukturell identisch
sind (gleiche Publish-CLI, gleiches Registry-Schema, gleiche
Versionierungs-Konvention). CLI und Runtime-Image haben eigene
Workflows, weil ihre Build-Steps und Artefakt-Typen unterschiedlich
genug sind, dass eine Verallgemeinerung künstliche Kopplung wäre.

### Keine Staging-Umgebung

Wir bauen keine separate Staging-Org, kein paralleles Registry-
Namespace, keine zweite Distributionspipeline. Eine Staging-Umgebung
würde die Infrastruktur verdoppeln (jeder Workflow zweimal, jede
Visibility-Einstellung zweimal, jede Doku doppelt) für einen
Mehrwert, den drei kleinere Mechanismen sauberer abdecken:

- **Precheck** (`precheck.yml`) — lint, typecheck, vitest auf
  jedem PR und Push nach `main`. Source-Hygiene, kein Build oder
  Integration. Code muss grün sein, um auf `main` zu landen.
- **Lokale Smoke-Strecke** — `pnpm sandbox:reset` baut Runtime-Image
  lokal, scaffolded Sandbox, fährt Container hoch. Wer ein Feature
  oder das Image ändert, fährt das vor dem Merge einmal durch.
- **SemVer-Pre-Release-Tags** — wenn wir was schrittweise ausrollen
  wollen, geht das mit `<name>:<version>-rc.<n>` (z. B.
  `claude-code:1.2.0-rc.1`) im selben Registry-Namespace. Der
  schwebende Major-Tag (`:1`) wandert dabei explizit **nicht** auf
  RC-Versionen; Builder, die testen wollen, pinnen die RC manuell in
  ihre yml. Geht alles gut, kommt die reguläre `1.2.0`, der Major-
  Tag wandert mit, und yml-Pins gehen wieder auf den Major-Tag.

Eine echte Staging-Stufe wird interessant, sobald die CLI-Build-
Pipeline komplex wird (Cross-Compile, macOS-Notarization, Windows-
Code-Signing) und Fehler dort die Installationserfahrung aller
Builder kaputtmachen würden. Dann ggf. ein `MONOCEROS_CHANNEL=next`-
Schalter im Install-Skript, der das jeweils letzte Pre-Release lädt
statt der Stable. Das ist Folge-Arbeit, nicht M4-Scope.

### Was beim Builder lokal landet — und was nicht

Beim Install kommt **nur die CLI selbst** auf den Rechner: das
Paket mit unserem `dist/`, dem Templates-Verzeichnis
(`templates/components/`, das `monoceros init --with=…` komponiert)
und der User-Doku (`docs/commands/`, auf die generierte
Solution-READMEs verlinken). Wohin npm das schreibt, hängt von der
npm-Konfiguration des Users ab (`/usr/local/lib/node_modules/`,
`%APPDATA%\npm\node_modules\`, Homebrew-Cellar, etc.); der
`bin`-Eintrag aus `package.json` legt den `monoceros`-Shim auf den
PATH. Monoceros selbst kennt diesen Pfad nicht und braucht ihn
nicht zu kennen. Siehe ADR 0005 für die Distribution-Entscheidung.

Das Runtime-Image und die Features sind **keine Dateien auf der
Builder-Disk**. Docker zieht das Runtime-Image beim ersten
`monoceros apply` aus GHCR, das devcontainer-cli zieht die im yml
referenzierten Features ebenfalls dann. Beides cached Docker im
eigenen Image-Store (`/var/lib/docker/...`, bzw. die Docker-
Desktop-VM). Monoceros verwaltet diesen Cache nicht.

Nutzer-State liegt komplett getrennt vom Tool:

| Plattform    | Nutzer-State-Pfad           |
| ------------ | --------------------------- |
| macOS, Linux | `~/.monoceros/`             |
| Windows      | `%USERPROFILE%\.monoceros\` |

`monoceros-config.yml`, `container-configs/<name>.yml`, materialisierte
`container/<name>/`-Bäume mit `home/`, `projects/`, `data/`. Update
oder Deinstallation des CLI-Tools fasst diesen Pfad **niemals** an.
Node's `os.homedir()` löst beide Plattformen out-of-the-box korrekt
auf.

### Plattform-Matrix für die CLI

> **Abgelöst am 2026-05-20** durch
> [ADR 0005 — CLI-Distribution via npm](./0005-cli-distribution-via-npm.md).
> Beim Detaillieren stellte sich heraus, dass Monoceros intern
> `@devcontainers/cli` als Node-Subprozess spawnt und daher ohne
> erheblichen Architekturumbau ohnehin Node auf dem Host braucht.
> Damit verliert die Plattform-Matrix mit fünf vorgebauten Binaries
> ihren Zweck — die CLI wird stattdessen als npm-Paket verteilt.
> Der untenstehende Abschnitt ist nur als historische Notiz erhalten.

GitHub-Release pro CLI-Version enthält fünf Artefakte:

- `monoceros-macos-arm64.tar.gz`
- `monoceros-macos-x64.tar.gz`
- `monoceros-linux-arm64.tar.gz`
- `monoceros-linux-x64.tar.gz`
- `monoceros-windows-x64.zip`

Plus zwei Install-Skripte im Repo-Root, die das passende Artefakt
herunterladen und entpacken:

- `install.sh` für macOS und Linux (bash, curl-pipe-bash-tauglich)
- `install.ps1` für Windows (PowerShell)

Wie genau die Tarballs gebaut werden (Single-Binary via `bun --compile`
oder via Node-SEA, oder klassisch mit Node-Dependency) ist
Implementierungsdetail des CLI-Workflows, nicht Architekturentscheid.
Default-Empfehlung bleibt Single-Binary, weil sich „User muss Node
installieren" mit einem CLI-Tool-Anspruch beißt — aber finale Wahl
fällt im Implementierungsticket.

## Konsequenzen

- Der M4-Brief (`docs/m4-brief.md`) ist mit dieser ADR obsolet. Er
  beschreibt einen früheren Stand, in dem die Distributions-Frage
  „npm install -g" angenommen wurde. Wir lassen ihn als Hand-Over-
  Notiz stehen, weil er den Pivot-Stand vom 2026-05-19 dokumentiert,
  aber operative Wahrheit ist ab jetzt diese ADR.
- Der zwischenzeitliche `scripts/publish-features.sh` (Commit
  `ac1c081`) wird zurückgenommen — er passte zum manuell-erst-CI-
  später-Modell, das wir verwerfen.
- Das `images/runtime/VERSION`-File ist neu, muss vor dem ersten
  Runtime-Image-Push angelegt werden.
- Die Backlog-M4-Task-Liste wird auf das neue Modell umgeschnitten:
  Task 2 wird „Features-Workflow", Task 3 wird „Runtime-Workflow",
  Task 4 wird „CLI-Release-Workflow inkl. Install-Skripte",
  Task 7 (CI-Skeleton) wird zu „Precheck" und ist eigenständig.
- Windows ist explizit im Scope. Konsequenzen für die CLI-
  Implementierung (Pfad-Resolution, Binary-Build, Install-Skript)
  müssen ab jetzt mitgedacht werden — kein nachträglicher
  „Windows-Support-Sprint".
- Die ✅-Marker in der M4-DoD des Backlogs bleiben aspirational
  („so sieht Done aus"), nicht ausgeführt. Wenn M4 abgeschlossen
  ist, werden sie nicht entfernt, sondern bestätigt.

## Nicht-Ziele dieser ADR

- **Konkrete YAML-Workflow-Files** — entstehen in den jeweiligen
  Implementierungs-Commits. Diese ADR fixt die Logik (Pfad-Trigger +
  Version-Detection + Idempotenz), nicht die Action-Syntax.
- **Brew-Tap / WinGet-Manifest / Scoop-Bucket** — sind Wrapper
  über die GitHub-Releases-Tarballs, die kommen können sobald wir
  echte Nutzer und Demand sehen. Erstmal direkter Install-Pfad.
- **Auto-Update der installierten CLI** — heute manuell via Re-Run
  des Install-Skripts. Auto-Update-Mechanik kommt in einer späteren
  Etappe falls überhaupt.
- **Single-Binary-Build-Toolwahl** (`bun --compile` vs. Node-SEA
  vs. `pkg`) — Implementierungsdetail, gehört in die CLI-Workflow-
  PR und nicht in diese ADR.
- **Wann genau die GHCR-Pakete von `private` auf `public` flippen** —
  ist ein einmaliger UI-Klick pro Paket, nach dem ersten erfolgreichen
  Workflow-Run. Die ADR sagt nichts dazu, weil's keine
  Design-Entscheidung ist.
