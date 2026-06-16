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
#   - `openssh-server` + `socat` for the universal IDE attach point:
#     the entrypoint runs sshd on loopback, the host reaches it portless
#     via `docker exec … socat … TCP:127.0.0.1:22`. Any SSH-capable IDE
#     (Codium, IntelliJ, Zed) and a plain terminal attach to the running
#     container without restarting it. See ADR 0022.
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
      openssh-server \
      socat \
 && rm -rf /var/lib/apt/lists/*

# Harden sshd for the IDE attach point (ADR 0022). A drop-in under
# sshd_config.d (Debian's sshd_config Includes it): key-only auth, no
# root, no password, and bind to loopback only - nothing is published
# to the host; the host reaches sshd through `docker exec … socat`. Host
# keys and /run/sshd are created at runtime by the entrypoint so they
# don't bake into the image layer.
RUN install -d /etc/ssh/sshd_config.d \
 && printf '%s\n' \
      'ListenAddress 127.0.0.1' \
      'PermitRootLogin no' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      'PubkeyAuthentication yes' \
      > /etc/ssh/sshd_config.d/monoceros.conf

RUN install -d /etc/monoceros
COPY egress-allow.default.txt /etc/monoceros/egress-allow.default.txt

# Pre-create the VS Code server state dirs owned by `node`. Monoceros
# mounts named volumes at `~/.vscode-server/extensions` and
# `~/.vscode-server/data/User` so extensions + settings survive a
# rebuild (ADR 0015). A fresh named volume initialises with the
# ownership of the image directory at its mount point — so these must
# exist and be owned by the non-root `node` user, otherwise the VS Code
# server fails to write into them ("permission denied"). This is the
# non-root requirement called out in VS Code's "avoid extension
# reinstalls" docs.
RUN mkdir -p /home/node/.vscode-server/extensions \
             /home/node/.vscode-server/data/User \
 && chown -R node:node /home/node/.vscode-server

COPY entrypoint.sh /usr/local/bin/monoceros-entrypoint.sh
RUN chmod 0755 /usr/local/bin/monoceros-entrypoint.sh

# Stay root for the entrypoint — it needs NET_ADMIN to set iptables
# rules. The entrypoint drops to `node` via gosu before exec'ing CMD.
USER root
ENTRYPOINT ["/usr/local/bin/monoceros-entrypoint.sh"]
CMD ["sleep", "infinity"]
