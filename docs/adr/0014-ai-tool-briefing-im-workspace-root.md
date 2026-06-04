# ADR 0014 — AI-Tool-Briefing im Container-Workspace-Root

- Status: accepted
- Datum: 2026-06-04

## Kontext

AI-Coding-Tools im Container (Claude Code, OpenCode, perspektivisch
Codex, Gemini CLI, GitHub Copilot) wissen out-of-the-box nicht, was
für ein Stack im Container materialisiert wurde. Ein Container, der
auf Java zugeschnitten ist, riskiert dass Claude ungefragt ein
Node-Backend baut, weil es nicht weiß welche Sprachen, Services und
Hilfsbefehle ihm zur Verfügung stehen.

Die Information existiert bereits in der yml und in den installierten
Devcontainer-Features. Sie muss in einer Form vorliegen, die die
AI-Tools beim Session-Start automatisch lesen — ohne dass der Builder
das pro Session erklären muss.

Jedes Tool hat eigene Konventionen für Instruktions-Dateien:

| Tool           | Datei                              | Lookup                                     |
| -------------- | ---------------------------------- | ------------------------------------------ |
| Claude Code    | `CLAUDE.md`                        | Walk-up vom cwd bis Filesystem-Root        |
| OpenCode       | `AGENTS.md` (Fallback `CLAUDE.md`) | Walk-up vom cwd bis Filesystem-Root        |
| Codex          | `AGENTS.md`                        | git-Root nach unten zum cwd (kein Walk-up) |
| Gemini CLI     | `GEMINI.md`                        | Walk-up bis "trusted root" (unscharf)      |
| GitHub Copilot | `.github/copilot-instructions.md`  | Workspace-Root only, in Multi-Root buggy   |

Zusätzlich gibt es Managed-Policy-Slots an System-Level-Pfaden
(`/etc/claude-code/CLAUDE.md`, `/etc/codex/requirements.toml`), die
Unternehmen via MDM auf den Host deployen. Diese Slots gehören der
Org, nicht uns — Monoceros darf sie nicht überschreiben, sonst wird
die Workbench zum Policy-Bypass.

## Entscheidung

Monoceros legt das Container-Briefing **am Container-Workspace-Root
neben der `.code-workspace`-Datei** ab, nicht in System-Pfaden und
nicht in Projekt-Verzeichnissen. Konkret:

```
container/<name>/
├── .devcontainer/
├── .monoceros/
│   ├── state.json
│   └── commands.md        ← CLI-Referenz, von AGENTS.md @-importiert
├── home/
├── logs/
├── projects/
│   └── <projekt>/         ← Projekt-Repos, unberührt
├── sandbox.code-workspace
├── AGENTS.md              ← kanonischer Inhalt (in Markern)
└── CLAUDE.md              ← @AGENTS.md (in Markern)
```

**`AGENTS.md`** ist die Quelle der Wahrheit: enthält Stack-Manifest
(Sprachen, Services, Connection-Hinweise), Hinweis auf das deklarative
Modell, und die drei Erweiterungsbefehle (`monoceros add-feature`,
`add-service`, `apply`) als Anweisung an den User — nicht an das
Tool, das selbst nichts auf dem Host ausführen kann.

**`CLAUDE.md`** importiert `@AGENTS.md`. Das ist der in der
Claude-Code-Doku empfohlene Mechanismus für AGENTS.md-Koexistenz
und vermeidet Inhalts-Duplikation. OpenCode liest beide Dateien
direkt und käme auch ohne diesen Stub aus.

**`.monoceros/commands.md`** ist die per-Subcommand-Referenz, aus den
citty-Definitionen in `commands/*.ts` generiert. `AGENTS.md` zieht sie
via `@.monoceros/commands.md` rein — so kann die AI-Tool-Session die
exakte Befehls-Syntax nachschlagen, bevor sie einen Vorschlag macht.

Beide marker-tragenden Dateien (`AGENTS.md` und `CLAUDE.md`) werden
in HTML-Kommentar-Marker `<!-- monoceros:begin -->` /
`<!-- monoceros:end -->` eingewickelt. Apply ersetzt **nur** den
Inhalt zwischen den Markern. Was der Builder außerhalb der Marker
schreibt (eigene Notizen, projekt-spezifische Erinnerungen), bleibt
erhalten. `.monoceros/commands.md` ist zu 100 % Monoceros-eigen und
wird immer komplett neu geschrieben.

## Begründung

- **Walk-up trifft beide Primär-Tools.** Claude Code und OpenCode
  walken vom cwd in einem Projekt unter `projects/<name>/` bis zur
  Filesystem-Root und finden die Datei eine Ebene über `projects/`
  automatisch. Eine Datei, zwei Tools, keine Symlinks ins Projekt.
- **Kein Policy-Bypass.** Die System-Slots `/etc/claude-code/CLAUDE.md`
  und `/etc/codex/requirements.toml` bleiben unberührt. Wenn eine Org
  diese Pfade per MDM auf den Host deployed, kann die Container-Build-
  Pipeline sie unverändert in den Container propagieren (separate
  Entscheidung, nicht Teil dieser ADR), ohne dass das Monoceros-
  Briefing in Konflikt gerät.
- **Keine Schreibvorgänge in Projekt-Verzeichnisse.** `projects/<name>/`
  ist User-Territorium — eigenes git, eigene `.gitignore`, ggf. eigene
  `CLAUDE.md`. Monoceros schreibt dort nicht rein. Wenn ein Projekt
  eine eigene `CLAUDE.md` mitbringt, wird sie via Walk-up _zusätzlich_
  zum Monoceros-Briefing geladen — Claude Code und OpenCode
  konkatenieren beide.
- **Host-Filesystem ist nicht betroffen.** Die Struktur `container/<name>/`
  existiert auf dem Host als materialisiertes Verzeichnis, im Container
  wird sie auf den Workspace-Root gemountet. AI-Tools lesen das
  Briefing nur innerhalb des Containers.
- **`AGENTS.md` als kanonischer Name** ist die Konvergenz-Wette: der
  offene Standard, den Codex und OpenCode nativ lesen, Copilot-Cloud-
  Agent ebenfalls, und für den Claude Code einen offiziellen Import-
  Mechanismus dokumentiert. `GEMINI.md`-Symlink wäre trivial zu
  ergänzen, sobald Gemini-Support priorisiert wird.

## Konsequenzen

- Beim `apply` generiert Monoceros `AGENTS.md`, `CLAUDE.md` und
  `.monoceros/commands.md` im Container-Verzeichnis. Inhalt von
  `AGENTS.md` leitet sich deterministisch aus der yml und den
  installierten Features ab; `commands.md` aus den citty-Definitionen
  der gerade laufenden CLI-Version.
- `AGENTS.md` und `CLAUDE.md` werden zur generierten `.gitignore` im
  Container-Verzeichnis hinzugefügt (`.monoceros/` war schon drin
  und deckt `commands.md` automatisch ab) — falls das Verzeichnis
  selbst irgendwann unter Versionskontrolle landet, Monoceros-Dateien
  gehören dort nicht rein.
- **Marker-Contract** auf `AGENTS.md` und `CLAUDE.md`: der vom
  Generator geschriebene Block sitzt zwischen
  `<!-- monoceros:begin -->` / `<!-- monoceros:end -->`. Re-apply
  ersetzt nur diesen Block; User-Ergänzungen davor/danach
  überleben. Claude-Code-Doku stripped die HTML-Kommentare vor
  Context-Injection, also kein Token-Aufschlag für die Marker selbst.
- **Manifest-getriebene Feature-Briefings**:
  `x-monoceros.briefing.lines` in `devcontainer-feature.json` mit
  optionalem `whenOption`-Gating. Der Generator merged
  Manifest-Defaults mit User-Optionen, emittiert nur Zeilen die
  truthy gegeneinander aufgelöst werden. Ein Feature mit
  Briefing-Block aber ohne matching Zeile wird stillschweigend
  weggelassen — kein "Tool installiert" wenn keins läuft.
- **Keine Credentials im Briefing** — weder Dev-Defaults aus dem
  Service-Catalog noch Werte aus der `.env`. Das Briefing weist das
  AI-Tool an, den User in der laufenden Session zu fragen wenn es
  Credentials braucht. Damit ist die Datei auch dann unkritisch,
  wenn sie als Screenshot/Paste die lokale Maschine verlässt.
- Das Briefing-Generierungs-Modul (Stack-Manifest aus yml ableiten) ist
  als eigene Komponente testbar und unabhängig vom Apply-Subprozess
  — siehe `packages/cli/src/briefing/`.
- **Codex, Gemini CLI, GitHub Copilot bleiben heute blinde Flecken.**
  Sie sehen das Briefing nicht über den Walk-up-Mechanismus. Das ist
  bewusst akzeptiert; Lösungen sind dokumentiert (siehe unten) und
  warten auf Priorisierung.

### Offene Punkte (für später)

- **Codex** — `~/.codex/AGENTS.md` als globaler User-Slot im
  Container-Home wäre der naheliegende Weg, real zu testen.
- **Gemini CLI** — `~/.gemini/GEMINI.md` analog. "Trusted root"-
  Definition aus dem Source der Gemini CLI verifizieren.
- **GitHub Copilot** — echter Sonderfall: braucht Per-Projekt-Datei
  (`.github/copilot-instructions.md`) oder Workspace-Root-Datei
  abhängig von Open-Folder-vs-Multi-Root. Lösung erfordert
  Schreibzugriff auf Projekte oder einen aktivierbaren yml-Schalter
  pro Projekt.
- **Service-seitiges Briefing-Manifest** — Features sind seit
  Implementation manifest-getrieben (`x-monoceros.briefing`); für
  kuratierte Services könnten analoge Felder im `SERVICE_CATALOG`
  oder in den Component-Yamls sinnvoll werden, sobald die Praxis das
  nachfragt. Heute reicht der hardcoded Service-Render-Pfad im
  Generator.

## Verworfen

- **`/etc/claude-code/CLAUDE.md` im Container nutzen** — technisch
  möglich (Container hat eigenes `/etc/`, kein Host-MDM dort), aber
  das ist der Slot, an dem Unternehmen Policies deployen. Monoceros
  in diesen Pfad zu schreiben macht die Workbench in einem Org-
  Kontext zum Policy-Bypass-Werkzeug. Inakzeptabel als Default.
- **Briefing-Datei pro Projekt symlinken/kopieren** — würde Codex und
  Copilot zusätzlich abdecken, schreibt aber in jedes Projekt-
  Verzeichnis hinein. Konflikt mit projekt-eigener `CLAUDE.md`,
  `.gitignore`-Akrobatik, Risiko dass Monoceros-Dateien in fremde
  Repos eingecheckt werden. Per-Tool, per-Projekt opt-in via yml wäre
  denkbar, ist aber Folge-Entscheidung.
- **`.code-workspace`-artige Datei _im_ Projektverzeichnis** — gleicher
  Konflikt wie oben, plus Kollision mit Projekt-eigenen
  `.code-workspace`-Dateien.
- **Schreiben in `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` /
  `~/.gemini/GEMINI.md` im Container-Home als Default** — funktioniert
  unabhängig vom cwd, aber kollidiert mit User-Globals, die der User
  ggf. selbst pflegen will (`~/.claude` ist auch bind-gemountet, siehe
  ADR 0003). Als Workaround für die heute nicht abgedeckten Tools
  bleibt der Slot eine Option (siehe Offene Punkte), aber nicht als
  Default-Mechanismus für das Container-Briefing.
