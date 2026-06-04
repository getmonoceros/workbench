# Examples

## Port probe server → separate repo

The former `serve-ports.mjs` (several HTTP servers in one process,
returning a JSON response per port — for verifying Traefik hostname
routing) has been moved into its own public fixture repo:

**[getmonoceros/monoceros-e2e-fixture](https://github.com/getmonoceros/monoceros-e2e-fixture)**

That way it can be used directly as a `--with-repo` target (instead of
"copying it into the container"), and at the same time serves as a
fixture for the automated end-to-end tests.

### Use via the workbench

```sh
# Clone the fixture into a container at init time + prepare the ports:
monoceros init demo --with-languages=node --with-ports=3000,5173,6006,9229 \
  --with-repo=https://github.com/getmonoceros/monoceros-e2e-fixture.git
monoceros apply demo

# Start the probe server inside the container (ends up under
# projects/monoceros-e2e-fixture/):
monoceros run demo -- npm --prefix projects/monoceros-e2e-fixture run serve-ports
```

### Traefik smoke test from the host

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

Full documentation (custom ports, labels, expected response) in the
[fixture repo README](https://github.com/getmonoceros/monoceros-e2e-fixture#readme).
