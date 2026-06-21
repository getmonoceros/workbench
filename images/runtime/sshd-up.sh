#!/usr/bin/env bash
# Monoceros: bring up sshd for the universal IDE attach point (ADR 0022).
#
# Invoked from two places: the image ENTRYPOINT (every container start)
# and the container's `postStartCommand` (the devcontainer lifecycle, on
# apply / `monoceros start`). The entrypoint invocation is what makes sshd
# survive a plain `docker restart` / Docker Desktop restart / host reboot:
# those restart PID 1 (the entrypoint) but do NOT re-run the
# postStartCommand. For the entrypoint to run as PID 1 in image mode the
# scaffold sets `overrideCommand: false` (devcontainer-cli otherwise
# replaces the entrypoint with its own keep-alive); in compose mode the
# image entrypoint always runs. The postStartCommand stays as the
# apply/start path.
#
# Idempotent: safe to run on every start. Needs root (binds port 22,
# writes /run/sshd, reads host keys); the lifecycle invokes it via sudo.
set -euo pipefail

RUNTIME_USER="${MONOCEROS_RUNTIME_USER:-node}"
user_home="$(getent passwd "$RUNTIME_USER" | cut -d: -f6)"

if ! command -v sshd >/dev/null 2>&1; then
  echo "[monoceros-ssh] sshd not installed, skipping" >&2
  exit 0
fi

mkdir -p /run/sshd
# Host keys: PERSIST them across rebuilds (ADR 0022 revision). The Claude
# desktop app's bundled ssh2 does no trust-on-first-use - it rejects a host
# whose key isn't already in known_hosts - and `apply` records the key there,
# so it must stay stable. We keep the durable copy under the bind-mounted
# container dir (`.monoceros/ssh/host/`, the same place the client key lives,
# and host-readable so `apply` can publish the pubkey). sshd itself uses the
# copies in /etc/ssh (correct perms on the container fs; a bind-mount's perms
# can trip sshd's strict host-key check). Restore -> fill-missing -> save.
host_store=""
for d in /workspaces/*/.monoceros/ssh; do
  if [ -d "$d" ]; then
    host_store="$d/host"
    break
  fi
done
if [ -n "$host_store" ]; then
  mkdir -p "$host_store"
  for k in "$host_store"/ssh_host_*; do
    if [ -e "$k" ]; then
      cp -p "$k" /etc/ssh/ || true
    fi
  done
fi
# Generate any host keys still missing (first run, or a new type).
ssh-keygen -A >/dev/null 2>&1 || true
# sshd refuses private host keys that are group/world readable.
chmod 600 /etc/ssh/ssh_host_*_key 2>/dev/null || true
chmod 644 /etc/ssh/ssh_host_*_key.pub 2>/dev/null || true
if [ -n "$host_store" ]; then
  cp -p /etc/ssh/ssh_host_*_key "$host_store"/ 2>/dev/null || true
  cp -p /etc/ssh/ssh_host_*_key.pub "$host_store"/ 2>/dev/null || true
fi

# Install the builder's per-container public key(s) as the runtime user's
# authorized_keys. The keys are minted on the host by `monoceros apply`
# into `<container>/.monoceros/ssh/*.pub`, visible in-container under
# `/workspaces/*/.monoceros/ssh/` (the whole container dir is bind-mounted
# there) - the same glob shape the egress allowlist uses.
ssh_dir="$user_home/.ssh"
keys="$ssh_dir/authorized_keys"
install -d -m 700 -o "$RUNTIME_USER" -g "$RUNTIME_USER" "$ssh_dir"
: > "$keys"
count=0
shopt -s nullglob
for pub in /workspaces/*/.monoceros/ssh/*.pub; do
  cat "$pub" >> "$keys"
  count=$((count + 1))
done
shopt -u nullglob
chmod 600 "$keys"
chown "$RUNTIME_USER:$RUNTIME_USER" "$keys"

# Start sshd only if it isn't already listening (idempotent across
# postStart re-runs). sshd writes /run/sshd.pid; a live pid means skip.
if [[ -s /run/sshd.pid ]] && kill -0 "$(cat /run/sshd.pid)" 2>/dev/null; then
  echo "[monoceros-ssh] sshd already running ($count authorized key(s))" >&2
else
  /usr/sbin/sshd
  echo "[monoceros-ssh] sshd up on 127.0.0.1:22 ($count authorized key(s))" >&2
fi

# Windows attach (ADR 0022 revision): the Claude desktop app cannot use a
# ProxyCommand on Windows (its ssh2 spawns it via `sh`, which Windows lacks),
# so on Windows applies the bridge port is wired both ways: the
# postStartCommand passes it as the first ARGUMENT (env would not survive the
# `sudo` it runs under), while the entrypoint runs as root and lets it through
# the env (MONOCEROS_SSH_PUBLISH_PORT). Either path resolves the same port.
# sshd stays loopback-only; a socat bridge listens on that port on the
# container interface and forwards to sshd. Idempotent.
port="${1:-${MONOCEROS_SSH_PUBLISH_PORT:-}}"
if [[ -n "$port" ]] && ! pgrep -f "TCP-LISTEN:${port}," >/dev/null 2>&1; then
  setsid socat "TCP-LISTEN:${port},fork,reuseaddr" TCP:127.0.0.1:22 \
    >/dev/null 2>&1 &
  echo "[monoceros-ssh] ssh bridge listening on :${port} -> 127.0.0.1:22" >&2
fi
