#!/usr/bin/env bash
#
# Monoceros uninstaller — macOS + Linux (+ WSL). Reverses install.sh.
#
# Run from a terminal: pick a scope with the arrow keys.
#   Keep ~/.monoceros  - tear down each container via `monoceros remove`
#                        (backed up to container-backups/ first), purge the
#                        Monoceros images, remove the CLI + shell wiring. Your
#                        configs + backups stay, so a reinstall resumes.
#   Everything         - same with --no-backup, plus delete ~/.monoceros.
#
# Piped (`curl | bash`, which can't prompt): pass --purge for "everything",
# otherwise the default is to keep ~/.monoceros. Other tools' Docker
# images/volumes are never touched. Re-runnable.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "This uninstaller requires bash. Re-run with:" >&2
  echo "    curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/uninstall.sh | bash" >&2
  exit 1
fi
set -euo pipefail

PACKAGE="@getmonoceros/workbench"
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# ── Pretty printing (palette matches install.sh) ───────────────────
if [[ -t 2 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'
  GREY=$'\033[90m'; BOLD=$'\033[1m'; UNDERLINE=$'\033[4m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; CYAN=""; GREY=""; BOLD=""; UNDERLINE=""; RESET=""
fi
say()  { printf '%s\n' "$*" >&2; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*" >&2; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
dim()  { printf '%s%s%s' "$GREY" "$*" "$RESET"; }

# ── Arrow-key single-select menu. Sets REPLY_IDX (0-based) or -1 on cancel. ─
menu_select() {
  local prompt="$1"; shift
  local opts=("$@") n=${#opts[@]} sel=0 first=1 key rest i
  printf '%s\n' "  $prompt" >&2
  printf '\033[?25l' >&2   # hide cursor
  while true; do
    if [ "$first" -eq 0 ]; then printf '\033[%dA' "$n" >&2; fi
    first=0
    for i in "${!opts[@]}"; do
      if [ "$i" -eq "$sel" ]; then printf '\033[2K  %s> %s%s\n' "$CYAN" "${opts[$i]}" "$RESET" >&2
      else printf '\033[2K    %s\n' "${opts[$i]}" >&2; fi
    done
    IFS= read -rsn1 key </dev/tty 2>/dev/null || true
    # -t 1 (integer): bash 3.2 on macOS rejects fractional timeouts. Arrow bytes
    # arrive as a burst so this returns instantly; only a lone Esc waits ~1s.
    if [ "$key" = $'\033' ]; then read -rsn2 -t 1 rest </dev/tty 2>/dev/null || true; key+="$rest"; fi
    case "$key" in
      $'\033[A'|k) sel=$(( (sel - 1 + n) % n )) ;;
      $'\033[B'|j) sel=$(( (sel + 1) % n )) ;;
      ''|$'\n')    REPLY_IDX=$sel; printf '\033[?25h' >&2; return 0 ;;
      $'\033'|q|Q) REPLY_IDX=-1;   printf '\033[?25h' >&2; return 0 ;;
    esac
  done
}

say ""
say "${BOLD}Monoceros uninstaller${RESET}"
say ""

# ── Scope: arrow menu when a terminal is reachable (works under `curl | bash`
#    too, where stdin is the pipe but /dev/tty is the terminal); else --purge. ─
if [ "$PURGE" -eq 0 ] && [ -r /dev/tty ]; then
  menu_select "What should be removed?  ($(dim 'Up/Down, Enter'))" \
    "Remove Monoceros, keep ~/.monoceros (configs + backups, resume later)" \
    "Remove everything, including ~/.monoceros" \
    "Cancel"
  case "$REPLY_IDX" in
    0) PURGE=0 ;;
    1)
      PURGE=1
      say ""
      warn "This deletes ~/.monoceros (configs + backups) and cannot be undone."
      printf "  Type %smonoceros%s to confirm: " "$BOLD" "$RESET" >&2
      read -r confirm </dev/tty 2>/dev/null || true
      if [ "${confirm:-}" != "monoceros" ]; then say ""; warn "Not confirmed - nothing changed."; exit 0; fi
      ;;
    *) say ""; say "  Cancelled - nothing changed."; exit 0 ;;
  esac
fi
say ""

# ── Resolve the CLI (PATH, or install.sh's per-user ~/.local prefix) ──
BIN="$(command -v monoceros 2>/dev/null || true)"
if [ -z "$BIN" ] && [ -x "$HOME/.local/bin/monoceros" ]; then BIN="$HOME/.local/bin/monoceros"; fi

# ── 1. Docker objects (via `monoceros remove`) + images ────────────
if [ -n "$BIN" ]; then
  shopt -s nullglob
  names=()
  for f in "$HOME"/.monoceros/container-configs/*.yml; do names+=("$(basename "$f" .yml)"); done
  shopt -u nullglob

  if [ "${#names[@]}" -eq 0 ]; then
    ok "No containers to remove."
  else
    flags=(-y); if [ "$PURGE" -eq 1 ]; then flags+=(--no-backup); fi
    for n in "${names[@]}"; do
      if ! out="$("$BIN" remove "$n" "${flags[@]}" 2>&1)"; then
        warn "Could not remove container '$n':"
        errlines="$(printf '%s\n' "$out" | grep -iE 'error|denied|eacces|failed' || true)"
        if [ -z "$errlines" ]; then errlines="$(printf '%s\n' "$out" | tail -n 2)"; fi
        printf '%s\n' "$errlines" | sed 's/^/      /' >&2
        say ""
        warn "Stopped. The CLI and your data were left untouched. Resolve the above and re-run."
        exit 1
      fi
    done
    if [ "$PURGE" -eq 1 ]; then ok "Removed ${#names[@]} container(s)."; else ok "Removed ${#names[@]} container(s), backed up first."; fi
  fi

  imgs="$(docker images --filter 'reference=*monoceros-runtime*' -q 2>/dev/null | sort -u || true)"
  if [ -n "$imgs" ]; then
    # shellcheck disable=SC2086
    docker rmi $imgs >/dev/null 2>&1 || true
    ok "Purged Monoceros Docker images (best-effort)."
  fi
else
  say "  $(dim "No Monoceros CLI found - skipping container/image cleanup.")"
fi

# ── 2. The CLI (global, or the per-user ~/.local prefix) ───────────
if command -v npm >/dev/null 2>&1; then
  npm uninstall -g "$PACKAGE" >/dev/null 2>&1 || true
  npm uninstall -g --prefix "$HOME/.local" "$PACKAGE" >/dev/null 2>&1 || true
  ok "Removed the Monoceros CLI."
else
  say "  $(dim "npm not found - skipping CLI removal.")"
fi

# ── 3. Completion files + the rc blocks install.sh appended ────────
rm -f "$HOME/.zsh/completions/_monoceros" \
      "$HOME/.oh-my-zsh/completions/_monoceros" \
      "$HOME/.bash_completion.d/monoceros" 2>/dev/null || true
M1="# monoceros: per-user npm prefix on PATH"
M2="# monoceros completion (managed by install.sh)"
strip_rc() {
  rc="$1"
  [ -f "$rc" ] || return 0
  if ! grep -qxF "$M1" "$rc" && ! grep -qxF "$M2" "$rc"; then return 0; fi
  tmp="$(mktemp)"
  awk -v m1="$M1" -v m2="$M2" '
    $0==m1 || $0==m2 { skip=1; next }
    skip==1 && $0=="" { skip=0; next }
    skip==1 { next }
    { print }
  ' "$rc" > "$tmp"
  cat "$tmp" > "$rc"; rm -f "$tmp"
}
strip_rc "$HOME/.bashrc"; strip_rc "$HOME/.zshrc"
ok "Removed the CLI's PATH/completion lines."

# ── 4. Data — kept unless purge ────────────────────────────────────
if [ "$PURGE" -eq 1 ]; then
  rm -rf "$HOME/.monoceros" 2>/dev/null || true
  # Backups can hold root-owned files (postgres data, 0600 SSH host keys) the
  # unprivileged user can't unlink. Fall back to a throw-away alpine (root).
  if [ -d "$HOME/.monoceros" ] && command -v docker >/dev/null 2>&1; then
    docker run --rm -v "$HOME/.monoceros:/t" alpine:3.21 find /t -mindepth 1 -delete >/dev/null 2>&1 || true
    rmdir "$HOME/.monoceros" 2>/dev/null || true
  fi
  if [ -d "$HOME/.monoceros" ]; then
    warn "Could not fully remove ~/.monoceros (root-owned files). Remove with: sudo rm -rf ~/.monoceros"
  else
    ok "Removed ~/.monoceros."
  fi
else
  say "  $(dim "Kept ~/.monoceros (configs + backups). Use --purge to remove it too.")"
fi

say ""
ok "Monoceros uninstalled."
say ""
