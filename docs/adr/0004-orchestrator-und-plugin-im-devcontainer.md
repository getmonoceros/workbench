# ADR 0004 — Orchestrator und Plugin laufen im Devcontainer, nicht am Host

- Status: accepted
- Datum: 2026-05-11

## Kontext

Aus der M2-Vorab-Notiz waren zwei Design-Fragen offen, die eng
zusammenhängen:

- **Wo läuft der Orchestrator** (Plan/Generate/Review-Pipeline)?
  Im Container oder am Host?
- **Plugin- oder CLI-Primat**? `/iterate`-Slash-Command in Claude Code
  oder `monoceros iterate`-CLI als erster Eingang?

Mit [ADR 0003](0003-claude-invocation-via-agent-sdk.md) ist
festgelegt, dass die Pipeline `@anthropic-ai/claude-agent-sdk` nutzt.
Das SDK spawnt intern das `claude`-Binary — der Orchestrator-Prozess
muss also dort laufen, wo `claude` verfügbar ist.

## Entscheidung

**Es läuft grundsätzlich nichts am Host. Alles, was die Workbench tut,
passiert im Devcontainer.** Das ist eine Workbench-weite Invariante,
nicht nur eine M2-Entscheidung.

Daraus folgt für M2:

1. **Orchestrator läuft im Container.** Konkret im selben Container,
   in dem Claude Code selbst läuft — also im Workspace-Container
   (`monoceros-runtime:dev`-Image), nicht in einem zusätzlichen
   Sidecar.
2. **Das Claude-Code-Plugin ist der primäre Eingang.**
   `/iterate <prompt>` ist die Erst-Implementierung der Pipeline. Da
   Claude Code im Container läuft, läuft das Plugin und damit der
   Orchestrator automatisch im richtigen Kontext.
3. **CLI-Bridge `monoceros iterate` ist out-of-scope für die erste
   M2-Implementierung.** Falls sie später kommt, wird sie ein dünner
   Wrapper über `monoceros run -- …` — sie führt die Pipeline auch
   dann im Container aus, nicht am Host.

Host-CLI-Commands wie `monoceros create`, `monoceros shell`,
`monoceros start` sind und bleiben **Steuer-Kommandos**, die mit
Docker und `@devcontainers/cli` reden. Sie tun keine Arbeit, die
das Solution-Repo verändert oder Claude aufruft — diese Arbeit
passiert hinter `devcontainer exec` im Container.

## Begründung

- **Sicherheitsmodell.** Der zentrale Wert der Workbench ist die
  abgesicherte Sandbox ([`docs/konzept.md`](../konzept.md), Abschnitt
  „Devcontainer-Sandbox"). Sobald Pipeline-Code am Host läuft,
  durchlöchert das den Sandbox-Anspruch — Claude-generierter Code
  könnte über Orchestrator-Pfade auf Host-Ressourcen wirken.
- **Kein Host-Setup-Burden.** Der Host braucht keine Node-Toolchain,
  kein `claude`-Binary, keine SDK-Dependencies. Der Builder
  installiert genau eine Sache (`@monoceros/cli`), die mit Docker
  redet. Alles andere lebt im Image.
- **Plugin-Pfad ist der natürliche Zugang.** Claude Code läuft im
  Container, Slash-Commands werden dort registriert, der Orchestrator
  ist eine TypeScript-Library, die das Plugin im selben Prozess
  importiert. Kein IPC, kein Bridge-Protokoll, keine doppelte
  Auth.
- **CLI-Bridge ist nachholbar, nicht blockierend.** Sobald das
  Plugin steht und die Pipeline kennt, ist `monoceros iterate`
  ein 30-Zeilen-Wrapper. Es _zuerst_ zu bauen würde die API-
  Annahmen über den Plugin-Eingang vorwegnehmen, ohne den Beweis
  zu haben, dass sie tragen.

## Konsequenzen

- `packages/plugin` ist der Build-Schwerpunkt von M2. `packages/core`
  hält Orchestrator + Schemas, das Plugin importiert ihn.
- Der Backlog-Task „CLI-Bridge" wird zu **nicht in M2 enthalten**
  abgeräumt und in „Vorgemerkt für später" verschoben — sobald das
  Plugin sich in echten Iterationen bewährt hat, kann es bei Bedarf
  nachgezogen werden.
- Die Workbench-CLI (`packages/cli`) bekommt in M2 **kein**
  `iterate`-Subcommand. Damit bleibt die CLI in ihrer M1-Rolle:
  Lifecycle, Lifecycle, Lifecycle — und nichts, was Code im Workspace
  ändert.
- `.monoceros/findings/*.md` etc. werden vom Orchestrator _aus dem
  Container_ ins gemountete Workspace-Volume geschrieben. Pfad-
  Auflösung erfolgt relativ zum Container-`workspaceFolder`, nicht
  zu einer Host-cwd.
- Logging/Stream-Forwarding für UX läuft über Claude-Code-eigene
  Channels (Plugin-Output-Surface), nicht über ein eigenes
  Host-Terminal.
- Diese Invariante („Host tut nichts Inhaltliches") wird Teil der
  Workbench-Konventionen. Falls in Zukunft echte Gegenargumente
  auftauchen (z. B. Performance, OS-spezifische Tools), ist eine
  Folge-ADR notwendig — kein Stillschweigender Bruch.
