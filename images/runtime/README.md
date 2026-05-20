# Monoceros Runtime Image

Schmale Schicht über
`mcr.microsoft.com/devcontainers/typescript-node:22-bookworm`. Fügt
zwei Dinge hinzu:

1. **Claude Code CLI vorinstalliert** — spart die ~5–10 Sekunden,
   die `post-create.sh` sonst beim ersten `up` braucht.
2. **Egress-Whitelist via iptables** — der Container darf nur
   konkret erlaubte Hosts erreichen. Das ist die eigentliche
   Härtung; Architektur-Begründung in
   [ADR 0002](../../docs/adr/0002-egress-whitelist-runtime-image.md).

## Versionierung + Publish

Die Versionsnummer des Images steht in [`VERSION`](VERSION). Bumpen,
committen, nach `main` mergen — der
[`release-runtime`-Workflow](../../.github/workflows/release-runtime.yml)
baut dann multi-arch (`linux/amd64` + `linux/arm64`) und pusht nach
`ghcr.io/getmonoceros/monoceros-runtime:<version>`,
`:<major>` und `:latest`. Liegt die Version schon im Registry, wird
nichts neu gebaut (idempotent). Siehe
[ADR 0004](../../docs/adr/0004-release-modell-m4.md) für die Logik.

Per Default referenzieren generierte Dev-Container den Major-Tag
(`ghcr.io/getmonoceros/monoceros-runtime:1`), sodass kleinere
Bumps automatisch übernommen werden ohne `monoceros apply` erneut
laufen zu lassen.

## Lokaler Build (Contributors)

Vom Workspace-Root aus:

```sh
pnpm image:build      # erstmaliger / inkrementeller Build
pnpm image:rebuild    # gleiches mit --no-cache (z. B. nach iptables-Updates)
```

Beides ruft `docker build -t monoceros-runtime:dev images/runtime`
auf. Damit ein `monoceros apply` dann diese lokale Variante statt
des GHCR-Tags verwendet:

```sh
export MONOCEROS_BASE_IMAGE_OVERRIDE=monoceros-runtime:dev
monoceros apply <name>
```

Sobald die Variable wieder rausfällt (`unset` oder neue Shell), zieht
`apply` wieder den GHCR-Tag.

## Egress-Modi

Über die Env-Variable `MONOCEROS_EGRESS` steuerbar:

| Wert      | Verhalten                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `enforce` | Default. iptables-Rules aktiv, `OUTPUT`-Policy `DROP`. Nur Allowlist-Hosts erreichbar.                                         |
| `warn`    | Rules werden gesetzt aber Policy bleibt `ACCEPT`. Egress läuft durch, Counter sind sichtbar via `sudo iptables -L OUTPUT -nv`. |
| `off`     | iptables-Setup wird komplett übersprungen. Container hat unrestricted Egress.                                                  |

Ohne `cap_add: [NET_ADMIN]` im Compose-File loggt der Entrypoint eine
Warnung und fällt auf unrestricted Egress zurück — kein silent
fail-open.

## Allowlist anpassen

Pro Solution: Datei `.monoceros/egress-allow.txt` im Workspace
anlegen, eine Hostname pro Zeile. Wird beim Container-Start
zusätzlich zur Default-Liste eingelesen.

```text
# .monoceros/egress-allow.txt
internal-api.example.com
gitlab.intern.example
```

Default-Liste: [`egress-allow.default.txt`](egress-allow.default.txt).

## Bekannte Limitierung: CDN-IP-Drift

Hostnames werden **einmalig beim Container-Start** zu IPs aufgelöst
und als ACCEPT-Rules eingetragen. Hosts auf rotierenden CDNs (npm,
GitHub) können IPs wechseln, sodass Rules über die Lebenszeit eines
Containers veralten. Bei Auffälligkeiten: Container neu erzeugen
(`docker compose down && monoceros start`). Dauerhafte Lösung wäre
ein HTTPS-Forward-Proxy als Sidecar — vorgemerkt im Backlog unter
"HTTPS-Content-Filter".

IPv6 wird komplett geblockt, weil parallele unrestricted Egress sonst
durch `ip6tables` möglich wäre. Modernes Docker-Setup ist innerhalb
des Containers ohnehin meist IPv4-only.
