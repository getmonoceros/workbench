# syntax=docker/dockerfile:1.6
#
# Monoceros runtime image. A thin layer on top of Microsoft's
# devcontainer-typescript-node base.
#
# The base image provides:
#   - Debian Bookworm with Node 22 + corepack + pnpm
#   - non-root `node` user with passwordless sudo
#   - common dev tools (git, curl, jq, ssh, …)
#
# We add:
#   - iptables tooling + entrypoint that can install an egress
#     allowlist (opt-in via MONOCEROS_EGRESS=enforce; default off —
#     see ADR 0002 for context on why it's not enabled by default)
#   - `gosu` for the entrypoint's privilege drop to `node`
#
# AI coding tools (Claude Code, OpenCode, …) are NOT baked into the
# image. They come in per container as devcontainer features so the
# yml-Profile is explicit about what's installed.

FROM mcr.microsoft.com/devcontainers/typescript-node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      iptables \
      iproute2 \
      dnsutils \
      gosu \
 && rm -rf /var/lib/apt/lists/*

RUN install -d /etc/monoceros
COPY egress-allow.default.txt /etc/monoceros/egress-allow.default.txt

COPY entrypoint.sh /usr/local/bin/monoceros-entrypoint.sh
RUN chmod 0755 /usr/local/bin/monoceros-entrypoint.sh

# Stay root for the entrypoint — it needs NET_ADMIN to set iptables
# rules. The entrypoint drops to `node` via gosu before exec'ing CMD.
USER root
ENTRYPOINT ["/usr/local/bin/monoceros-entrypoint.sh"]
CMD ["sleep", "infinity"]
