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
#   monoceros-ctl logs  <app> [--target <t>] [--follow|--no-follow]
#   monoceros-ctl list
#   monoceros-ctl reconcile
#
# An app is a directory under projects/ that carries
# .monoceros/launch.json. The launch config is read here (never guessed);
# Monoceros does not infer the start command.
#
# Runtime state is kept OUT of logs/ (logs are logs): pid files live under
# .monoceros/run/<app>/<target>.pid, logs under logs/<app>/<target>.log.
# Both dirs are inside the workspace bind-mount, so the host sees them too.
# The PRESENCE of a pid file doubles as the "wanted" marker (it is written by
# start and removed only by an explicit stop), which `reconcile` reads to bring
# back what an `apply` / restart tore down. See ADR 0028. Its CONTENT is
# "<pid> <start time>", so a pid reused by another process after a recreate is
# not taken for the app (#42).
set -euo pipefail

die() {
  echo "monoceros-ctl: $*" >&2
  exit 1
}

# Default readiness window, in seconds: how long `start` waits for a target to
# bind its port before calling it failed. Fine for interpreted stacks, too short
# for a compiled one whose command builds first (a cold Go or Maven build easily
# outruns it, and the target is then reported failed while it is still coming
# up). A target overrides it with `readyTimeout` in its launch config.
READY_TIMEOUT_DEFAULT=20

# How long `reconcile` keeps restarting a target that exits too early, and how
# long it waits between tries. After a restart the services come up alongside
# the workspace, and `docker compose up` returns once their containers run, not
# once they answer. Any app that needs one of them at boot dies until it does
# (#25). reconcile does not know which service that is, and does not need to:
# the early exit is the signal, whatever the app is waiting for.
RECONCILE_RETRY_SECONDS=120
RECONCILE_RETRY_INTERVAL=5

# A target without a port has no readiness signal. While reconciling it gets
# this many seconds, and dying within them counts as exiting too early.
RECONCILE_NOPORT_GRACE=3

# Set by reconcile around every try (RECONCILING) and around every try but the
# last (EARLY_EXIT_QUIET). start_one then reports an early exit with status 2,
# and prints nothing while quiet, so a try that is retried stays off screen.
RECONCILING=0
EARLY_EXIT_QUIET=0

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
    jq -e --arg n "$want" '(.targets // .configurations)[] | select(.name == $n)' "$file" >/dev/null \
      || die "no target '$want' in $app (have: $(jq -r '[(.targets // .configurations)[].name] | join(", ")' "$file"))"
    printf '%s\n' "$want"
    return
  fi
  # No --target: resolve a SINGLE target only when unambiguous. One default,
  # or a sole target, is fine; a multi-target default set is not (callers that
  # act on one target, e.g. logs/stop-of-one, must pick).
  local count ndefault
  count=$(jq '(.targets // .configurations) | length' "$file")
  ndefault=$(jq '[(.targets // .configurations)[] | select(.default == true)] | length' "$file")
  if [ "$ndefault" = "1" ]; then
    jq -r 'first((.targets // .configurations)[] | select(.default == true) | .name)' "$file"
  elif [ "$ndefault" = "0" ] && [ "$count" = "1" ]; then
    jq -r '(.targets // .configurations)[0].name' "$file"
  elif [ "$ndefault" -gt 1 ]; then
    die "$app has multiple default targets - pass --target ($(jq -r '[(.targets // .configurations)[] | select(.default == true) | .name] | join(", ")' "$file"))"
  else
    die "$app has $count targets and no default - pass --target ($(jq -r '[(.targets // .configurations)[].name] | join(", ")' "$file"))"
  fi
}

# The targets started when --target is omitted, in declared (array) order:
# every target marked default, or the sole target when none is marked.
default_targets() {
  local app="$1" file marked
  file="$(require_launch "$app")"
  marked="$(jq -r '(.targets // .configurations)[] | select(.default == true) | .name' "$file")"
  if [ -n "$marked" ]; then
    printf '%s\n' "$marked"
  elif [ "$(jq '(.targets // .configurations) | length' "$file")" = "1" ]; then
    jq -r '(.targets // .configurations)[0].name' "$file"
  fi
}

field() { # field <app> <target> <jq-path>
  local file; file="$(launch_json "$1")"
  jq -r --arg n "$2" "(.targets // .configurations)[] | select(.name == \$n) | $3 // empty" "$file"
}

# The kernel's start time of a process: field 22 of /proc/<pid>/stat, in clock
# ticks since boot. Everything up to the last ") " is cut first, because the
# command name in field 2 may itself contain spaces or parentheses.
proc_start() { # proc_start <pid>
  local s
  s="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  s="${s##*) }"
  # shellcheck disable=SC2086
  set -- $s
  printf '%s\n' "${20:-}"
}

pid_of() { # pid_of <pidfile>: the pid, first field of the file
  local pid="" _rest
  read -r pid _rest <"$1" 2>/dev/null || true
  printf '%s\n' "$pid"
}

# A pid file holds "<pid> <start time>". The pid alone proves nothing after an
# apply: the file survives the recreate in the bind mount, and the number can
# belong to an unrelated process in the new container (#42) - `start` would skip
# a dead app and `stop` would signal a stranger. So the process only counts as
# ours when its start time matches too. A file without a start time (written by
# an older runtime, before the recreate that brought this one) is never trusted.
pid_alive() { # pid_alive <pidfile>
  local f="$1" pid="" start="" _rest
  [ -f "$f" ] || return 1
  read -r pid start _rest <"$f" 2>/dev/null || true
  [ -n "$pid" ] && [ -n "$start" ] || return 1
  [ "$(proc_start "$pid")" = "$start" ]
}

# Serialises "is it running? no, launch it, stamp its pid" across callers. After
# a container restart the entrypoint's reconcile and a host-side `monoceros
# start` can reach the same target at once, and without the lock both would see
# it down and launch it twice (#25). fd 9 is held from the check until the fresh
# pid is stamped; the launched command gets it closed, so an app never keeps it.
lock_launch() {
  mkdir -p "$WS/.monoceros/run"
  exec 9>"$WS/.monoceros/run/.lock"
  flock 9
}

unlock_launch() {
  flock -u 9
  exec 9>&-
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
    die "$app has multiple targets and no default - pass --target ($(jq -r '[(.targets // .configurations)[].name] | join(", ")' "$(require_launch "$app")"))"
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

  lock_launch
  if pid_alive "$pidf"; then
    unlock_launch
    target_line "${C_GREY}·${C_RESET}" "$target" \
      "${C_GREY}already running    pid $(pid_of "$pidf")${C_RESET}"
    return 0
  fi

  local command cwd port workdir ready_timeout ready_timeout_type
  command="$(field "$app" "$target" '.command')"
  cwd="$(field "$app" "$target" '.cwd')"
  port="$(field "$app" "$target" '.port')"
  # `jq -r` renders the string "20" and the number 20 identically, so the type
  # is read separately - the host-side parser only accepts a number, and the
  # two must not disagree about the same file.
  ready_timeout="$(field "$app" "$target" '.readyTimeout')"
  ready_timeout_type="$(field "$app" "$target" '(.readyTimeout | type)')"
  if [ -z "$ready_timeout" ]; then
    ready_timeout="$READY_TIMEOUT_DEFAULT"
  elif [ "$ready_timeout_type" != number ]; then
    die "invalid readyTimeout for $app/$target: '$ready_timeout' is a $ready_timeout_type, expected a number of seconds"
  fi
  case "$ready_timeout" in
    *[!0-9]*)
      die "invalid readyTimeout for $app/$target: '$ready_timeout' (expected whole seconds)"
      ;;
  esac
  [ "$ready_timeout" -gt 0 ] ||
    die "invalid readyTimeout for $app/$target: must be greater than 0"
  workdir="$WS/projects/$app"
  [ -n "$cwd" ] && workdir="$workdir/$cwd"
  [ -d "$workdir" ] || die "working directory does not exist: $workdir"

  # Extra env vars from the launch config, as KEY=VALUE args for `env`.
  local -a envargs=()
  local kv
  while IFS= read -r kv; do
    [ -n "$kv" ] && envargs+=("$kv")
  done < <(jq -r --arg n "$target" \
    '(.targets // .configurations)[] | select(.name == $n) | (.env // {}) | to_entries[] | "\(.key)=\(.value)"' \
    "$(launch_json "$app")")

  mkdir -p "$(run_dir "$app")" "$(log_dir "$app")"

  # Build the inner launch script. Each interpolated value is %q-quoted so
  # paths, env values and the command survive the nested shells intact.
  # The new process writes its pid to <target>.pid.new, not over <target>.pid:
  # during a reconcile the old file is still there, and waiting for it to be
  # non-empty would read the stale number back (#42). The old file stays as the
  # "wanted" marker until the fresh pid is stamped into it below.
  local newpidf="$pidf.new"
  rm -f "$newpidf"
  local q_pid q_wd q_log q_cmd envstr=""
  q_pid="$(printf '%q' "$newpidf")"
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
    </dev/null 9>&- &

  # Give the pid file a moment to appear (non-empty: `>` creates it before the
  # echo writes the number).
  local i
  for i in $(seq 1 50); do
    [ -s "$newpidf" ] && break
    sleep 0.1
  done
  [ -s "$newpidf" ] || die "failed to launch $app/$target (no pid recorded)"
  local pid start rellog
  pid="$(pid_of "$newpidf")"
  rm -f "$newpidf"
  # Stamp the pid with its start time, the identity pid_alive checks. exec
  # keeps both, so they stay valid for the command's lifetime. If the process
  # is already gone there is no start time, and pid_alive reports it dead.
  if start="$(proc_start "$pid")" && [ -n "$start" ]; then
    printf '%s %s\n' "$pid" "$start" >"$pidf"
  else
    printf '%s\n' "$pid" >"$pidf"
  fi
  unlock_launch
  rellog="${logf#"$WS"/}"

  # No readiness signal without a port: report started, point at the log.
  if [ -z "$port" ]; then
    if [ "$RECONCILING" = 1 ]; then
      sleep "$RECONCILE_NOPORT_GRACE"
      if ! pid_alive "$pidf"; then
        [ "$EARLY_EXIT_QUIET" = 1 ] && return 2
        target_line "${C_RED}✗${C_RESET}" "$target" \
          "exited right after start - see $rellog"
        return 2
      fi
    fi
    target_line "${C_GREEN}✓${C_RESET}" "$target" \
      "${C_GREY}started (no port to check)    pid $pid${C_RESET}"
    return 0
  fi

  # Readiness probe: wait until something actually listens on the port, so
  # "started" means "up" - not "spawned and maybe crashed". Bail if the
  # process group dies first, or if nothing binds within the window. Probed
  # every 0.2s, hence five ticks per declared second.
  for i in $(seq 1 $((ready_timeout * 5))); do
    if ! pid_alive "$pidf"; then
      [ "$EARLY_EXIT_QUIET" = 1 ] && return 2
      target_line "${C_RED}✗${C_RESET}" "$target" \
        "exited before binding port $port - see $rellog"
      return 2
    fi
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      exec 3>&- 2>/dev/null || true
      target_line "${C_GREEN}✓${C_RESET}" "$target" \
        "http://$NAME-$port.localhost    ${C_GREY}pid $pid${C_RESET}"
      return 0
    fi
    sleep 0.2
  done
  # Out of time. The process may well still be alive and mid-build, so say so
  # instead of implying it died - the fix is a longer window, not a restart.
  if pid_alive "$pidf"; then
    target_line "${C_RED}✗${C_RESET}" "$target" \
      "port $port still not listening after ${ready_timeout}s, process alive (raise readyTimeout) - see $rellog"
  else
    target_line "${C_RED}✗${C_RESET}" "$target" \
      "no listener on port $port after ${ready_timeout}s - see $rellog"
  fi
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
    die "$app has multiple targets and no default - pass --target ($(jq -r '[(.targets // .configurations)[].name] | join(", ")' "$(require_launch "$app")"))"
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
  pid="$(pid_of "$pidf")"
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
  # Follow only into a terminal. A human running this wants to watch; anything
  # reading the output through a pipe wants it to end - and an AI agent is the
  # common case here, because the briefing sends it to this command to check
  # its own work. `monoceros-ctl logs <app> | tail -3` from an agent's shell
  # tool blocked until the tool's 120s timeout, on a server that was fine.
  # Explicit `--follow` overrides, for `| grep --line-buffered` and friends.
  if [ "$follow" = "1" ] && [ ! -t 1 ]; then
    follow="0"
  fi
  if [ "$follow" != "0" ]; then
    exec tail -n +1 -F "$logf"
  else
    exec cat "$logf"
  fi
}

cmd_list() {
  local json="$1"
  local file app t pidf marker detail isdefault
  shopt -s nullglob globstar
  for file in "$WS"/projects/**/.monoceros/launch.json; do
    app="${file#"$WS"/projects/}"
    app="${app%/.monoceros/launch.json}"
    [ "$json" != "1" ] && hdr "$app"
    while IFS= read -r t; do
      pidf="$(run_dir "$app")/$t.pid"
      isdefault="$(jq -r --arg n "$t" '(.targets // .configurations)[] | select(.name == $n) | .default // false' "$file")"
      if [ "$json" = "1" ]; then list_one_json "$file" "$app" "$t" "$pidf" "$isdefault"; continue; fi
      if pid_alive "$pidf"; then
        marker="${C_GREEN}✓${C_RESET}"
        detail="running    ${C_GREY}pid $(pid_of "$pidf")${C_RESET}"
      else
        marker="${C_GREY}·${C_RESET}"
        detail="${C_GREY}stopped${C_RESET}"
      fi
      [ "$isdefault" = "true" ] && detail="$detail    ${C_GREY}(default)${C_RESET}"
      target_line "$marker" "$t" "$detail"
    done < <(jq -r '(.targets // .configurations)[].name' "$file")
  done
}

# Emit one target as a single-line JSON object (NDJSON, one per target). The
# host `monoceros status` parses this line-by-line - a machine-readable surface
# over the same liveness check the human `list` uses, so there is one source of
# truth and no ANSI to scrape. pid/port are JSON null when absent.
list_one_json() { # <launch.json> <app> <target> <pidfile> <isdefault>
  local file="$1" app="$2" t="$3" pidf="$4" isdefault="$5"
  local running pid port
  if pid_alive "$pidf"; then running=true; pid="$(pid_of "$pidf")"; else running=false; pid=null; fi
  port="$(jq -r --arg n "$t" '(.targets // .configurations)[] | select(.name == $n) | .port // empty' "$file")"
  [ -n "$port" ] || port=null
  [ "$isdefault" = "true" ] || isdefault=false
  jq -cn --arg app "$app" --arg target "$t" \
    --argjson running "$running" --argjson pid "$pid" \
    --argjson port "$port" --argjson dflt "$isdefault" \
    '{"app":$app,"target":$target,"running":$running,"pid":$pid,"port":$port,"default":$dflt}'
}

# Bring back every "wanted" target that isn't currently alive. The PRESENCE of
# a <target>.pid file is the want-marker: it is written by `start`, removed only
# by an explicit `stop`, and left behind (with a now-dead pid) when the process
# crashed or the container was recreated (`apply`) / restarted. Its CONTENT is
# the last pid and its start time, checked by pid_alive. So "pid file present but not
# alive" is exactly the set the builder wanted up that an apply/restart tore
# down - the set to restore. This is why no pre-teardown liveness snapshot is
# needed: the intent already persists across the recreate in the bind-mount.
#
# Best-effort: one target failing to come back never aborts the rest (unlike
# `start`'s fail-fast default set). Orphans are reaped, not resurrected: if the
# app's launch.json or the target is gone (config changed since it was started),
# the stale pid file is removed. We never signal an old pid - start_one only
# reads it to decide "already running", and writes a fresh one when it launches.
# That read is not a no-op after a recreate: a target reconcile restarts first
# can land on the pid another target's file still names, which is why pid_alive
# checks the start time too (#42).
# Across-target ordering is not guaranteed (declared order is `start`'s job);
# reconcile restores each independently-started server on its own. See ADR 0028.
cmd_reconcile() {
  local runroot="$WS/.monoceros/run"
  [ -d "$runroot" ] || return 0
  shopt -s nullglob globstar
  local pidf rel app target file last_app=""
  for pidf in "$runroot"/**/*.pid; do
    rel="${pidf#"$runroot"/}"           # <apprel>/<target>.pid
    target="$(basename "$rel" .pid)"
    app="$(dirname "$rel")"
    # A wanted target that is up is reported, not skipped silently: after a
    # container restart the entrypoint's pass may have brought it back before
    # a host-side `monoceros start` reconciles, and that start should still
    # list every app it restored (#25).
    if pid_alive "$pidf"; then
      if [ "$app" != "$last_app" ]; then hdr "$app"; last_app="$app"; fi
      target_line "${C_GREY}·${C_RESET}" "$target" \
        "${C_GREY}already running    pid $(pid_of "$pidf")${C_RESET}"
      continue
    fi
    file="$(launch_json "$app")"
    if [ ! -f "$file" ] || ! jq -e --arg n "$target" \
        '(.targets // .configurations)[] | select(.name == $n)' "$file" >/dev/null 2>&1; then
      rm -f "$pidf"                      # orphan: config or target gone - reap
      continue
    fi
    if [ "$app" != "$last_app" ]; then hdr "$app"; last_app="$app"; fi
    reconcile_one "$app" "$target"
  done
}

# Restore one target, retrying while it exits too early (before binding its
# port, or right after start without one): the sign of a service it needs that
# does not answer yet, whichever service that is. One grey line announces the
# wait; only the last try prints its result. Any other outcome (up, or a failure
# of another kind) ends it at once. Best-effort, never fails reconcile.
reconcile_one() {
  local app="$1" target="$2" deadline=$((SECONDS + RECONCILE_RETRY_SECONDS))
  local announced=0 rc
  while [ "$SECONDS" -lt "$deadline" ]; do
    rc=0
    RECONCILING=1 EARLY_EXIT_QUIET=1 start_one "$app" "$target" || rc=$?
    [ "$rc" = 2 ] || return 0
    if [ "$announced" = 0 ]; then
      target_line "${C_GREY}·${C_RESET}" "$target" \
        "${C_GREY}exited too early, retrying while the services start (up to ${RECONCILE_RETRY_SECONDS}s)${C_RESET}"
      announced=1
    fi
    sleep "$RECONCILE_RETRY_INTERVAL"
  done
  RECONCILING=1 start_one "$app" "$target" || true
}

main() {
  local sub="${1:-}"; shift || true
  local app="" target="" follow="1" json="0"
  # First non-flag positional is the app; --target takes a value.
  while [ $# -gt 0 ]; do
    case "$1" in
      --target) target="${2:-}"; shift 2 ;;
      --target=*) target="${1#--target=}"; shift ;;
      --no-follow) follow="0"; shift ;;
      --follow) follow="2"; shift ;;
      --json) json="1"; shift ;;
      -*) die "unknown flag: $1" ;;
      *) [ -z "$app" ] && app="$1"; shift ;;
    esac
  done

  case "$sub" in
    start) [ -n "$app" ] || die "usage: monoceros-ctl start <app> [--target <t>]"; cmd_start "$app" "$target" ;;
    stop)  [ -n "$app" ] || die "usage: monoceros-ctl stop <app> [--target <t>]";  cmd_stop "$app" "$target" ;;
    logs)  [ -n "$app" ] || die "usage: monoceros-ctl logs <app> [--target <t>] [--follow|--no-follow]"; cmd_logs "$app" "$target" "$follow" ;;
    list)  cmd_list "$json" ;;
    reconcile) cmd_reconcile ;;
    ""|-h|--help|help)
      cat <<'EOF'
monoceros-ctl — start/stop long-running app servers inside the container

  monoceros-ctl start <app> [--target <t>]   start an app's server (detached)
  monoceros-ctl stop  <app> [--target <t>]   stop it (kills the process group)
  monoceros-ctl logs  <app> [--target <t>]   follow its log on a terminal, dump
                                            it when piped (--follow/--no-follow
                                            to force either way)
  monoceros-ctl list [--json]                list apps, targets and run state
                                             (--json: NDJSON for `monoceros status`)
  monoceros-ctl reconcile                    restart every "wanted" target (one
                                             not cleanly stopped) that is down -
                                             run by `apply` after bring-up

<app> is a path under projects/ that carries .monoceros/launch.json.
--target defaults to the config marked "default" (or the only one).
EOF
      ;;
    *) die "unknown command: $sub (try --help)" ;;
  esac
}

main "$@"
