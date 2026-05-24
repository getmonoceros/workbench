# Beispiele

Hilfsskripte für manuelle Tests gegen einen laufenden Dev-Container.
Kein Code aus diesem Verzeichnis wird vom CLI ausgeliefert oder
importiert — alles hier ist zum „Reinkopieren in den Container und
ausprobieren" gedacht.

## `serve-ports.mjs`

Drei (oder mehr) leichte HTTP-Server in einem Prozess. Jeder Server
antwortet mit JSON, das den eigenen Port, ein Label und Request-Metadaten
zurückgibt — damit man bei mehreren parallel laufenden Apps
zweifelsfrei sieht, welcher Port die Anfrage bedient hat.

Pure Node-stdlib, kein `npm install` nötig — funktioniert in jedem
Container, der Node ≥ 18 hat (was alle Workbench-Container haben).

### Verwendung

```sh
# In den Container kopieren (vom Host)
docker cp docs/examples/serve-ports.mjs <containerId>:/tmp/serve-ports.mjs

# Oder direkt in der monoceros shell-Session:
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/docs/examples/serve-ports.mjs \
  -o /tmp/serve-ports.mjs

# Defaults: 3000/api, 5173/frontend, 6006/storybook
node /tmp/serve-ports.mjs

# Custom Ports
node /tmp/serve-ports.mjs 8080 9000

# Custom Labels (Format `<port>:<label>`)
node /tmp/serve-ports.mjs 3000:api 5173:frontend 6006:storybook 9229:debug
```

### Erwartete Antwort

Jeder Endpoint antwortet auf jeden Pfad / jede Methode mit JSON
ähnlich:

```json
{
  "success": true,
  "port": 3000,
  "label": "api",
  "method": "GET",
  "path": "/",
  "host": "sandbox.localhost",
  "timestamp": "2026-05-24T11:42:00.000Z"
}
```

Das `host`-Feld zeigt den HTTP-Host-Header, mit dem die Anfrage
ankam — nützlich zum Verifizieren, dass Traefik via Hostname-Routing
zugestellt hat (`sandbox.localhost`, `sandbox-3000.localhost`, …)
und nicht via Port-Mapping.

### Typischer Smoketest gegen Traefik (ab M5 Task 2)

```sh
# Im Container:
node /tmp/serve-ports.mjs &

# Vom Host:
monoceros add-port sandbox 3000 5173 6006
monoceros port sandbox

# Sollte ausgeben (Beispiel):
#   http://sandbox.localhost          → 3000
#   http://sandbox-3000.localhost     → 3000
#   http://sandbox-5173.localhost     → 5173
#   http://sandbox-6006.localhost     → 6006

curl -s http://sandbox.localhost/      | jq .port    # → 3000
curl -s http://sandbox-5173.localhost/ | jq .port    # → 5173
curl -s http://sandbox-6006.localhost/ | jq .port    # → 6006
```
