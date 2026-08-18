# ADR 0051: One declaration carries a service to the LAN and to the proxy

- Status: accepted
- Date: 2026-08-18
- Relates to: [ADR 0007](0007-port-management-traefik.md) (the shared
  Traefik singleton and the routing model this extends),
  [ADR 0030](0030-share-app-to-lan.md) (the share contract this widened, amended
  the same day),
  [ADR 0033](0033-https-for-share-via-local-ca.md) (why `share` terminates TLS
  with a Caddy sidecar),
  [ADR 0009](0009-tcp-tunnels-foreground-sidecar.md) (the raw-TCP forward that stays the answer
  for everything not HTTP),
  [ADR 0019](0019-component-taxonomy-service-feature-dependency.md) (what
  becomes a service in the first place)

## Context

A workbench's services were reachable from inside the container and nowhere
else. Both ways out went to the workspace only: `routing.ports` produces
Traefik routes to `http://<name>:<port>`, and `monoceros share` published the
ports an app declared in its launch config. A service was left with
`monoceros tunnel`, a foreground command per service and per session.

That gap showed up as a real failure rather than an inconvenience. An app shared
to a phone cannot log in when the Keycloak it delegates to is unreachable from
that phone: the OIDC issuer the browser gets back names an address the device
cannot resolve. The workaround was to have the app's own dev server proxy the
login endpoints under a relative path, which every project then reimplements.

## Decision

**A service declares one HTTP port, `httpPort`, and that single declaration
feeds both channels**: `monoceros share` offers it on the LAN over HTTPS, and
the Traefik proxy writes a permanent route to it.

It is a port and not a flag. `defaultPort` is the port the machine talks to, and
the two differ exactly where it matters: Mailpit's `defaultPort` is 1025 (SMTP)
while its inbox is 8025, RustFS declares 9000 (the S3 API) while its console is 9001. A boolean with a fallback to `defaultPort` would have put SMTP and an S3
API on the network.

The catalog owns the value and bakes it into the yml at expand, like every other
visible service field. So the builder sees the line, can delete it to keep one
workbench's instance to itself, and can add it to a hand-written service. A
service without the field is never shared and never routed, which is the answer
for every backing store: both channels are HTTP, and a database behind them
answers nonsense. Raw TCP stays with `monoceros tunnel`.

**An exposed service joins the machine-wide `monoceros-proxy` network under the
alias `<workbench>-<service>`**, and its route matches
`<workbench>-<service>.localhost`. The prefix is not cosmetic: that network is
shared by every workbench on the machine, so two of them running keycloak would
both answer to a bare `keycloak` alias and Traefik would resolve whichever
replied first.

**The bare `<name>.localhost` stays with the first entry of `routing.ports`.** A
service never takes it, so adding one cannot move an address the builder already
uses. Handing it to a reverse proxy is an explicit choice we have not needed
yet; when it is needed, it is an additive field on the service entry rather than
a rule that guesses between two exposed services.

**The proxy's lifecycle keys on ports OR an exposed service, everywhere it used
to key on ports.** `apply` and `start` bring the singleton up and write the
routes file for either; `add-port` / `remove-port` no longer delete that file or
offer the proxy for teardown while a service is still exposed. `stop` and
`remove` needed no change, because `maybeStopProxy` counts the containers
attached to the network and a service container joining it counts correctly.

## Consequences

A workbench can be fully reachable with no `routing.ports` at all, which is what
a workbench fronted by its own reverse proxy looks like. Several commands had
assumed a port list was the only source of routing, and each had to learn the
second one: `status` shows the route on the service's own row (an address of a
sibling container, not one of the workspace's ports, so deliberately not in the
Ports section), and `check` reports the "route exists, backend unreachable" case
for a service the way it already did for the workspace.

`monoceros port` stays about `routing.ports`. A service route is not a port
mapping, and mixing the two in one listing would blur the distinction the rest
of the model keeps.

Network membership is fixed when a container is created, so a service that gains
its `httpPort` after the last apply is routed but unreachable until the next
one. That is the case `check` names. Unlike `add-port`, which promises a hot
route and therefore joins a running container to the network itself, no hot path
is needed here: a service change is a yml change, and the compose file it lands
in is written at apply anyway.

A deferred service (ADR 0025, Keycloak) has its route before it finishes
starting, so the address answers 502 for a few seconds after an apply.
