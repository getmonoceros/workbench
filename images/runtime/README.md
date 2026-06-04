# Monoceros Runtime Image

A thin layer on top of
`mcr.microsoft.com/devcontainers/typescript-node:22-bookworm`. It adds
two things:

1. **Claude Code CLI preinstalled** — saves the ~5–10 seconds that
   `post-create.sh` otherwise needs on the first `up`.
2. **Egress allowlist via iptables** — the container may only reach
   explicitly allowed hosts. This is the actual hardening; see the
   architecture rationale in
   [ADR 0002](../../docs/adr/0002-egress-whitelist-runtime-image.md).

## Versioning + Publish

The image version number lives in [`VERSION`](VERSION). Bump it,
commit, and merge to `main` — the
[`release-runtime` workflow](../../.github/workflows/release-runtime.yml)
then builds multi-arch (`linux/amd64` + `linux/arm64`) and pushes to
`ghcr.io/getmonoceros/monoceros-runtime:<version>`,
`:<major>`, and `:latest`. If the version already exists in the
registry, nothing is rebuilt (idempotent). See
[ADR 0004](../../docs/adr/0004-release-modell-m4.md) for the logic.

By default, generated dev containers reference the major tag
(`ghcr.io/getmonoceros/monoceros-runtime:1`), so minor bumps are
picked up automatically without rerunning `monoceros apply`.

## Local Build (Contributors)

From the workspace root:

```sh
pnpm image:build      # first-time / incremental build
pnpm image:rebuild    # same with --no-cache (e.g. after iptables updates)
```

Both invoke `docker build -t monoceros-runtime:dev images/runtime`.
To make a `monoceros apply` use this local variant instead of the
GHCR tag:

```sh
export MONOCEROS_BASE_IMAGE_OVERRIDE=monoceros-runtime:dev
monoceros apply <name>
```

As soon as the variable is gone (`unset` or a new shell), `apply`
pulls the GHCR tag again.

## Egress Modes

Controlled via the `MONOCEROS_EGRESS` env variable:

| Value     | Behavior                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `enforce` | Default. iptables rules active, `OUTPUT` policy `DROP`. Only allowlist hosts reachable.                                    |
| `warn`    | Rules are set but the policy stays `ACCEPT`. Egress flows through, counters are visible via `sudo iptables -L OUTPUT -nv`. |
| `off`     | iptables setup is skipped entirely. The container has unrestricted egress.                                                 |

Without `cap_add: [NET_ADMIN]` in the compose file, the entrypoint
logs a warning and falls back to unrestricted egress — no silent
fail-open.

## Adjusting the Allowlist

Per solution: create the file `.monoceros/egress-allow.txt` in the
workspace, one hostname per line. It is read in addition to the
default list at container start.

```text
# .monoceros/egress-allow.txt
internal-api.example.com
gitlab.intern.example
```

Default list: [`egress-allow.default.txt`](egress-allow.default.txt).

## Known Limitation: CDN IP Drift

Hostnames are resolved to IPs **once at container start** and entered
as ACCEPT rules. Hosts on rotating CDNs (npm, GitHub) may change IPs,
so rules can go stale over the lifetime of a container. If you see
anomalies, recreate the container
(`docker compose down && monoceros start`). A permanent fix would be
an HTTPS forward proxy as a sidecar — noted in the backlog under
"HTTPS content filter".

IPv6 is blocked entirely, because parallel unrestricted egress would
otherwise be possible via `ip6tables`. A modern Docker setup is
mostly IPv4-only inside the container anyway.
