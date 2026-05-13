# Design-Pivot: `/iterate` als autonomer Story-Abarbeiter

Stand: 2026-05-13 — _Diskussionsstand, noch nicht entschieden, noch
nicht in [konzept.md](konzept.md) eingearbeitet, noch kein ADR._

Diese Notiz hält den Stand einer Design-Diskussion fest, die mitten in
M2 entstand, als der erste Stage-E-Walkthrough lief. Sie ist die
Grundlage für einen möglichen Kurswechsel — sobald die zwei offenen
Fragen am Ende geklärt sind, wird konzept.md überarbeitet und ein ADR
geschrieben.

## Was den Pivot ausgelöst hat

Nach Stage E.1 (Plugin-Distribution via Marketplace ✓) und einem
ersten echten `/monoceros:iterate`-Lauf gegen eine bare
`sandbox`-Solution sind drei Probleme sichtbar geworden, die
zusammen das Produkt-Modell in Frage stellen:

1. **Rendering-Friction in Claude Code.** Der `summarizeOutcome`-
   Output passt nicht in das, was Claude Codes Slash-Command-Surface
   gut rendert. Markdown-Marker werden literal angezeigt; die
   Workaround-Lösung ist ein Plain-Text-mit-Unicode-Glyphen-Format
   in einer Code-Fence. Folge: Reviewer-Text bricht horizontal nicht
   um, nichts ist klickbar, Dateipfade und Slash-Command-Verweise
   sind reiner Text. Die parallel emittierte „klickbare" zweite
   Zeile von Claude doppelt Inhalte aus der Fence.

2. **`.monoceros/`-Akkumulation skaliert nicht.** Findings, Concerns,
   und Risks werden als einzelne Markdown-Files pro Item abgelegt.
   Nach einem Tag mit ~5-10 Iterationen liegen 30-50 Files in drei
   Folders. Subjektive Einschätzung des primären Builders: „Da
   schaue ich nie wieder rein." Das stellt Hypothese 1 aus
   konzept.md in Frage (Side-Topic-Material ist wertvoll und
   triage-würdig) — _bevor_ Stage E.5 die Hypothese formell
   bewerten konnte.

3. **Plan-Risiken sind funktionslos.** Der Planner produziert eine
   `risks`-Liste. Diese fließt _nicht_ in den Reviewer-Prompt ein,
   landet stattdessen direkt als persistente Markdown-Files in
   `.monoceros/risks/`. Wenn niemand sie liest (siehe Problem 2),
   sind sie tote Zeichen.

## Die alte Modell-Annahme (zur Erinnerung)

konzept.md geht davon aus, dass `/iterate` _eine_ Iteration ausführt
und der Builder zwischen Iterationen entscheidet, was als nächstes
passiert: weitermachen, triagieren, ablehnen. Side-Topic-Material
(Findings/Concerns/Risks) wird über mehrere Iterationen akkumuliert
und ist die Substanz, die M3 (Tracking-Adapter zu Linear/Jira)
sinnvoll macht.

Implizit dabei: der Builder ist nach jeder Iteration ein
Entscheidungs-Bottleneck.

## Die neue Idee — `/iterate` als autonomer Story-Abarbeiter

Statt einer Iteration pro Aufruf führt `/iterate` einen **bis zu N-mal
selbstheilenden Loop** aus Plan → Generate → Review. Der Loop endet,
sobald der Reviewer `approve` gibt _oder_ ein Stop-Kriterium greift
(siehe unten). Das Ergebnis wird in einen **PR** geschoben (oder
mindestens auf einen Feature-Branch lokal), wo der Builder als
Mensch reviewt — _nicht_ inline in Claude Code.

Konsequenzen:

- **Side-Topic-Memory entfällt komplett.** Keine
  `.monoceros/findings/`, `.monoceros/concerns/`, `.monoceros/risks/`
  Folders mehr. Nur `.monoceros/iterations/` bleibt als Audit-Trail.
- **Plan-Risiken bekommen ihre Funktion.** Sie fließen als explizite
  Check-Items in den Reviewer-Prompt — „Planner identified these
  risks, verify they're handled". Sie persistieren danach nirgendwo.
- **Slash-Commands schrumpfen** von vier (`iterate`, `findings`,
  `triage`, `defer`) auf eins (`iterate`). `findings`, `triage`,
  `defer` werden gelöscht.
- **M3 (Tracking-Adapter) entfällt.** Keine Side-Topics → kein
  Tracking-System nötig.
- **Die Rendering-Problematik in Claude Code löst sich am Rand mit.**
  Die finale Builder-Surface ist der PR-Diff im Git-Hoster, nicht das
  CC-Chat-Fenster. Wir hören auf, CC zu einer Review-UI biegen zu
  wollen, die es nie sein wird.

## Was sich konkret in der Codebasis ändern würde

- `packages/core/src/orchestrator/pipeline.ts` → Loop bis zu N
  Iterationen, Reviewer-Findings als Input für den nächsten Plan-Lauf
- `packages/plugin/src/iterate.ts` → verliert `appendFinding/Concern/Risk`,
  behält nur `appendIteration` für Audit
- `packages/plugin/commands/{findings,triage,defer}.md` → gelöscht
- `packages/core/src/...` → Reviewer-Prompt erweitert um drei
  explizite Aspekte (ACs, Code-Qualität, Security) plus „diese
  Plan-Risks abprüfen"
- Neu: `gh`-Bridge im Plugin/CLI für PR-Open. Optional aktivierbar
  (siehe Frage B)
- [`docs/konzept.md`](konzept.md) → großer Rewrite, Side-Topic-Memory raus,
  autonome Loop rein
- [`docs/backlog.md`](backlog.md) → M2 reshape, M3 streichen, evtl. neuer M5
  für PR-Integration falls nicht in M2 untergebracht

## Stop-Bedingungen für den Loop (Entwurf)

Vier Stop-Bedingungen, alle nötig:

1. **`approve`** durch Reviewer → fertig, PR wird vorbereitet
2. **N Iterationen ausgeschöpft** (Default 3-4) → an Builder zurück
   mit „bin nach N Versuchen nicht durchgekommen, hier ist der letzte
   Stand, hier sind die ungelösten Reviewer-Findings"
3. **Cost-Budget überschritten** (Default-Vorschlag: $5) → gleicher
   Übergabepunkt
4. **Hartes `reject`** durch Reviewer (z. B. „Prompt ist fundamental
   unklar") → Loop kippt sofort, bevor Tokens verbrannt werden

## Offene Design-Fragen — zu klären, bevor Code/Konzept

### Frage A — Wie groß ist eine „Story" für `/iterate`?

Heute ist der Test-Prompt ein Einzeiler (`"Add a greet command"`).
Die neue Idee redet von Story-Größe (mehrere ACs, evtl. Dependencies,
Manntage-Niveau).

Das ändert die Pipeline-Erwartung radikal:

- Story = 1-2 Stunden Tipparbeit → 3-4 Iter à 6min komfortabel
- Story = halber Tag → 3-4 Iter knapp, evtl. höhere Iter-Zahl nötig
- Story = mehrere Tage → fragwürdig, ob das autonom überhaupt geht

**Zu entscheiden:** Welcher Zielbereich? Davon hängt N, das Budget
und die Erwartungshaltung an die Selbstheilung ab.

### Frage B — Was ist die Mindest-PR-Surface für den MVP?

Drei Stufen denkbar:

1. **Lokaler Feature-Branch** (immer). Loop committet auf Branch,
   Builder mergt manuell. Kein `gh`-auth nötig, kein Remote nötig.
2. **Remote-Push** (Opt-in). Solution hat ein Git-Remote, Loop pusht
   den Branch dorthin. Push-Auth liegt in der Solution.
3. **PR via `gh`** (Opt-in). Zusätzlich öffnet der Loop einen PR mit
   Reviewer-Summary als PR-Body. Braucht `gh` im Container plus
   Auth.

**Zu entscheiden:** Was ist Pflicht für den MVP? Was wird Opt-in?
Mein Vorschlag wäre: (1) Pflicht, (2)+(3) Opt-in über
`stack.json`-Config.

## Was nicht in dieser Notiz steht — bewusst

- Keine Detail-Spezifikation der neuen Reviewer-Prompts. Kommt
  erst beim Konzept-Rewrite, sobald A und B geklärt sind.
- Keine konkrete PR-Body-Template-Festlegung.
- Keine Migration-Strategie für existierende `.monoceros/findings/`
  etc. — die sind heute leer / nur Test-Artefakte, daher kein
  Migration-Problem.

## Nächste Schritte (in Reihenfolge)

1. Fragen A und B beantworten — in einer separaten Session, _nach_
   der geplanten Dev-Container-Verbesserungs-Runde, mit Kopf frei
2. konzept.md neu schreiben mit dem PR-zentrierten Modell als Skelett
3. backlog.md anpassen: M2 reshape, M3 streichen
4. ADR schreiben (vermutlich „ADR 0003: `/iterate` als autonomer
   Loop statt Single-Iteration"), das diese Notiz als Quelle zitiert
5. Code anfassen — Pipeline-Loop, Reviewer-Prompt-Update,
   Plugin-Command-Cleanup, gh-Bridge
