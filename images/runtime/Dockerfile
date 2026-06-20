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
#     sshd runs on loopback (brought up by `monoceros-sshd-up.sh` via the
#     container's postStartCommand, NOT the entrypoint - devcontainer-cli
#     overrides the entrypoint in image mode). The host reaches it portless
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
# keys and /run/sshd are created at runtime by monoceros-sshd-up.sh so
# they don't bake into the image layer.
RUN install -d /etc/ssh/sshd_config.d \
 && printf '%s\n' \
      'ListenAddress 127.0.0.1' \
      'PermitRootLogin no' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      'PubkeyAuthentication yes' \
      > /etc/ssh/sshd_config.d/monoceros.conf

# sshd bring-up script, run from each container's postStartCommand (see
# scaffold.ts). Baked into the image so it versions with the runtime.
COPY sshd-up.sh /usr/local/bin/monoceros-sshd-up.sh
RUN chmod 0755 /usr/local/bin/monoceros-sshd-up.sh

# Land interactive SSH/login shells in /workspaces/<name> instead of
# $HOME (ADR 0022). profile.d is sourced by login shells.
COPY workspace-login.sh /etc/profile.d/monoceros-workspace.sh
RUN chmod 0644 /etc/profile.d/monoceros-workspace.sh

# Always-on host-browser-bridge relay (ADR 0022 follow-up). A real `xdg-open`
# on PATH that relays a URL to the host-side bridge daemon via a bind-mounted
# file. `BROWSER` points at it so tools using either open convention reach the
# host browser from EVERY session - including an IDE/desktop-app SSH attach,
# not just `monoceros run`/`shell` (which prepend their own per-session relay).
COPY xdg-open-relay.sh /usr/local/bin/xdg-open
RUN chmod 0755 /usr/local/bin/xdg-open
ENV BROWSER=/usr/local/bin/xdg-open

RUN install -d /etc/monoceros
COPY egress-allow.default.txt /etc/monoceros/egress-allow.default.txt

# Pre-create the IDE server state dirs owned by `node`. Monoceros mounts
# named volumes on the `extensions` and `data/User` sub-dirs so extensions
# + settings survive a rebuild (ADR 0015; per-IDE allowlist in ADR 0022).
# A fresh named volume initialises with the ownership of the image
# directory at its mount point - so these must exist and be owned by the
# non-root `node` user, otherwise the IDE server fails to write into them
# ("permission denied"). This is the non-root requirement called out in
# VS Code's "avoid extension reinstalls" docs.
#   - VS Code   -> ~/.vscode-server
#   - VS Codium -> ~/.vscodium-server
#   - JetBrains -> ~/.cache/JetBrains (+ /RemoteDev/dist for the shared
#     backend distribution), ~/.config/JetBrains, ~/.local/share/JetBrains
#   - Claude Code SSH remote server -> ~/.claude/remote (since 1.3.3): a
#     volume keeps its rpc socket off the VirtioFS ~/.claude host mount,
#     whose chmod-on-socket fails with EINVAL (docker/for-mac#6614).
# chown the XDG parents (~/.cache, ~/.config, ~/.local) recursively, NOT
# just the JetBrains leaves: `mkdir -p` creates the intermediate ~/.local
# and ~/.local/share as root, and a leaf-only chown would leave those
# root-owned - which breaks every tool that writes elsewhere under them
# (e.g. opencode's ~/.local/share/opencode, which made its feature build
# fail at the `opencode --version` self-check).
RUN mkdir -p /home/node/.vscode-server/extensions \
             /home/node/.vscode-server/data/User \
             /home/node/.vscodium-server/extensions \
             /home/node/.vscodium-server/data/User \
             /home/node/.cache/JetBrains/RemoteDev/dist \
             /home/node/.config/JetBrains \
             /home/node/.local/share/JetBrains \
             /home/node/.claude/remote \
 && chown -R node:node /home/node/.vscode-server /home/node/.vscodium-server \
      /home/node/.cache /home/node/.config /home/node/.local \
      /home/node/.claude

COPY entrypoint.sh /usr/local/bin/monoceros-entrypoint.sh
RUN chmod 0755 /usr/local/bin/monoceros-entrypoint.sh

# Stay root for the entrypoint — it needs NET_ADMIN to set iptables
# rules. The entrypoint drops to `node` via gosu before exec'ing CMD.
USER root
ENTRYPOINT ["/usr/local/bin/monoceros-entrypoint.sh"]
CMD ["sleep", "infinity"]
