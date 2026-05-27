# Beispiele

## Port-Probe-Server → eigenes Repo

Das frühere `serve-ports.mjs` (mehrere HTTP-Server in einem Prozess,
JSON-Antwort pro Port — zum Verifizieren von Traefik-Hostname-Routing)
ist in ein eigenes, öffentliches Fixture-Repo ausgelagert:

**[getmonoceros/monoceros-e2e-fixture](https://github.com/getmonoceros/monoceros-e2e-fixture)**

Damit lässt es sich direkt als `--with-repo`-Ziel verwenden (statt
„in den Container kopieren") und dient gleichzeitig als Fixture für
die automatisierten End-to-End-Tests.

### Verwendung über die Workbench

```sh
# Fixture beim Init in einen Container klonen + Ports vorbereiten:
monoceros init demo --with=node --with-ports=3000,5173,6006,9229 \
  --with-repo=https://github.com/getmonoceros/monoceros-e2e-fixture.git
monoceros apply demo

# Probe-Server im Container starten (landet unter
# projects/monoceros-e2e-fixture/):
monoceros run demo -- npm --prefix projects/monoceros-e2e-fixture run serve-ports
```

### Traefik-Smoke vom Host

```sh
monoceros port demo
#   http://demo.localhost          → 3000
#   http://demo-3000.localhost     → 3000
#   http://demo-5173.localhost     → 5173
#   http://demo-6006.localhost     → 6006
#   http://demo-9229.localhost     → 9229

curl -s http://demo.localhost/      | jq .port    # → 3000
curl -s http://demo-5173.localhost/ | jq .port    # → 5173
```

Vollständige Doku (Custom-Ports, Labels, erwartete Antwort) im
[Fixture-Repo-README](https://github.com/getmonoceros/monoceros-e2e-fixture#readme).
