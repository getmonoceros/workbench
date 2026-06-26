# ADR 0030: `monoceros share` - expose a workbench app to the LAN

- Status: accepted
- Date: 2026-06-25

## Context

The Traefik proxy (ADR 0007) serves a workbench's apps at
`http://<name>.localhost`, routed by Host header. `.localhost` resolves only on
the host (127.0.0.1), so the host browser works zero-conf - including HMR, since
the dev-server's live-reload socket follows the page on `:80`. But there is no
built-in way to view a workbench app on a **phone, tablet, or any other device
on the local network**: such a device can't resolve `.localhost` and can't send
that Host header, and the proxy answers nothing else (a request to
`http://<host-ip>` 404s). The workaround was a hand-rolled `monoceros tunnel`
per port plus framework-specific HMR juggling.

Two facts shape the fix:

- A **frontend dev server** is the only thing with a live-reload WebSocket;
  backends (Spring/.NET/Express) have none and are reached via the frontend's
  server-side `/api` proxy. So exposing the frontend port(s) is enough, and the
  HMR socket "just works" as long as it follows the page URL (not pinned).
- Multi-port disambiguation on the LAN would need per-app names a device can
  resolve (`<name>.local` via mDNS) - which means an OS-specific mDNS responder
  (macOS `dns-sd`, Linux `avahi`, Windows awkward). Heavy and platform-fragile.

## Decision

**`monoceros share <name> <app>` - a foreground, self-cleaning command that
forwards every configured port of the app to the LAN.**

- **All configured ports, from the launch config.** It reads
  `projects/<app>/.monoceros/launch.json` and, for **every target that declares
  a `port`**, opens a `0.0.0.0:<port>` forward into the workspace container -
  the same socat-sidecar mechanism `tunnel` uses (ADR 0009), bound to all
  interfaces and looped over the ports. **Not** filtered by `default` and
  **not** by run-state: the launch config is the source of truth (the central
  place the builder already sees apps/targets), so a manually-started
  non-default target (e.g. Storybook) is reachable the moment it starts. A
  forward to a not-yet-running target simply refuses connections until it comes
  up - no error, no restart of `share`.
- **Foreground, Ctrl+C stops.** Like `tunnel`. There is no persistent
  machine-wide state, so the LAN exposure lives exactly as long as the command
  runs - the safe default for "expose to the network". No `unshare` needed.
- **Reached by the host's LAN IP / `.local` name** on each port
  (`http://<host-ip>:<port>`). `share` prints the IP (from the host's network
  interfaces) and a best-effort `<hostname>.local` hint.
- **Opt-in command, not a yml flag and not always-on.** LAN exposure is a
  machine/environment decision, not a reproducible project setting (it does not
  belong in the container yml, which travels with the project - same reasoning
  as the proxy host port living in `monoceros-config`). A command also keeps
  `apply` strictly host-local: nothing is on the LAN until the builder says
  `share`.
- **Agent briefing convention.** An agent would not configure a dev server for
  the proxy/LAN on its own, so the generated AGENTS.md gains a "dev servers"
  convention: listen on `0.0.0.0`, accept the proxy/LAN hosts (Vite
  `allowedHosts`, Angular `--allowed-hosts`, CRA `DANGEROUSLY_DISABLE_HOST_CHECK`),
  do **not** pin the HMR socket (let it follow the page URL), and reach the
  backend via the dev-server proxy under a relative `/api`.

## Consequences

- A builder runs `monoceros share <name> <app>`, opens `http://<host-ip>:<port>`
  on their phone, and sees the app with working HMR - no Vite/CLI flags to
  remember, the briefing already steered the dev-server config.
- The dev-server settings the convention asks for are **dev-only** (`vite build`
  and friends ignore `server.*`), so they have no security or compatibility
  impact on a later deployment. Relative `/api` is also the prod-friendly
  same-origin choice, not a dev-only crutch.
- **One app per host LAN address at a time.** A bare IP / `.local` name on a
  port routes to one workspace; the foreground single-command model already
  implies that. Several apps reachable on the LAN at once would need
  mDNS-published per-workbench `<name>.local` names - deferred (Phase 2) because
  of the OS-specific responder cost, Windows especially.
- `share` complements rather than replaces `tunnel`: `tunnel` stays the tool for
  raw-TCP / non-HTTP access (DB clients, ad-hoc ports), `share` is the
  HTTP-apps-to-the-LAN front door.
- Ships in CLI 1.37.0. No runtime change (reuses the `tunnel` socat sidecar).
