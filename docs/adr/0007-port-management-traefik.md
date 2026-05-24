# ADR 0007 — Port-Management via Traefik-Singleton mit Hostname-Routing

- Status: accepted
- Datum: 2026-05-24

## Kontext

`monoceros apply` generiert heute eine `devcontainer.json`, in der
deklarierte Ports unter `forwardPorts` landen. Das funktioniert
ausschließlich, wenn der Container über die VS-Code-Devcontainers-
Extension geöffnet wird — VS Code parst `forwardPorts` und richtet
selbständig Port-Forwards ein. **Wird derselbe Container mit dem
reinen `@devcontainers/cli` (ohne VS Code) gestartet — der Pfad den
Monoceros nimmt —, wird `forwardPorts` ignoriert.** Folge: Apps im
Container sind vom Host-Browser nicht erreichbar, weder im
Image-Mode noch im Compose-Mode.

Für M5 Task 2 brauchen wir eine Lösung, die:

1. ohne VS Code funktioniert (Builder hat ggf. nur `monoceros shell`
   - Claude Code im Terminal)
2. **on-the-fly** wirkt — kein Container-Restart, kein `apply`-
   Rebuild, wenn der Builder einen weiteren Port öffnen will
3. **in der Container-yml persistiert** — spätere `apply`-Läufe
   stellen die Ports automatisch wieder her
4. mit mehreren laufenden Dev-Containern parallel funktioniert,
   ohne dass die sich Host-Ports streiten

Drei naheliegende Alternativen wurden verworfen:

- **`-p`-Mappings pro Container in die generierte Compose-yaml/
  devcontainer.json schreiben**: erfordert Rebuild bei jedem neuen
  Port (verletzt #2), und N Container mit gleichem internen Port
  (z. B. zwei Vite-Apps auf 5173) kollidieren auf dem Host (verletzt
  #4).
- **Ein Reverse-Proxy pro Container**: jeder Proxy belegt einen Host-
  Port → dasselbe Kollisions-Problem nur eine Schicht höher; plus N
  Proxy-Images im RAM.
- **Lokales DNS-Setup via `hosts`-File-Manipulation**: braucht root,
  ist OS-spezifisch, schwer reversibel — nicht akzeptabel für ein
  Tool, das sich als „dein Docker, deine Daten, kein Magic" anpreist.

## Entscheidung

**Ein einzelner Traefik-Container Docker-weit, Hostname-Routing über
`*.localhost`, Hot-Reload via File-Provider, Lifecycle gekoppelt an
die Dev-Container-Lifecycles.**

### Topologie

- Docker-Network `monoceros-proxy` (extern, von Monoceros verwaltet).
  Alle Dev-Container die Ports deklarieren, joinen es zusätzlich zu
  ihrem eigenen Compose-Network.
- Singleton-Container `monoceros-proxy` (Image `traefik:v3`), bindet
  Host-Port 80, lauscht im `monoceros-proxy`-Network.
- Dynamische Route-Configs unter `$MONOCEROS_HOME/traefik/dynamic/
<container>.yml`. Traefik's File-Provider picks Änderungen
  innerhalb ~100 ms ohne Restart.

### Hostname-Schema (RFC 6761 `*.localhost`)

- `<container>.localhost` → Default-Port des Containers (erster Eintrag
  in `ports:`)
- `<container>-<port>.localhost` → expliziter interner Port

Beispiel: Container `api` mit `ports: [3000, 9229]`:

- `api.localhost` → `http://api:3000` (Default)
- `api-3000.localhost` → `http://api:3000` (explizit)
- `api-9229.localhost` → `http://api:9229` (Debug-Port)

Belegter Host-Port: ausschließlich 80 (Traefik-Entrypoint `web`).
Mehrere Container parallel sind kollisionsfrei, weil Traefik via
HTTP-Host-Header routet, nicht via Port-Mapping.

### Lifecycle

Traefik ist nicht permanent — er startet automatisch wenn er
gebraucht wird und stoppt wenn keiner ihn mehr braucht. Keine
`--restart`-Policy, kein Hintergrund-Daemon. Steuerung über
deterministische CLI-Befehle:

- `monoceros apply <name>` mit `ports:` in der yml → `ensureProxy()`
  vor `devcontainer up`
- `monoceros start <name>` mit `ports:` in der yml → `ensureProxy()`
  vor dem Start
- `monoceros add-port <name> <port>` → `ensureProxy()` falls
  Container läuft + Hot-Reload-Datei schreiben
- `monoceros stop <name>` / `remove <name>` → `maybeStopProxy()`:
  wenn kein anderer Dev-Container mit Ports läuft, Traefik stoppen
  und Network abräumen

`stop` und `remove` werden gleich behandelt (Variante A aus der
Diskussion 2026-05-24): das einzige Kriterium ist „läuft noch ein
Port-Container im `monoceros-proxy`-Network". Variante B (stop hält
Traefik am Leben) wäre 1–2 Sekunden schneller beim Wieder-`start`,
schafft aber Inkonsistenzen (warum lebt Traefik wenn nichts läuft?).

`ensureProxy()` ist idempotent — läuft der Singleton schon, no-op.
Erster Aufruf nach Host-Reboot zahlt ~1 s Pull-Cache-Check + Start,
spätere Aufrufe sind no-op.

### Persistenz in der Container-yml

Neue Felder im Container-yml-Schema:

```yaml
ports:
  - 3000 # short form
  - port: 9229 # long form, optional alias/path-prefix später
ide:
  vscodeAutoForwardPorts: false # default: false
```

`vscodeAutoForwardPorts` landet als `"remote.autoForwardPorts": false`
in `customizations.vscode.settings`. Default `false`, weil Traefik die
einzige Quelle der Wahrheit für externe Erreichbarkeit sein soll —
sonst kriegt der Builder zwei URLs für dieselbe App
(`localhost:NNNNN` von VS Code + `<name>.localhost` von Traefik) und
muss sich merken welche zuverlässig ist. Reversibel pro Container,
wenn der Builder die VS-Code-Forwards explizit will.

### Discovery

`monoceros port <name>` listet die aktuellen URLs des Containers,
damit der Builder das Subdomain-Pattern nicht selbst konstruieren
muss. Ohne Args: alle Ports des genannten Containers. Mit
`--all`-Flag: alle Container-URLs auf einen Blick.

### `add-port` / `remove-port`

- `monoceros add-port <name> <port> [<port>…]` — idempotent, schreibt
  in die Container-yml (comment-preserving via bestehenden AST-
  Mutator), schreibt parallel die Traefik-Dynamic-Config (falls
  Container läuft), gibt die resultierende(n) URL(s) aus.
- `monoceros remove-port <name> <port> [<port>…]` — Spiegelbild,
  entfernt yml-Eintrag und Dynamic-Config-Block, ruft
  `maybeStopProxy()` auf wenn der letzte Port weg ist.

Beide folgen dem etablierten `add-*` / `remove-*`-Muster (Diff-
Vorschau, `--yes`-Flag, idempotent).

## Bewusst aufgeschoben

### TLS / HTTPS

Heute HTTP-only. Begründung:

- `*.localhost` ist im Browser als „potentially trustworthy"
  whitelisted → Service Worker, `crypto.subtle` etc. funktionieren
  auch ohne TLS
- Echtes HTTPS würde mkcert-CA-Installation in den System-Trust-Store
  des Hosts erfordern (macOS Keychain / Linux ca-certificates /
  Windows Cert Store — drei Wege, alle mit elevated Permissions)
- Die Traefik-Config wird so geschrieben, dass `entryPoints: [web]`
  explizit deklariert ist — additives Hinzufügen eines `websecure`-
  Entrypoints + `tls:`-Block pro Route ist später möglich, ohne
  Schema-Brüche

Re-Evaluation, wenn ein Builder einen konkreten Workflow nennt, der
HTTPS-Origin verlangt (Vite-HTTPS-Plugins, OAuth-Callbacks mit
festem `https://`-Redirect, PWA-Installation auf custom Host).

### TCP-Tunnel für Services

Hostname-Routing geht nur über HTTP. Direkt-Zugriff vom Host auf
TCP-Services (Postgres-Client, Redis-CLI) ist explizit **nicht**
Scope dieser ADR — siehe **M5 Task 3 (`monoceros tunnel`)** für die
Geschwister-Lösung via socat-Sidecar-Container.

### Migration bestehender Container

Es gibt keine Auto-Migration für Container, die vor M5 Task 2
materialisiert wurden. Monoceros ist im aktiven Entwicklungsstadium;
der dokumentierte Migrationspfad ist `monoceros remove <name>` →
`monoceros apply <name>`. Der README bekommt einen entsprechenden
Status-Banner („pre-1.x, breaking changes ohne Vorankündigung
möglich"), damit das nicht überrascht.

## Folgen

- **Neues yml-Schema** (`config/schema.ts`): `ports: (number | { port:
number; … })[]` und `ide.vscodeAutoForwardPorts: boolean`. Zod-
  Validierung + comment-preserving Schreibpfad.
- **Neuer Modul-Block** `proxy/` im CLI-Paket: `ensureProxy()`,
  `maybeStopProxy()`, `writeDynamicConfig(name, ports)`,
  `removeDynamicConfig(name)`, `joinProxyNetwork(containerId)`,
  `listenersFor(name)`.
- **Scaffold-Erweiterung** (`create/scaffold.ts` / Compose-
  Generator): wenn `ports:` nicht-leer, joine `monoceros-proxy`
  als externes Network in der generierten compose.yaml bzw.
  `runArgs: ["--network", "monoceros-proxy"]` im Image-Mode.
- **Neue CLI-Befehle**: `add-port`, `remove-port`, `port`.
- **Doku**: `docs/commands/{add-port,remove-port,port}.md` plus
  Übersichts-Update in `docs/commands/README.md`.
- **Test-Plan-Update** (M5 Task 4): Port-Strecke als Pflichtfall —
  `add-port` + Browser-Test via `<container>.localhost`, plus
  Lifecycle-Tests (Traefik-Start beim ersten Port-Container,
  Stop beim letzten).
- **README**: Status-Banner „pre-1.x, breaking changes ohne
  Vorankündigung möglich" als sichtbarer Block oben.

## Offene Mini-Frage für die Implementierung

`monoceros-proxy`-Container bind-mountet die Dynamic-Configs aus
`$MONOCEROS_HOME/traefik/dynamic/` — dieser Pfad muss zum Zeitpunkt
des `docker run` existieren, sonst legt Docker ihn als root-owned an
und die nachfolgende File-Writes durch den User schlagen fehl.
`ensureProxy()` legt das Verzeichnis vor dem Start explizit als
User-owned an. Triviales Detail, hier nur dokumentiert damit es im
Code nicht vergessen wird.
