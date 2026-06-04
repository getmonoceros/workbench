# ADR 0002 — Egress whitelist in the runtime image (iptables, hostname snapshot at startup)

- Status: deferred (mechanism is in the image, but **default = off** since 2026-05-10)
- Date: 2026-05-10

## Update 2026-05-10 — Why deferred now

The mechanism (iptables allowlist built from a hostname snapshot at
startup) is included in the image and verified for static targets. In
practice it breaks in two places that make up our primary workflows:

1. **VS Code Dev Containers**: the VS Code Server pulls extensions
   (Marketplace + rotating `*.vscode-unpkg.net` CDN IPs) and
   settings-sync data. A hostname snapshot does not capture CDN
   rotation — the result is minutes-long TCP timeouts on the first
   reopen, with some extension installs failing outright. Even with an
   extended allowlist, the filter does not work reliably.
2. **VS Code Claude Code extension**: it does _not_ call the
   `/usr/local/bin/claude` binary but has its own stack via
   `@anthropic-ai/claude-agent-sdk` with its own subprocess spawns.
   As a result, neither a UID-based filter (the extension runs as
   `node`, like everything else in the VS Code Server) nor a wrapper
   around the CLI applies.

**Consequence:** the entrypoint's default mode switches to `off`. The
mechanism stays in the image (for CI / headless / explicit opt-in via
`enforce`), but new solutions are no longer egress-filtered by
default. This lets the VS Code workflow run undisturbed.

**What's next:** two options are tracked in the backlog:

- **Audit log** instead of block: low-effort — a DNS and/or iptables
  LOG target records what goes out. No action on the traffic, just
  observability. Provides material for later.
- **HTTPS forward proxy sidecar**: the structurally correct solution,
  because it re-resolves hostnames per request and applies regardless
  of the caller's context. Becomes relevant when the protection need
  rises again (multi-user, public release).

The original decision below remains as documentation — it correctly
describes what lives in the image. It is just no longer the default.

---

## Context

The workbench's use case is "Claude Code runs for an extended time
under light supervision." Container isolation alone is not enough for
that — a compromised agent can make arbitrary HTTPS calls, npm
packages can send their telemetry, and MCP servers can reach arbitrary
hosts. The concept document
([`docs/concept.md`](../concept.md)) therefore foresees egress
whitelisting as part of the security differentiation.

A predecessor version had already described the point but never
implemented it. We are building the component anew.

## Options considered

1. **iptables in the workspace container** — `cap_add: [NET_ADMIN]`,
   the entrypoint sets `OUTPUT` chain rules, default policy `DROP`.
2. **HTTPS forward proxy as a sidecar** — a separate Compose service
   using, e.g., `tinyproxy`/`squid`; the workspace container has an
   `HTTPS_PROXY` env, with direct egress otherwise blocked. The proxy
   decides per `CONNECT` host.
3. **eBPF-based egress filtering** — more precise, but requires
   host-kernel privileges (`bpf` cap), poorly portable across Linux
   variants and Apple Silicon Docker.
4. **Userspace library hook** (e.g., LD_PRELOAD over libc DNS) —
   fragile, bypassable via any static linkage.

## Decision

**Option 1 (iptables in the workspace container)** as v1.

Mechanism:

- The image is based on `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm`.
- Additional apt packages `iptables`, `iproute2`, `dnsutils`, `gosu`.
- A default allowlist baked into the image at
  `/etc/monoceros/egress-allow.default.txt` (Anthropic API, npm
  registry, GitHub, ghcr, Debian repos, PyPI).
- Per-solution override:
  `/workspaces/<solution>/.monoceros/egress-allow.txt`, additionally
  merged at startup.
- The entrypoint runs as root, resolves hostnames to A records via
  `getent ahostsv4`, and adds an `ACCEPT` rule in `OUTPUT` for each
  IP. Loopback, conntrack-related/established, DNS (UDP/TCP 53), and
  RFC1918 ranges (the Compose network) are unconditionally allowed.
  The default policy afterwards is `DROP`.
- IPv6 is blocked entirely (`ip6tables -P OUTPUT DROP`), so no
  parallel egress path stays open.
- The entrypoint then drops to the unprivileged user via
  `gosu node` and execs `CMD`.

Three modes via the `MONOCEROS_EGRESS` env:

- `enforce` (default): rules active, policy `DROP`.
- `warn`: rules set, policy stays `ACCEPT`. Counters via
  `iptables -L OUTPUT -nv` show who sends what and where.
- `off`: skip setup, unrestricted egress.

## Rationale

Option 1 is the smallest implementation that provides real
protection:

- **In the image, not in the Compose setup**: every solution
  automatically inherits the default hardening without per-solution
  `compose.yaml` logic having to be actively wired in. The builder
  only has to include `cap_add: [NET_ADMIN]` — the rest is internal to
  the image.
- **No sidecar container**: no additional service definition, no proxy
  configuration drift, no extra entrypoint per solution.
- **Standard tooling**: `iptables` and `gosu` are stock Linux tools,
  not a black box.

## Consequences

**Accepted trade-offs:**

- **CDN IP drift**: hostnames are resolved once at container startup.
  Hosts with rotating CDNs (npm via Cloudflare, GitHub via Fastly) can
  change IPs, so the rules go stale over the container's lifetime.
  Mitigation: recreate the container regularly
  (`docker compose down && monoceros start`). The durably better
  option is Option 2 — see migration below.
- **DNS unrestricted**: UDP/TCP 53 is allowed to any address, so
  hostname resolution works in the running container. An attacker with
  code in the container could exfiltrate data via DNS tunneling. An
  acceptable gap for v1; otherwise we would have to maintain an
  in-container DNS resolver with its own allowlist.
- **Private network unrestricted**: RFC1918 ranges are ACCEPT, because
  Compose-internal services (postgres, redis) must be reachable. This
  means a malicious agent could try to attack other local Compose
  stacks or the host (Docker bridge). Accepted because that is a
  different threat class (lateral movement, not egress).

**Migration path to Option 2 (HTTPS proxy sidecar):**

If (a) CDN drift causes practical problems or (b) finer content
control is wanted (see the backlog item "HTTPS content filter"), we
switch to Option 2 as a layer **on top of** Option 1. The workspace
container keeps its iptables rules, additionally gets
`HTTPS_PROXY`/`HTTP_PROXY` env vars, and the Compose stack gains an
`egress` service running proxy software. Option 1 remains as
protection against tools that ignore `HTTPS_PROXY`.

## Verification

- Allowed host (`api.anthropic.com:443`): `/dev/tcp` connect succeeds.
- Disallowed host (`example.com:443`, `cloudflare.com:443`): connect
  blocked.
- Without `NET_ADMIN`: the entrypoint logs a warning and falls back to
  unrestricted egress (no silent fail-open).
- The override file is merged; additional hosts get through.
- `MONOCEROS_EGRESS=warn` and `=off` behave as specified.
