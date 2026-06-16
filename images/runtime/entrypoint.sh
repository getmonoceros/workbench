#!/usr/bin/env bash
# Monoceros runtime entrypoint. Configures the egress allowlist via
# iptables, then drops to the unprivileged `node` user before exec'ing
# the container's actual command.
#
# The allowlist is read from /etc/monoceros/egress-allow.default.txt
# plus any `.monoceros/egress-allow.txt` found under /workspaces (the
# bind-mounted solution root).
#
# Behavior knobs via env vars:
#   MONOCEROS_EGRESS=off    — skip iptables setup entirely (escape hatch)
#   MONOCEROS_EGRESS=warn   — set rules but don't change default policy
#                             (egress stays open; useful for debugging
#                             which hosts your code talks to)

set -euo pipefail

DEFAULT_LIST=/etc/monoceros/egress-allow.default.txt
RUNTIME_USER="${MONOCEROS_RUNTIME_USER:-node}"
# Default ist `off` — hostname-basierte iptables-Allowlist hat sich in
# der Praxis nicht mit VS Code Dev Containers vertragen (rotierende
# CDN-IPs, Extension-Subprocesses im falschen UID-Kontext). Mechanik
# bleibt im Image für gezielte Use-Cases (CI, unattended Claude), wird
# aber nicht mehr standardmäßig aktiviert. Siehe ADR 0002 für den
# vollen Kontext.
MODE="${MONOCEROS_EGRESS:-off}"

log() { echo "[monoceros-egress] $*" >&2; }

sshlog() { echo "[monoceros-ssh] $*" >&2; }

# Bring up sshd for the universal IDE attach point (ADR 0022). Runs as
# root before the privilege drop. sshd listens on loopback only; the
# host reaches it portless via `docker exec … socat … TCP:127.0.0.1:22`.
#
# The builder's per-container public key(s) are minted on the host by
# `monoceros apply` into `<container>/.monoceros/ssh/*.pub`, which is
# visible in-container under `/workspaces/*/.monoceros/ssh/` (the whole
# container dir is bind-mounted there). We glob them in - the same
# pattern the egress allowlist uses - and install them as the runtime
# user's authorized_keys with the ownership/permissions sshd requires.
setup_ssh() {
  command -v sshd >/dev/null 2>&1 || { sshlog "sshd not installed, skipping"; return 0; }

  local user_home
  user_home="$(getent passwd "$RUNTIME_USER" | cut -d: -f6)"
  [[ -n "$user_home" ]] || { sshlog "no home for $RUNTIME_USER, skipping"; return 0; }

  mkdir -p /run/sshd
  # Generate any missing host keys at runtime (per-container, not baked
  # into the image). The generated client config disables host-key
  # checking, so ephemeral host keys don't nag across rebuilds.
  ssh-keygen -A >/dev/null 2>&1 || true

  local ssh_dir="$user_home/.ssh"
  local keys="$ssh_dir/authorized_keys"
  install -d -m 700 -o "$RUNTIME_USER" -g "$RUNTIME_USER" "$ssh_dir"
  : > "$keys"
  local count=0
  shopt -s nullglob
  for pub in /workspaces/*/.monoceros/ssh/*.pub; do
    cat "$pub" >> "$keys"
    count=$((count + 1))
  done
  shopt -u nullglob
  chmod 600 "$keys"
  chown "$RUNTIME_USER:$RUNTIME_USER" "$keys"

  /usr/sbin/sshd
  sshlog "sshd up on 127.0.0.1:22 with $count authorized key(s)"
}

drop_to_user_and_exec() {
  if [[ "$(id -u)" == "0" ]]; then
    exec gosu "$RUNTIME_USER" "$@"
  fi
  exec "$@"
}

if [[ "$(id -u)" != "0" ]]; then
  # Already non-root — most likely the image was started with `--user`
  # or compose `user:` overriding our intent. We can't iptables in that
  # case; just exec the command and trust the caller knows what they
  # do.
  log "running as uid $(id -u), skipping egress configuration"
  exec "$@"
fi

# Root from here on. Bring up sshd before the egress setup and the
# privilege drop so the IDE attach point is available regardless of
# egress mode (sshd is loopback-only; OUTPUT filtering doesn't touch it).
setup_ssh

if [[ "$MODE" == "off" ]]; then
  log "egress enforcement disabled via MONOCEROS_EGRESS=off"
  drop_to_user_and_exec "$@"
fi

if ! iptables -L OUTPUT >/dev/null 2>&1; then
  log "WARNING: iptables not usable — NET_ADMIN capability missing?"
  log "         the container will have unrestricted network access"
  drop_to_user_and_exec "$@"
fi

# Collect the active allowlist: built-in defaults + any per-workspace
# overrides under /workspaces/*/.monoceros/egress-allow.txt.
ALLOWLIST=$(mktemp)
trap 'rm -f "$ALLOWLIST"' EXIT
cat "$DEFAULT_LIST" > "$ALLOWLIST"
shopt -s nullglob
for override in /workspaces/*/.monoceros/egress-allow.txt; do
  log "merging override: $override"
  echo >> "$ALLOWLIST"
  echo "# from $override" >> "$ALLOWLIST"
  cat "$override" >> "$ALLOWLIST"
done
shopt -u nullglob

log "applying egress allowlist (mode=$MODE)"

# Flush and rebuild the OUTPUT chain. INPUT and FORWARD are left alone.
iptables -F OUTPUT
iptables -P OUTPUT ACCEPT  # temporary while we add rules

# Loopback and return traffic stay open unconditionally.
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# DNS — both UDP and TCP, any destination. Without this we can't resolve
# any hostname inside the container, including those on the allowlist.
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Intra-compose / private RFC1918 ranges — postgres, redis, sibling
# services on the compose network all need to be reachable.
iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT

# Resolve each allowlisted hostname to its current A records and accept
# direct traffic. This is a snapshot at container start — for hosts on
# rotating CDNs (npm, GitHub) the ruleset can drift over the container's
# lifetime. Re-create the container to refresh.
allowed_count=0
while IFS= read -r line; do
  host="${line%%#*}"          # strip inline comments
  host="${host//[[:space:]]/}" # strip whitespace
  [[ -z "$host" ]] && continue
  while IFS= read -r ip; do
    [[ -z "$ip" ]] && continue
    iptables -A OUTPUT -d "$ip" -j ACCEPT
    allowed_count=$((allowed_count + 1))
  done < <(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u)
done < "$ALLOWLIST"
log "allowed $allowed_count direct egress rules"

# Block IPv6 entirely if ip6tables is available — we don't want a
# parallel unrestricted egress path. Failures here are non-fatal.
if command -v ip6tables >/dev/null 2>&1 && ip6tables -L >/dev/null 2>&1; then
  ip6tables -F OUTPUT 2>/dev/null || true
  ip6tables -P OUTPUT DROP 2>/dev/null || true
fi

# Default policy: drop everything else. In `warn` mode we leave the
# policy at ACCEPT so the rules are observable via `iptables -L OUTPUT
# -nv` (packet counts) without breaking egress.
if [[ "$MODE" == "warn" ]]; then
  log "WARN MODE: rules in place but default policy stays ACCEPT"
  log "           use \`sudo iptables -L OUTPUT -nv\` to inspect counts"
else
  iptables -P OUTPUT DROP
  log "default OUTPUT policy: DROP"
fi

drop_to_user_and_exec "$@"
