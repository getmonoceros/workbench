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

# Bring up the IDE-attach sshd (ADR 0022) on EVERY container start. A plain
# `docker restart` / Docker Desktop restart / host reboot restarts PID 1 (this
# entrypoint) but does NOT re-run the devcontainer postStartCommand, so the
# entrypoint is the only hook that fires then. We're root here, so the Windows
# bridge port reaches the script via MONOCEROS_SSH_PUBLISH_PORT in the env (no
# `sudo` to strip it). Idempotent + best-effort: a failure must never block the
# container from coming up. The script is a no-op when sshd isn't installed.
# (postStartCommand still runs it on apply / `monoceros start` too.)
if [[ -x /usr/local/bin/monoceros-sshd-up.sh ]]; then
  /usr/local/bin/monoceros-sshd-up.sh || true
fi

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
