# ADR 0013 — `monoceros apply` mit Phasen-Anzeige und Log-Datei

- Status: **accepted**
- Datum: 2026-06-03
- Umgesetzt in: 296dc39 (Step 1 — Log-Datei), cac6478 (Step 2 — Spinner + `--verbose` + Summary), Folge-Commits für Layout-Polishing + SIGINT-Handling.

> **Offen geblieben** (bewusst nicht gebaut, kein Bedarf):
>
> - **Pull-Skip via `docker image inspect`** — der Spinner mit Phase
>   `starting container…` deckt den Pull-Fall heute mit ab; die
>   irreführende `pulling…`-Phase taucht ohnehin nicht mehr separat
>   auf (wir starten direkt bei `starting container…`).
> - **Containerseitige Recovery bei SIGINT** — der Handler räumt
>   Spinner, Log und Cursor; der halb-erstellte Docker-Container wird
>   beim nächsten `apply` via `--remove-existing-container` / der
>   Compose-Pre-Cleanup eingesammelt. Aktive `docker rm -f`-Logik im
>   Handler wäre Race-anfällig (welcher Container existiert wann),
>   daher absichtlich nicht implementiert.

## Kontext

`monoceros apply` führt heute `@devcontainers/cli` als Subprozess aus
und streamt dessen Output 1:1 nach `stderr`. Das produziert pro Apply
zwischen den `▸ Container`- und `▸ Next steps`-Sections ein Block aus
ISO-Timestamp-Zeilen, dem vollständigen `docker run …`-Aufruf inkl.
metadata-JSON und dem postCreate-Output — fachlich korrekt, aber
unsortiert und für den Builder weder scanbar noch hilfreich. Eine
vorgeschaltete `ℹ`-Warnung kündigt heute zusätzlich an, dass der
erste Apply ~1–2 min dauert; die ist sinnvoll, taucht aber auch im
Erfolgsfall jedes Mal auf und konkurriert visuell mit echten Hinweisen.

Im **Fehlerfall** geht der eigentliche Fehlertext im selben Stream
unter — die `✘`-Meldung steht irgendwo zwischen tausend Timestamps.
Es gibt aktuell kein persistiertes Log, an das man den Builder
verweisen könnte ("schau mal hier rein").

## Entscheidung

Wir trennen **Statusanzeige** (knapp, im TTY) von **Rohlog**
(vollständig, auf Disk). Layout:

```
▸ Container

⠹ pulling runtime image…                       ← solange devcontainer-cli pullt
⠹ starting container…                          ← ab „Start: Run: docker run …"
⠹ running postCreate…                          ← ab „Running the postCreateCommand"
✔ container ready (1m 14s)

ℹ log: ~/.monoceros/container/<name>/logs/apply-<name>-2026-06-03T15-15-21.log
```

**Phasen-Detection.** Aus dem `@devcontainers/cli`-Output mappen wir
auf eine kleine Zustandsmaschine. Jeder Zustand zeigt einen kurzen
Text neben dem Spinner an — das ist der eigentliche Mehrwert: der
Builder sieht, _was_ gerade passiert, nicht nur _dass_ etwas passiert.
Erkannte Phasen (initiale Liste, erweiterbar):

| Trigger im Stream                              | Phase                      |
| ---------------------------------------------- | -------------------------- |
| `Pulling`/`Downloading` o.ä. vor `Start: Run:` | `pulling runtime image…`   |
| `Start: Run: docker build`                     | `building feature layers…` |
| `Start: Run: docker run`                       | `starting container…`      |
| `Running the postCreateCommand`                | `running postCreate…`      |
| `outcome":"success"` in der JSON-Endzeile      | → Erfolg                   |

Die Detection ist bewusst **fragil-aber-pragmatisch**: bricht ein
Match, fallen wir auf einen generischen „working…"-Text zurück. Der
Spinner bleibt korrekt, nur die Beschriftung wird ungenau. Das ist
besser als entweder gar kein Text (langweilig) oder ein vollständig
geparster Output (Wartungslast bei jedem devcontainer-cli-Update).

**Log-Datei.** Pfad:

```
~/.monoceros/container/<name>/logs/apply-<name>-<ISO-datetime>.log
```

- Unter `container/<name>/` — geht beim `remove` mit weg, paßt zum
  „alles unter container/<name>"-Modell.
- Im Unterordner `logs/` — perspektivisch landen dort weitere
  Audit-Logs (siehe Backlog-Eintrag „Audit-Logging").
- Dateiname enthält Befehl + Container-Name + Zeitstempel, damit
  der Pfad auch außerhalb seines Verzeichnisses selbsterklärend ist
  (`cat ~/Downloads/apply-foo-….log` bleibt eindeutig, wenn der Builder
  die Datei woandershin kopiert).
- Inhalt: vollständiger devcontainer-cli-stdout/stderr, dazu am
  Anfang ein kurzer Kopf mit Monoceros-Version, Container-Name,
  yml-Pfad, Host-Info und der **bisher in der TTY angezeigten
  Pull-Vorwarnung** (siehe unten).

**Vorwarnung umziehen.** Der heutige ℹ-Hinweis
(„Pulling runtime image and building feature layers. First apply
takes ~1–2 min …") wandert komplett ins Log. Im TTY ist er redundant,
weil der Spinner mit `pulling runtime image…` ohnehin sichtbar macht,
was passiert. Builder, die mehr Kontext wollen, finden den Hinweis
am Logkopf.

**Fehlerfall.** Bricht `devcontainer-cli` mit non-zero ab:

```
✘ postCreate failed (exit 1)

  npm ERR! code ELIFECYCLE
  npm ERR! errno 1
  …
  (letzte ~15 Zeilen stderr)

ℹ full log: ~/.monoceros/container/<name>/logs/apply-<name>-….log
```

Wir zeigen das **Tail** des Logs (nicht den ganzen Stream), damit die
Diagnose sofort sichtbar ist, aber der Scroll-Back nicht zugeschüttet
wird. Der Logpfad steht direkt darunter.

**`--verbose`.** `monoceros apply <name> --verbose` schaltet den
Spinner ab und streamt den devcontainer-cli-Output wie heute roh
nach stderr. Zweck: Workbench-eigenes Debugging, CI ohne TTY,
Bug-Reports gegen `@devcontainers/cli`. Die Log-Datei wird in diesem
Modus zusätzlich geschrieben — wer roh streamen will, will gewöhnlich
auch das Artefakt haben.

**TTY-Detection.** Ohne TTY (CI, Piped stdout) fallen wir
automatisch auf den `--verbose`-Modus zurück. Spinner in nicht-TTY-
Streams sind nutzlos und verschmutzen Logs.

**Pull vs. cached.** Vor dem `devcontainer up` führen wir
`docker image inspect ghcr.io/getmonoceros/monoceros-runtime:<tag>`
aus. Liegt das Image vor, überspringen wir die `pulling…`-Phase
optisch — der Spinner startet direkt bei `starting container…`.
Macht den Happy Path ruhiger und vermeidet die irreführende
Pull-Anzeige, wenn nichts gepullt wird.

## Konsequenzen

- Die `▸ Container`-Section ist im Erfolgsfall vier Zeilen lang
  (eine pro Phase, eine fürs `✔`, eine für den Logpfad) statt
  unbestimmter Block.
- Audit-Pfad ist etabliert — `container/<name>/logs/` ist der Ort, an
  dem Monoceros Lebenszeichen ablegt. Folge-Commands (`remove`,
  `add-feature`, `restore`) können hier mitloggen, ohne neuen
  Designentscheid.
- `--verbose` ist die einzige unterstützte Form, den Roh-Stream live
  zu sehen. Wer das gewöhnt ist, muss umdenken; im Gegenzug wird die
  Default-Ausgabe deutlich lesbarer.
- Phasen-Mapping ist eine kleine, abgrenzbare Komponente, die in
  Vitest mit aufgezeichneten devcontainer-cli-Outputs getestet werden
  kann (Fixture-Dateien checken wir mit ein).
- Bei einem Major-Update von `@devcontainers/cli` mit geänderten
  Log-Strings degradiert die Anzeige auf den Fallback-Text — Logfile
  bleibt korrekt, kein funktionaler Schaden.

## Verworfen

- **Volle strukturierte JSON-Erfassung des devcontainer-cli-Outputs**
  via `--log-format json` (falls jemals stabil verfügbar) — Mehrwert
  zu klein, Bindung an Upstream-Format zu eng. Heuristische
  Phasen-Detection reicht.
- **Logfile zentral unter `~/.monoceros/logs/`** statt pro Container
  — Logs überleben dann `remove`, aber: (a) Lifecycle-Frage (wer
  räumt auf?), (b) Auffinden ist schwerer ohne Index. Pro-Container
  ist der einfachere Default; ein zentrales Audit-Log kann später
  zusätzlich entstehen, ohne diese ADR zu invalidieren.
- **Spinner-Phasen ohne Beschreibungstext** — robuster, aber
  langweilig und unterscheidet sich nicht von einer simplen
  „working…"-Anzeige. Der ganze Sinn der Phasen ist die Information
  _was_ gerade läuft.
