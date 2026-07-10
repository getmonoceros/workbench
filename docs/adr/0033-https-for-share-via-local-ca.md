# ADR 0033: HTTPS for `monoceros share` via a machine-local CA

- Status: accepted
- Date: 2026-07-10

## Context

`monoceros share` (ADR 0030) forwards an app's ports to the LAN as plain HTTP,
reached by the host's LAN IP or `<hostname>.local` (`http://<host>:<port>`). That
is enough to _look_ at an app on a phone, but it breaks the exact case `share`
is pitched for: a **phone-first, installable PWA**.

The reason is the browser's **secure-context** rule, not our code. A page is a
secure context only over `https` **or** on the localhost family (`localhost`,
`*.localhost`, `127.0.0.1`). A bare LAN IP or a `.local` name over `http` is an
**insecure context**, and browsers switch off the APIs a PWA needs there:

- `crypto.subtle` is `undefined` - so an OIDC/PKCE login (SHA-256 code
  challenge) throws before it can even redirect to the IdP. This is the concrete
  symptom that surfaced with a Keycloak login over `share`.
- Service Worker registration is refused - so no offline, no cache, no push, and
  the PWA is **not installable**.

The desktop escapes this because it reaches the app via the Traefik proxy at
`http://<name>.localhost`, and `*.localhost` is a secure context even over HTTP
(ADR 0007). The phone over the LAN has no such exemption. So `share` is
structurally unable to serve an installable PWA today.

Publicly-trusted certificates do not solve this locally:

- A public CA (Let's Encrypt) will **never** issue for `.local` names or private
  IPs. It requires a publicly-registered domain.
- The only no-inbound-port path (ACME **DNS-01** against an owned domain pointed
  at a private IP) needs a registered domain plus DNS-provider API credentials
  wired into Monoceros, runs into home-router DNS-rebinding protection, and
  publishes every dev hostname into Certificate Transparency logs. That drags a
  local-first tool onto an owned-domain + external-DNS dependency.
- Public tunnels (ngrok, cloudflared) hand you trusted HTTPS but route traffic
  through third-party SaaS, contradicting the core promise that nothing leaves
  the machine.

## Decision

**Terminate TLS inside the `share` sidecar using a leaf certificate issued by a
persistent, machine-local CA.**

- **Persistent local CA.** A root CA lives under `$MONOCEROS_HOME/ca/`
  (`rootCA.pem` + `rootCA-key.pem`), created lazily on the first `share` that
  needs it and reused forever after. It is **not** regenerated per invocation -
  the whole value is that a device trusts the root **once**. The private key
  never leaves the host.
- **Per-host leaf certificate.** A CA-signed server cert is cached under
  `$MONOCEROS_HOME/certs/`. Its SAN must cover every name/address a client might
  type: the mDNS `<hostname>.local` name, the LAN IP as an `IP:` entry, plus
  `localhost`/`127.0.0.1`. It is reissued when the SAN set changes (e.g. the LAN
  IP moves).
- **An HTTP-aware terminator (Caddy), not socat.** `share`'s terminator is a
  single pinned Caddy sidecar (`caddy:2.11.4`) that publishes every shared port,
  terminates TLS with the leaf cert (mounted read-only), and reverse-proxies to
  the workspace container. socat (which `tunnel` keeps for raw TCP) can
  terminate TLS but is a byte-level forward - it cannot inject HTTP headers, so
  a scheme-sensitive backend behind it never learns the request was https and
  stamps `http://` URLs (Keycloak's issuer being the concrete failure). Caddy's
  `reverse_proxy` sets `X-Forwarded-Proto` / `X-Forwarded-Host` and preserves
  the incoming `Host`, so the backend can reconstruct the browser's real origin.
  Only `share` terminates TLS; `tunnel` is unchanged.
- **The Keycloak service is configured to honor the forwarded scheme.** The
  bundled Keycloak descriptor starts with `--proxy-headers=xforwarded` (KC 26),
  so it derives the issuer host + scheme from `X-Forwarded-*`. Without this,
  Keycloak ignores the header and uses the raw connection scheme (always http
  behind the terminator). This is safe on the desktop Traefik path too, which
  already sends `X-Forwarded-Proto: http` - the issuer stays consistent there.
- **Self-contained cert generation.** Certificate issuance is pure-JS and
  bundled into the CLI, with no dependency on a host `openssl`/`mkcert` binary,
  consistent with single-binary packaging (ADR 0032). `mkcert`, if present, is
  at most an optional convenience for host trust - never required.
- **One manual step, made explicit.** Installing `rootCA.pem` as trusted on each
  **viewing device** (the phone) is inherent to staying local and cannot be
  automated away. `share` prints the CA path and a one-time hint. Monoceros does
  **not** silently install the root into the host or system trust stores.
- **Proxy untouched.** The machine-wide Traefik singleton (ADR 0007) and the
  host `.localhost` path are not changed. HTTPS is added entirely within the
  `share` code path.

## Consequences

- A phone that trusts the root CA reaches `https://<hostname>.local:<port>` as a
  **secure context**: `crypto.subtle`/PKCE logins, service workers, and PWA
  installability all work. `share` becomes usable for the phone-first PWA case
  it was built for.
- The one-time per-device CA install is the deliberate price of "trusted HTTPS
  without anything leaving the machine". It is surfaced in the `share` banner,
  not buried.
- **Rejected alternatives:**
  - _Self-signed, click through the warning_ - reaches a secure context (login
    would work) but browsers still refuse Service Worker registration on a cert
    error, so the installable-offline PWA stays dead. Not a real fix.
  - _Let's Encrypt via DNS-01_ - technically trusted and portless, but needs an
    owned domain + DNS API credentials and inherits rebinding/CT problems;
    rejected as against local-first.
  - _Public tunnel (ngrok/cloudflared)_ - trusted HTTPS via third-party SaaS;
    rejected as against "nothing leaves the machine".
  - _Unify HTTPS on the Traefik proxy (`:443`, name-routed)_ - cleaner URLs but
    mDNS resolves only the host's own `<hostname>.local`, not per-app subnames,
    so multi-app name routing on the LAN buys a name-resolution problem. Keeping
    `share` port-based sidesteps it.
- **A scheme-sensitive backend reached over `share` works out of the box.** The
  phone hits `https://<host>:<port>` → Caddy (XFP=https) → the app → Keycloak
  (`--proxy-headers=xforwarded`) stamps an `https://` issuer that matches the
  browser, so the OIDC token exchange succeeds. The app itself needs no change
  if it forwards `X-Forwarded-*` to its backends (a same-origin dev-proxy
  pattern). Existing containers pick up the new Keycloak command on the next
  `monoceros apply`.
- **No dev-container runtime image change**, but `share` gains a pinned Caddy
  image dependency (pulled on first use). A forward to a not-yet-running target
  now returns a Caddy `502` rather than a refused TCP connection - a cosmetic
  change from the socat behavior in ADR 0030.
- **Why not keep socat + TLS.** socat can terminate TLS (`OPENSSL-LISTEN`) but
  cannot add `X-Forwarded-*`, so it cannot fix the scheme problem for any
  backend that builds absolute URLs (OIDC issuers, redirects, Secure cookies).
  An HTTP-aware terminator is required, not optional.
- **HTTP/3 is disabled on the terminator** (`protocols h1 h2`). Caddy enables
  HTTP/3 by default and advertises it via `Alt-Svc`; iOS/WebKit then retries a
  token-endpoint `POST` over HTTP/3 and fails with
  `NSURLErrorRequestBodyStreamExhausted`, breaking the OIDC token exchange.
  HTTP/3 buys nothing on a LAN dev forward, so it is turned off.
- Bundled in the same change: `share` now derives the mDNS name from
  `scutil --get LocalHostName` on macOS (the authoritative Bonjour name, which
  can diverge from `os.hostname()` after a LAN name collision), and shows the
  `.local` name on the primary lines with the raw IP as the fallback line.
- Target: CLI 1.38.0.
