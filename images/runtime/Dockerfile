# syntax=docker/dockerfile:1.6
#
# Monoceros runtime image. A thin layer on top of Microsoft's
# devcontainer-typescript-node base, adding:
#   - the Claude Code CLI globally (saves the 5–10s post-create install
#     on first start)
#   - iptables tooling and an entrypoint that configures an egress
#     allowlist before dropping privileges to the `node` user
#
# The base image already provides:
#   - Debian Bookworm with Node 22 + corepack + pnpm
#   - non-root `node` user with passwordless sudo
#   - common dev tools (git, curl, jq, ssh, …)
#
# To use this image, the workspace service in compose.yaml must be
# started with `cap_add: [NET_ADMIN]` so the entrypoint can install
# iptables rules. Without the capability the entrypoint logs a warning
# and falls through to unrestricted egress — never silently fails-open
# without saying so.

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

# Pin the Claude Code CLI to whatever was current when the image was
# built. Override at run time with `npm install -g @anthropic-ai/claude-code@latest`
# inside the container if you need newer.
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code

# Wrap the global `claude` binary so it auto-loads the Monoceros
# plugin from the workbench bind-mount when present. The real claude
# binary moves to `/usr/local/bin/claude.real`; our wrapper takes its
# place at `/usr/local/bin/claude`. See claude-wrapper.sh for the
# logic.
RUN mv /usr/local/bin/claude /usr/local/bin/claude.real
COPY claude-wrapper.sh /usr/local/bin/claude
RUN chmod 0755 /usr/local/bin/claude

RUN install -d /etc/monoceros
COPY egress-allow.default.txt /etc/monoceros/egress-allow.default.txt

COPY entrypoint.sh /usr/local/bin/monoceros-entrypoint.sh
RUN chmod 0755 /usr/local/bin/monoceros-entrypoint.sh

# Stay root for the entrypoint — it needs NET_ADMIN to set iptables
# rules. The entrypoint drops to `node` via gosu before exec'ing CMD.
USER root
ENTRYPOINT ["/usr/local/bin/monoceros-entrypoint.sh"]
CMD ["sleep", "infinity"]
