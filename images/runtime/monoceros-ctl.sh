#!/usr/bin/env bash
#
# monoceros-ctl — in-container companion for long-running app servers.
#
# Shipped in the runtime image at /usr/local/bin/monoceros-ctl. It is the
# single source of truth for the start/stop mechanics: the host command
# `monoceros start/stop <name> <app>` is just a `docker exec` onto this
# script, and the build agent calls it directly from inside the container.
#
#   monoceros-ctl start <app> [--target <t>]
#   monoceros-ctl stop  <app> [--target <t>]
#   monoceros-ctl logs  <app> [--target <t>] [--no-follow]
#   monoceros-ctl list
#
# An app is a directory under projects/ that carries
# .monoceros/launch.json. The launch config is read here (never guessed);
# Monoceros does not infer the start command.
#
# Runtime state is kept OUT of logs/ (logs are logs): pid files live under
# .monoceros/run/<app>/<target>.pid, logs under logs/<app>/<target>.log.
# Both dirs are inside the workspace bind-mount, so the host sees them too.
set -euo pipefail

die() {
  echo "monoceros-ctl: $*" >&2
  exit 1
}

# The workspace root is the sole directory under /workspaces. The script is
# generic (one image, many containers), so it discovers the name rather than
# hard-coding it.
resolve_workspace() {
  local ws
  ws=$(find /workspaces -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n1)
  [ -n "$ws" ] || die "no workspace found under /workspaces"
  printf '%s\n' "$ws"
}

WS="$(resolve_workspace)"
NAME="$(basename "$WS")"

# Colours, mirroring the host CLI's vocabulary (cyan identifiers, grey for
# secondary detail, green/red status). Only when stdout is a terminal; piped
# or captured output stays plain.
if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_UL=$'\033[4m'
  C_CYAN=$'\033[36m'
  C_GREY=$'\033[90m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
else
  C_RESET='' C_BOLD='' C_UL='' C_CYAN='' C_GREY='' C_GREEN='' C_RED=''
fi

# `▸ <app>` section header, once per command (matches the host CLI's sections).
hdr() { printf '%s%s▸ %s%s\n' "$C_BOLD" "$C_UL" "$1" "$C_RESET"; }

# Indented per-target line: marker, cyan target padded to a column, then detail.
target_line() { # <marker> <target> <detail>
  local pad=$((13 - ${#2}))
  [ "$pad" -lt 1 ] && pad=1
  printf '  %s %s%s%s%*s%s\n' "$1" "$C_CYAN" "$2" "$C_RESET" "$pad" '' "$3"
}

launch_json() { printf '%s/projects/%s/.monoceros/launch.json\n' "$WS" "$1"; }
run_dir()     { printf '%s/.monoceros/run/%s\n' "$WS" "$1"; }
log_dir()     { printf '%s/logs/%s\n' "$WS" "$1"; }

require_launch() {
  local app="$1" file
  file="$(launch_json "$app")"
  [ -f "$file" ] || die "no launch config for '$app' (expected projects/$app/.monoceros/launch.json)"
  printf '%s\n' "$file"
}

# Echo the resolved target name for an app: the requested one, else the
# single config's name, else the one marked default. Errors otherwise.
resolve_target() {
  local app="$1" want="$2" file
  file="$(require_launch "$app")"
  if [ -n "$want" ]; then
    jq -e --arg n "$want" '.configurations[] | select(.name == $n)' "$file" >/dev/null \
      || die "no target '$want' in $app (have: $(jq -r '[.configurations[].name] | join(", ")' "$file"))"
    printf '%s\n' "$want"
    return
  fi
  # No --target: resolve a SINGLE target only when unambiguous. One default,
  # or a sole target, is fine; a multi-target default set is not (callers that
  # act on one target, e.g. logs/stop-of-one, must pick).
  local count ndefault
  count=$(jq '.configurations | length' "$file")
  ndefault=$(jq '[.configurations[] | select(.default == true)] | length' "$file")
  if [ "$ndefault" = "1" ]; then
    jq -r 'first(.configurations[] | select(.default == true) | .name)' "$file"
  elif [ "$ndefault" = "0" ] && [ "$count" = "1" ]; then
    jq -r '.configurations[0].name' "$file"
  elif [ "$ndefault" -gt 1 ]; then
    die "$app has multiple default targets - pass --target ($(jq -r '[.configurations[] | select(.default == true) | .name] | join(", ")' "$file"))"
  else
    die "$app has $count targets and no default - pass --target ($(jq -r '[.configurations[].name] | join(", ")' "$file"))"
  fi
}

# The targets started when --target is omitted, in declared (array) order:
# every target marked default, or the sole target when none is marked.
default_targets() {
  local app="$1" file marked
  file="$(require_launch "$app")"
  marked="$(jq -r '.configurations[] | select(.default == true) | .name' "$file")"
  if [ -n "$marked" ]; then
    printf '%s\n' "$marked"
  elif [ "$(jq '.configurations | length' "$file")" = "1" ]; then
    jq -r '.configurations[0].name' "$file"
  fi
}

field() { # field <app> <target> <jq-path>
  local file; file="$(launch_json "$1")"
  jq -r --arg n "$2" ".configurations[] | select(.name == \$n) | $3 // empty" "$file"
}

pid_alive() { # pid_alive <pidfile>
  local f="$1" pid
  [ -f "$f" ] || return 1
  pid="$(cat "$f" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# Start an app: with a target, just that one; without, the whole default set in
# declared order, failing fast if one does not come up.
cmd_start() {
  local app="$1" target="$2"
  hdr "$app"
  if [ -n "$target" ]; then
    start_one "$app" "$(resolve_target "$app" "$target")"
    return $?
  fi
  local -a set=()
  local t
  while IFS= read -r t; do
    [ -n "$t" ] && set+=("$t")
  done < <(default_targets "$app")
  if [ "${#set[@]}" -eq 0 ]; then
    die "$app has multiple targets and no default - pass --target ($(jq -r '[.configurations[].name] | join(", ")' "$(require_launch "$app")"))"
  fi
  for t in "${set[@]}"; do
    if ! start_one "$app" "$t"; then
      printf '%s  stopped after %s failed (fail-fast); remaining targets not started%s\n' \
        "$C_GREY" "$t" "$C_RESET" >&2
      return 1
    fi
  done
}

# Start one concrete (already-resolved) target, detached. Returns non-zero when
# the process dies before binding, or its port never listens within the window.
start_one() {
  local app="$1" target="$2"

  local pidf logf
  pidf="$(run_dir "$app")/$target.pid"
  logf="$(log_dir "$app")/$target.log"

  if pid_alive "$pidf"; then
    target_line "${C_GREY}·${C_RESET}" "$target" \
      "${C_GREY}already running    pid $(cat "$pidf")${C_RESET}"
    return 0
  fi

  local command cwd port workdir
  command="$(field "$app" "$target" '.command')"
  cwd="$(field "$app" "$target" '.cwd')"
  port="$(field "$app" "$target" '.port')"
  workdir="$WS/projects/$app"
  [ -n "$cwd" ] && workdir="$workdir/$cwd"
  [ -d "$workdir" ] || die "working directory does not exist: $workdir"

  # Extra env vars from the launch config, as KEY=VALUE args for `env`.
  local -a envargs=()
  local kv
  while IFS= read -r kv; do
    [ -n "$kv" ] && envargs+=("$kv")
  done < <(jq -r --arg n "$target" \
    '.configurations[] | select(.name == $n) | (.env // {}) | to_entries[] | "\(.key)=\(.value)"' \
    "$(launch_json "$app")")

  mkdir -p "$(run_dir "$app")" "$(log_dir "$app")"

  # Build the inner launch script. Each interpolated value is %q-quoted so
  # paths, env values and the command survive the nested shells intact.
  local q_pid q_wd q_log q_cmd envstr=""
  q_pid="$(printf '%q' "$pidf")"
  q_wd="$(printf '%q' "$workdir")"
  q_log="$(printf '%q' "$logf")"
  q_cmd="$(printf '%q' "$command")"
  local e
  for e in "${envargs[@]}"; do
    envstr+=" $(printf '%q' "$e")"
  done

  # Detached process group: setsid makes the `sh` the group leader, $$ is its
  # pgid, and the whole group is later signalled with `kill -TERM -<pgid>`
  # (stops children too — node under npm, java under maven, …). The leader
  # exec's the command, so the recorded pid stays valid for the lifetime.
  setsid sh -c \
    "echo \$\$ >$q_pid; cd $q_wd; exec env${envstr} sh -c $q_cmd >$q_log 2>&1" \
    </dev/null &

  # Give the pid file a moment to appear.
  local i
  for i in $(seq 1 50); do
    [ -f "$pidf" ] && break
    sleep 0.1
  done
  [ -f "$pidf" ] || die "failed to launch $app/$target (no pid recorded)"
  local pid rellog
  pid="$(cat "$pidf")"
  rellog="${logf#"$WS"/}"

  # No readiness signal without a port: report started, point at the log.
  if [ -z "$port" ]; then
    target_line "${C_GREEN}✓${C_RESET}" "$target" \
      "${C_GREY}started (no port to check)    pid $pid${C_RESET}"
    return 0
  fi

  # Readiness probe: wait until something actually listens on the port, so
  # "started" means "up" - not "spawned and maybe crashed". Bail if the
  # process group dies first, or if nothing binds within the window.
  for i in $(seq 1 100); do
    if ! pid_alive "$pidf"; then
      target_line "${C_RED}✗${C_RESET}" "$target" \
        "exited before binding port $port - see $rellog"
      return 1
    fi
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      exec 3>&- 2>/dev/null || true
      target_line "${C_GREEN}✓${C_RESET}" "$target" \
        "http://$NAME-$port.localhost    ${C_GREY}pid $pid${C_RESET}"
      return 0
    fi
    sleep 0.2
  done
  target_line "${C_RED}✗${C_RESET}" "$target" \
    "no listener on port $port after 20s - see $rellog"
  return 1
}

# Stop an app: with a target, just that one; without, the whole default set
# (the same set start brings up). Best-effort across the set - no fail-fast.
cmd_stop() {
  local app="$1" target="$2"
  hdr "$app"
  if [ -n "$target" ]; then
    stop_one "$app" "$(resolve_target "$app" "$target")"
    return $?
  fi
  local -a set=()
  local t
  while IFS= read -r t; do
    [ -n "$t" ] && set+=("$t")
  done < <(default_targets "$app")
  if [ "${#set[@]}" -eq 0 ]; then
    die "$app has multiple targets and no default - pass --target ($(jq -r '[.configurations[].name] | join(", ")' "$(require_launch "$app")"))"
  fi
  for t in "${set[@]}"; do
    stop_one "$app" "$t"
  done
}

# Stop one concrete (already-resolved) target by killing its process group.
stop_one() {
  local app="$1" target="$2"
  local pidf
  pidf="$(run_dir "$app")/$target.pid"

  if ! pid_alive "$pidf"; then
    [ -f "$pidf" ] && rm -f "$pidf"
    target_line "${C_GREY}·${C_RESET}" "$target" "${C_GREY}not running${C_RESET}"
    return 0
  fi

  local pid
  pid="$(cat "$pidf")"
  kill -TERM "-$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "-$pid" 2>/dev/null || true
  fi
  rm -f "$pidf"
  target_line "${C_GREEN}✓${C_RESET}" "$target" "stopped"
}

cmd_logs() {
  local app="$1" target="$2" follow="$3"
  target="$(resolve_target "$app" "$target")"
  local logf; logf="$(log_dir "$app")/$target.log"
  [ -f "$logf" ] || die "no log for $app/$target at $logf (started yet?)"
  if [ "$follow" = "1" ]; then
    exec tail -n +1 -F "$logf"
  else
    exec cat "$logf"
  fi
}

cmd_list() {
  local file app t pidf marker detail isdefault
  shopt -s nullglob globstar
  for file in "$WS"/projects/**/.monoceros/launch.json; do
    app="${file#"$WS"/projects/}"
    app="${app%/.monoceros/launch.json}"
    hdr "$app"
    while IFS= read -r t; do
      pidf="$(run_dir "$app")/$t.pid"
      isdefault="$(jq -r --arg n "$t" '.configurations[] | select(.name == $n) | .default // false' "$file")"
      if pid_alive "$pidf"; then
        marker="${C_GREEN}✓${C_RESET}"
        detail="running    ${C_GREY}pid $(cat "$pidf")${C_RESET}"
      else
        marker="${C_GREY}·${C_RESET}"
        detail="${C_GREY}stopped${C_RESET}"
      fi
      [ "$isdefault" = "true" ] && detail="$detail    ${C_GREY}(default)${C_RESET}"
      target_line "$marker" "$t" "$detail"
    done < <(jq -r '.configurations[].name' "$file")
  done
}

main() {
  local sub="${1:-}"; shift || true
  local app="" target="" follow="1"
  # First non-flag positional is the app; --target takes a value.
  while [ $# -gt 0 ]; do
    case "$1" in
      --target) target="${2:-}"; shift 2 ;;
      --target=*) target="${1#--target=}"; shift ;;
      --no-follow) follow="0"; shift ;;
      -*) die "unknown flag: $1" ;;
      *) [ -z "$app" ] && app="$1"; shift ;;
    esac
  done

  case "$sub" in
    start) [ -n "$app" ] || die "usage: monoceros-ctl start <app> [--target <t>]"; cmd_start "$app" "$target" ;;
    stop)  [ -n "$app" ] || die "usage: monoceros-ctl stop <app> [--target <t>]";  cmd_stop "$app" "$target" ;;
    logs)  [ -n "$app" ] || die "usage: monoceros-ctl logs <app> [--target <t>] [--no-follow]"; cmd_logs "$app" "$target" "$follow" ;;
    list)  cmd_list ;;
    ""|-h|--help|help)
      cat <<'EOF'
monoceros-ctl — start/stop long-running app servers inside the container

  monoceros-ctl start <app> [--target <t>]   start an app's server (detached)
  monoceros-ctl stop  <app> [--target <t>]   stop it (kills the process group)
  monoceros-ctl logs  <app> [--target <t>]   tail its log (--no-follow to dump)
  monoceros-ctl list                         list apps, targets and run state

<app> is a path under projects/ that carries .monoceros/launch.json.
--target defaults to the config marked "default" (or the only one).
EOF
      ;;
    *) die "unknown command: $sub (try --help)" ;;
  esac
}

main "$@"
