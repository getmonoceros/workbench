#!/usr/bin/env bash
# Monoceros: bring up sshd for the universal IDE attach point (ADR 0022).
#
# Invoked from the container's `postStartCommand` (the devcontainer
# lifecycle), NOT the image ENTRYPOINT: devcontainer-cli overrides the
# entrypoint in image mode (it runs the container as `/bin/sh -c <keep
# alive>`), so the entrypoint is not a reliable place to start daemons.
# postStartCommand runs in both image and compose mode and on every
# container start, so sshd survives a stop/start too.
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
# Generate any missing host keys at runtime (per-container, not baked
# into the image). The generated client config disables host-key
# checking, so ephemeral host keys don't nag across rebuilds.
ssh-keygen -A >/dev/null 2>&1 || true

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
