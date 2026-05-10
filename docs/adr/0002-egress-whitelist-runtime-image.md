# ADR 0002 — Egress-Whitelist im Runtime-Image (iptables, hostname-Snapshot beim Start)

- Status: accepted
- Datum: 2026-05-10

## Kontext

Der Use-Case der Workbench ist „Claude Code läuft längere Zeit unter
geringer Aufsicht". Container-Isolation alleine reicht dafür nicht —
ein kompromittierter Agent kann beliebige HTTPS-Calls absetzen, npm-
Pakete ihre Telemetrie verschicken, und MCP-Server beliebige Hosts
erreichen. Das Konzept-Dokument
([`docs/konzept.md`](../konzept.md)) sieht daher Egress-Whitelisting
als Teil der Sicherheits-Differenzierung vor.

Das Vorgänger-Archiv hatte den Punkt in
[ADR 0005](../../monoceros-for-solution-builder_archive-2026-05-10/docs/adr/0005-container-sandbox-und-user-modell.md)
beschrieben, aber nie implementiert. Wir bauen die Komponente neu.

## Erwogene Optionen

1. **iptables im Workspace-Container** — `cap_add: [NET_ADMIN]`,
   Entrypoint setzt `OUTPUT`-Chain-Rules, Default-Policy `DROP`.
2. **HTTPS-Forward-Proxy als Sidecar** — eigener Compose-Service mit
   z. B. `tinyproxy`/`squid`, Workspace-Container hat
   `HTTPS_PROXY`-Env, direkter Egress sonst gesperrt. Proxy
   entscheidet pro `CONNECT`-Host.
3. **eBPF-basiertes Egress-Filtering** — präziser, aber benötigt
   Host-Kernel-Privilegien (`bpf` cap), schlecht portierbar zwischen
   Linux-Varianten und Apple-Silicon-Docker.
4. **Userspace-Library-Hook** (z. B. LD_PRELOAD über libc-DNS) —
   fragil, Bypass durch beliebige Static-Linkage.

## Entscheidung

**Variante 1 (iptables im Workspace-Container)** als v1.

Mechanik:

- Image basiert auf `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm`.
- Apt-Pakete `iptables`, `iproute2`, `dnsutils`, `gosu` zusätzlich.
- Default-Allowlist in `/etc/monoceros/egress-allow.default.txt` ins
  Image gebakt (Anthropic-API, npm-Registry, GitHub, ghcr, Debian-
  Repos, PyPI).
- Per-Solution-Override:
  `/workspaces/<solution>/.monoceros/egress-allow.txt`, beim Start
  zusätzlich gemergt.
- Entrypoint läuft als root, resolvt Hostnames zu A-Records via
  `getent ahostsv4`, fügt für jede IP eine `ACCEPT`-Rule in
  `OUTPUT`. Loopback, conntrack-related/established, DNS (UDP/TCP
  53), und RFC1918-Bereiche (Compose-Network) sind unconditional
  erlaubt. Default-Policy danach `DROP`.
- IPv6 wird komplett geblockt (`ip6tables -P OUTPUT DROP`), damit
  kein paralleler Egress-Pfad offen bleibt.
- Anschließend dropt der Entrypoint via `gosu node` auf den
  Unprivileged-User und exec'd `CMD`.

Drei Modi via `MONOCEROS_EGRESS`-Env:

- `enforce` (Default): Rules aktiv, Policy `DROP`.
- `warn`: Rules gesetzt, Policy bleibt `ACCEPT`. Counter via
  `iptables -L OUTPUT -nv` zeigen, wer was wohin schickt.
- `off`: Skip-Setup, unrestricted Egress.

## Begründung

Variante 1 ist die kleinste Implementation, die echten Schutz
liefert:

- **Im Image, nicht im Compose-Setup**: jede Solution erbt automatisch
  die Default-Härtung, ohne dass per-solution-`compose.yaml` Logik
  aktiv eingesetzt werden muss. Der Builder muss nur `cap_add:
[NET_ADMIN]` aufnehmen — der Rest ist Image-intern.
- **Kein Sidecar-Container**: keine zusätzliche Service-Definition,
  kein Proxy-Konfigurations-Drift, kein extra Entrypoint pro Solution.
- **Standard-Tooling**: `iptables` und `gosu` sind Linux-Bordmittel,
  keine Black Box.

## Konsequenzen

**Akzeptierte Trade-offs:**

- **CDN-IP-Drift**: Hostnames werden einmalig beim Container-Start
  aufgelöst. Hosts mit rotierenden CDNs (npm via Cloudflare, GitHub
  via Fastly) können IPs ändern, sodass die Rules über die
  Container-Lebenszeit veralten. Mitigation: Container regelmäßig
  neu erzeugen (`docker compose down && monoceros start`). Dauerhaft
  besser ist Variante 2 — siehe Migration weiter unten.
- **DNS unbeschränkt**: UDP/TCP 53 ist auf jede Adresse erlaubt,
  damit Hostname-Auflösung im laufenden Container funktioniert. Ein
  Angreifer mit Code im Container kann via DNS-Tunneling Daten
  exfiltrieren. Akzeptable Lücke für v1; sonst müssten wir einen
  In-Container-DNS-Resolver mit eigener Allowlist pflegen.
- **Privates Netz unbeschränkt**: RFC1918-Ranges sind ACCEPT, weil
  Compose-interne Services (postgres, redis) erreicht werden müssen.
  Bedeutet: ein bösartiger Agent könnte versuchen, andere lokale
  Compose-Stacks oder den Host (Docker-Bridge) anzugreifen. Akzeptiert
  weil das eine andere Threat-Class ist (lateral movement, nicht
  Egress).

**Migrations-Pfad zu Variante 2 (HTTPS-Proxy-Sidecar):**

Wenn (a) CDN-Drift zu Praxisproblemen führt oder (b) feinere
Inhaltskontrolle gewollt ist (siehe Backlog-Item „HTTPS-Content-
Filter"), wechseln wir auf Variante 2 als Layer **über** Variante 1.
Der Workspace-Container behält seine iptables-Rules, bekommt
zusätzlich `HTTPS_PROXY`/`HTTP_PROXY`-Env-Vars, und der Compose-
Stack erhält einen `egress`-Service mit Proxy-Software. Variante 1
bleibt als Schutz gegen Tools, die `HTTPS_PROXY` ignorieren.

## Verifikation

- Allowed Host (`api.anthropic.com:443`): `/dev/tcp` connect succeeds.
- Disallowed Host (`example.com:443`, `cloudflare.com:443`): connect
  blocked.
- Ohne `NET_ADMIN`: Entrypoint loggt Warnung, fällt auf unrestricted
  Egress zurück (kein silent fail-open).
- Override-Datei wird gemergt, zusätzliche Hosts kommen durch.
- `MONOCEROS_EGRESS=warn` und `=off` verhalten sich wie spezifiziert.
