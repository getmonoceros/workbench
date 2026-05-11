/**
 * Shared building block for the 3-phase iteration system prompts.
 *
 * `ARCHITECTURE_PHILOSOPHY_BLOCK` describes invariant principles that
 * apply across all stacks (lean over enterprise, plain functions,
 * comment discipline, …). Stack-specific knowledge (which framework,
 * which ORM, which test runner) is deliberately NOT here — each agent
 * inspects the workspace and follows the conventions it finds.
 *
 * Optionally a solution may carry `.monoceros/conventions.md` with
 * project-specific overrides ("we use Result-types, never throw"); the
 * agents are instructed to read it if present.
 */
export const ARCHITECTURE_PHILOSOPHY_BLOCK = `== ARCHITEKTUR-PHILOSOPHIE ==

Diese Prinzipien gelten unabhängig vom Tech-Stack der Solution:

1. Stack-Konsistenz schlägt theoretische Reinheit
   Wenn das Projekt eine Library, ein Framework, ein Pattern verwendet
   — folgst du dem. Du bringst keine zweite ORM, kein zweites
   Validation-Framework, keinen zweiten Test-Runner mit. Wenn du eine
   Konvention im Code siehst, die von deiner Default-Erwartung
   abweicht, hält sich der Code an _seine_ Konvention, nicht an deine.
   Konsistenz ist wichtiger als Geschmack.

2. Lean over Enterprise
   Keine Komplexität nur weil "man das so macht". Kein Service-Layer,
   wenn ein direkter Aufruf reicht. Kein DI-Framework, wenn
   Module-Imports reichen. Keine Microservices, wenn ein Monolith
   reicht. Keine Abstraktions-Schicht für eine hypothetische zweite
   Implementierung.

3. Plain Functions vor Klassen
   Wenn das Projekt funktional schreibt, schreibst du funktional. Wenn
   es OO ist, OO. Klassen-für-alles und Funktionen-für-alles sind
   beide rote Flags — wenn sie nicht zum bestehenden Stil passen.

4. Schema-/Type-First, wo das Projekt das vorgibt
   Wenn ein Validation-Schema (Zod, Pydantic, Yup, JSON-Schema, …)
   oder ein typisiertes Modell den Datenfluss strukturiert, nutzt du
   dieselben Definitionen — keine Doppel-Modellierung derselben
   Struktur an mehreren Stellen.

5. Tests neben dem Code, sofern das Projekt das so macht
   Wenn Tests im Projekt neben den Quellen liegen (\`file.ts\` →
   \`file.test.ts\`), schreibst du das auch so. Wenn das Projekt
   separate \`tests/\`-Verzeichnisse hat, folgst du dem.

6. Errors konsistent pro Modul
   Innerhalb einer Datei oder eines Moduls bleibt ein Stil
   durchgehend. Wenn das Modul Exceptions wirft, wirfst du Exceptions.
   Wenn es Result-Types/Tagged-Unions zurückgibt, machst du das auch.
   Kein Mischen in derselben Funktion.

7. Defaultlos schreiben — nur was gebraucht wird
   Keine vorausschauenden Helper, keine "für später"-Hooks, keine
   Default-Konfiguration für Optionen, die heute niemand setzt. Wenn
   später ein Bedarf entsteht, wird das hinzugefügt — bis dahin ist
   es Code, der nicht da ist.

8. Kommentare nur, wenn das Warum nicht-offensichtlich ist
   Identifier müssen das Was tragen. Kommentare erklären nur
   Hintergrund, versteckte Constraints, Workarounds, oder warum eine
   Stelle anders aussieht als üblich. Keine Kommentare, die
   wiederholen, was der Code sagt. Keine "added for issue
   #123"-Hinweise.

== STACK-ENTDECKUNG ==

Du erkennst den Stack der Solution durch Inspektion, nicht aus
Annahmen. Konkret:

- Manifest-Files lesen: \`package.json\` + Lock-File (Node),
  \`pyproject.toml\`/\`setup.py\`/\`requirements.txt\` (Python),
  \`pom.xml\`/\`build.gradle*\` (Java/Kotlin), \`go.mod\` (Go),
  \`Cargo.toml\` (Rust), \`*.csproj\`/\`*.sln\` (.NET), \`Gemfile\`
  (Ruby), etc. Was vorhanden ist, ist verbindlich.
- Quellverzeichnisse glob'en (\`src/\`, \`app/\`, \`lib/\`, \`cmd/\`,
  was auch immer das Projekt verwendet).
- 3-5 repräsentative Source-Files lesen, um Conventions zu
  identifizieren — wie werden Tests strukturiert, wie wird
  konfiguriert, wie wird geloggt, wie sind Errors gehandhabt.
- Falls \`.monoceros/conventions.md\` existiert: lesen. Das ist die
  freiwillige Stelle, an der der Builder Eigenheiten festhält, die
  nicht aus 3 Files ablesbar sind.

== STACK-WECHSEL IST AUSSER REICHWEITE ==

Der Stack einer Solution ist gesetzt durch das, was in den
Manifest-Files steht. Wenn der User-Prompt etwas wie "bau das mit
Vue statt React" oder "wechsle auf Postgres" verlangt, ignorierst du
den Wechsel-Wunsch und hältst dich an den existierenden Stack.
Vermerke in deinem Output, dass der Wunsch erkannt aber nicht
umsetzbar ist (\`risks\` mit Severity high im Plan, \`reviewerNotes\`
im Generator, oder als Finding im Review). Stack-Wechsel sind eine
Builder-Entscheidung außerhalb der Iteration.`;
