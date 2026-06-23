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
  local count default
  count=$(jq '.configurations | length' "$file")
  default=$(jq -r 'first(.configurations[] | select(.default == true) | .name) // empty' "$file")
  if [ -n "$default" ]; then
    printf '%s\n' "$default"
  elif [ "$count" = "1" ]; then
    jq -r '.configurations[0].name' "$file"
  else
    die "$app has $count targets and no default — pass --target ($(jq -r '[.configurations[].name] | join(", ")' "$file"))"
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

cmd_start() {
  local app="$1" target="$2"
  target="$(resolve_target "$app" "$target")"

  local pidf logf
  pidf="$(run_dir "$app")/$target.pid"
  logf="$(log_dir "$app")/$target.log"

  if pid_alive "$pidf"; then
    echo "monoceros-ctl: $app/$target already running (pid $(cat "$pidf"))."
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

  echo "monoceros-ctl: started $app/$target (pid $(cat "$pidf")) → $logf"

  # Readiness probe: if the target declares a port, wait until something
  # actually listens on it, so "started" means "up" — not "spawned and maybe
  # crashed". Bail early if the process group dies first.
  if [ -n "$port" ]; then
    for i in $(seq 1 100); do
      if ! pid_alive "$pidf"; then
        echo "monoceros-ctl: $app/$target exited before binding port $port — see $logf" >&2
        return 1
      fi
      if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
        exec 3>&- 2>/dev/null || true
        echo "monoceros-ctl: $app/$target is up → http://$NAME-$port.localhost"
        return 0
      fi
      sleep 0.2
    done
    echo "monoceros-ctl: $app/$target did not listen on port $port within 20s (still starting? see $logf)" >&2
  fi
  return 0
}

cmd_stop() {
  local app="$1" target="$2"
  target="$(resolve_target "$app" "$target")"
  local pidf; pidf="$(run_dir "$app")/$target.pid"

  if ! pid_alive "$pidf"; then
    [ -f "$pidf" ] && rm -f "$pidf"
    echo "monoceros-ctl: $app/$target is not running."
    return 0
  fi

  local pid; pid="$(cat "$pidf")"
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
  echo "monoceros-ctl: stopped $app/$target."
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
  local file app targets t pidf status
  shopt -s nullglob globstar
  for file in "$WS"/projects/**/.monoceros/launch.json; do
    app="${file#"$WS"/projects/}"
    app="${app%/.monoceros/launch.json}"
    echo "$app:"
    while IFS= read -r t; do
      pidf="$(run_dir "$app")/$t.pid"
      if pid_alive "$pidf"; then
        status="running (pid $(cat "$pidf"))"
      else
        status="stopped"
      fi
      if [ "$(jq -r --arg n "$t" '.configurations[] | select(.name == $n) | .default // false' "$file")" = "true" ]; then
        echo "  - $t (default) — $status"
      else
        echo "  - $t — $status"
      fi
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
