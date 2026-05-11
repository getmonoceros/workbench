# ADR 0003 — Claude-Invocation in der M2-Pipeline via Agent-SDK

- Status: accepted
- Datum: 2026-05-11

## Kontext

M2 baut die Plan/Generate/Review-Pipeline auf. Der Vorgänger im Archiv
ruft Claude pro Phase als CLI-Subprocess auf:

```
claude --print --output-format stream-json --allowedTools …
```

Siehe [iteration-orchestrator.ts:35-55](../../../monoceros-for-solution-builder_archive-2026-05-10/apps/api/src/lib/iteration-orchestrator.ts).
Die Stream-JSON-Events werden zeilenweise gelesen, die `session_id` aus
dem init-Event mitgeschnitten (für `--resume` in Phase 2), und das
finale Result-Text-Feld manuell als JSON geparst und _danach_ mit Zod
validiert. Kommentar in der Quelle (Zeile 672) hält fest: „claude-code
CLI doesn't enforce tool_use schemas" — Schema-Enforcement war
aufgepfropft, nicht eingebaut.

Seit dem Archiv-Stand gibt es das **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`, [Doku via Context7](https://context7.com/nothflare/claude-agent-sdk-docs/llms.txt)).
Anthropic positioniert es explizit als den Pfad für „CI/CD pipelines,
custom applications, production automation", während die CLI für
„interactive development, one-off tasks" gedacht ist. Unser
Orchestrator ist eindeutig Ersteres.

Vor dem ersten M2-Code-Commit muss entschieden sein, welche
Invocations-Mechanik die drei Phasen benutzen.

## Entscheidung

Die Pipeline ruft Claude über `@anthropic-ai/claude-agent-sdk` auf —
**nicht** über das `claude --print`-CLI.

Konkret nutzen wir aus dem SDK-API:

- `query({ prompt, options })` als AsyncIterator pro Phase
- `outputFormat: { type: 'json_schema', schema }` — Schema-Enforcement
  im SDK, kein manueller Parse-und-Zod-Schritt mehr im Orchestrator.
  Zod bleibt Source-of-Truth für die TypeScript-Typen, aber das
  JSON-Schema wird daraus generiert (z. B. via `zod-to-json-schema`)
  und ins SDK übergeben
- `systemPrompt` pro Phase (Planner/Generator/Reviewer)
- `allowedTools: string[]` typed (statt Komma-String)
- `resume: sessionId` für die Generator-Phase, falls Multi-Turn nötig
  (semantisch identisch zu `--resume`)
- `enableFileCheckpointing` + `rewindFiles(uuid)` als Basis für
  „Reviewer hat `reject` empfohlen → Generator-Änderungen verwerfen"
  — Mechanik, die im Archiv komplett fehlte

Provider-Wechsel (z. B. opencode) ist **explizit out-of-scope für M2**.
Statt einer Provider-Abstraktion wird der SDK-Aufruf an _einer_ Stelle
gekapselt — eine Funktion in `packages/core/src/runtime/`, die alle
drei Phasen aufrufen. Wenn opencode später einen vergleichbar
mächtigen programmatischen Mode bekommt und ein Tausch konkret wird,
ist das ein File-Touch, kein Refactor. Eine echte Provider-Strategy
würde heute zwangsläufig zum Lowest Common Denominator der
SDK-Features führen — also genau die Vorteile wegabstrahieren, deretwegen
das SDK gewählt ist.

## Begründung

- **`outputFormat: json_schema` ersetzt den schwächsten Punkt der
  Archiv-Pipeline.** Im Archiv waren spürbare Teile des Orchestrator-
  Codes „Stream-JSON-Zeilen lesen, Result-Event finden, JSON aus
  Text-Feld extrahieren, Zod-Retry bei Fehler". Das wird mit dem SDK
  ein Einzeiler pro Phase.
- **Typed Options statt Flag-Stringkonstruktion.**
  `allowedTools: ['Read','Edit','Bash']` ist refactor-bar und
  TypeScript-prüfbar. `'Read,Edit,Bash'` ist Magic-String.
- **File-Checkpointing füllt eine echte Archiv-Lücke.** Heute bleibt
  nach einer `reject`-Recommendation die kaputte Generator-Änderung
  im Workspace stehen. Mit `rewindFiles` kann der Orchestrator den
  Pre-Generator-Stand wiederherstellen, bevor er die Review-Findings
  schreibt.
- **`canUseTool`-Callback als Audit-Hook für später.** M2 braucht ihn
  nicht, aber die im Backlog vorgemerkten „Audit-Log Egress" und
  „MCP-Server-Whitelist" haben damit eine natürliche Anschlussstelle.
- **Anthropic-eigene Positionierung passt zum Use-Case.** Pipeline-
  Orchestrierung ist genau das, wofür das SDK existiert.

Risiken bewusst akzeptiert:

- Das SDK ist jünger als die CLI; Edge-Cases sind weniger gut
  dokumentiert. Wir akzeptieren, dafür ggf. eigene Recherche zu fahren.
- Wir binden uns enger an Anthropic-Release-Cadence. Da die CLI selbst
  Anthropic-spezifisch ist, ist das keine echte zusätzliche Bindung —
  nur ein engerer API-Touchpoint.

## Konsequenzen

- `packages/core` hängt `@anthropic-ai/claude-agent-sdk` als
  Runtime-Dependency ein.
- Das SDK spawnt intern weiterhin das `claude`-Binary. Heißt: der
  Orchestrator-Prozess muss in einer Umgebung laufen, in der `claude`
  verfügbar ist. Das `monoceros-runtime:dev`-Image hat es preinstalled
  — die Pipeline läuft also im Container. Implikation für die
  „Plugin- vs. CLI-Primat"-Frage: der **Plugin-Pfad ist der natürliche
  Default**, weil Claude Code selbst (und damit das Plugin) bereits
  im Container läuft. Eine separate ADR (0004) hält das fest, sobald
  die Frage final entschieden ist.
- Die Zod-Schemas (`IterationPlan`, `GeneratorReport`, `ReviewReport`)
  werden aus dem Archiv übernommen und ggf. an die neue Konzept-Sprache
  angepasst (Backlog M2 Task 2). Sie bleiben Source-of-Truth; das
  JSON-Schema-Pendant wird daraus generiert.
- Die Multi-Turn-Mechanik in Phase 2 (`--resume`) wird zu
  `resume: sessionId` umgemappt. Der Mechanismus, die `session_id`
  aus dem init-Event mitzuschneiden, entfällt — das SDK liefert sie
  als Feld am Message-Objekt.
- Stream-Forwarding für UX (z. B. „was tippt Claude gerade") läuft
  künftig über typed Message-Events (`type: 'user'`, `type: 'result'`,
  …) statt über Newline-delimited JSON.
- Backlog `M2 Task 1` und `Task 3` müssen passend formuliert werden
  (Iteration-Prompts portieren ohne CLI-Annahmen, Orchestrator als
  SDK-Konsument).
