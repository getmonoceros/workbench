#!/bin/sh
# Monoceros host-clipboard relay (ADR 0041, paste direction ADR 0048).
#
# The container has no clipboard of its own: no X server, no Wayland. A TUI
# that knows this writes an OSC 52 escape instead and lets the terminal do the
# copying - but Apple Terminal does not implement OSC 52 and drops it, and on
# macOS that is the terminal most people have (there is no default-terminal
# setting to point somewhere else). So a copy inside the container silently
# copies into the void.
#
# This rides the rails the browser bridge already uses: `.monoceros-bridge`
# under the workspace dir is bind-mounted to the host, where the bridge daemon
# (`monoceros __bridge`) sits on the other end.
#
# Both directions travel it. COPY writes the payload to `clipboard` and the
# host pipes it into the host clipboard. PASTE writes a request naming the
# target (`TARGETS`, `image/png`, `text/plain`, …), the host reads its own
# clipboard and answers with the bytes, and we hand them to stdout. Paste is
# what makes an image from the host clipboard reach a tool in the container:
# every CLI that supports pasting a screenshot probes `xclip -t TARGETS -o`
# first and then asks for `image/png`.
#
# Installed under the names tools actually probe for (xclip, xsel, wl-copy,
# wl-paste, pbcopy, pbpaste), so it works in EVERY session - including an IDE /
# desktop-app SSH attach, not just `monoceros run`/`shell`.
#
# Exit codes differ per direction, and deliberately. A copy exits 0 whatever
# happens: a relay must never fail the tool that called it. A paste reports
# failure when it has nothing, because callers chain on it
# (`xclip -t image/png -o > f || wl-paste --type image/png > f`) - exiting 0
# with no output would leave the caller holding an empty file it believes is
# an image.

# Copy or paste, decided the way the real tool would: xclip reads stdin unless
# told to output, xsel prints the selection unless told to read, and the
# pbcopy/wl-copy names only ever copy while pbpaste/wl-paste only ever paste.
# An explicit flag overrides the default.
case "${0##*/}" in
  xsel | wl-paste | pbpaste) mode=paste ;;
  *) mode=copy ;;
esac

# The target a paste asks for. `-t`/`--type` names it; `-l`/`--list-types`
# (wl-paste) is the same question xclip spells `-t TARGETS`. Default to plain
# text, which is what a bare `xclip -o` or `pbpaste` means.
target=text/plain
want_target=
for arg in "$@"; do
  if [ -n "$want_target" ]; then
    target=$arg
    want_target=
    continue
  fi
  case "$arg" in
    -o | -out | --output) mode=paste ;;
    -i | --input | -a | --append) mode=copy ;;
    -t | -target | --type) want_target=1 ;;
    --type=*) target=${arg#--type=} ;;
    -l | --list-types) target=TARGETS ;;
  esac
done

# Test/CI override; in a real container the single workspace dir wins.
dir=$MONOCEROS_BRIDGE_DIR
if [ -z "$dir" ]; then
  for ws in /workspaces/*/; do
    [ -d "$ws" ] || continue
    dir="${ws}.monoceros-bridge"
    break
  done
fi

if [ "$mode" = copy ]; then
  # Always drain stdin, even with nowhere to put it, so the caller writing into
  # our pipe never dies of EPIPE.
  if [ -z "$dir" ] || ! mkdir -p "$dir" 2>/dev/null; then
    cat > /dev/null 2>&1
    exit 0
  fi
  # Stage, then rename: the host takes the payload by renaming it away, so it
  # only ever sees a complete file, never a half-written one.
  tmp="$dir/.clipboard.$$"
  cat > "$tmp" 2>/dev/null || {
    rm -f "$tmp" 2>/dev/null
    exit 0
  }
  mv "$tmp" "$dir/clipboard" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  exit 0
fi

# --- paste ---------------------------------------------------------------
# Nothing to ask, so answer the way a real tool with an empty clipboard does.
[ -n "$dir" ] && mkdir -p "$dir" 2>/dev/null || exit 1

# How long to wait for the host to answer. The round trip is a poll on a bind
# mount on both sides, so it is tens of milliseconds in practice; the ceiling
# only matters when nothing is listening - an older CLI, or no bridge running -
# and there we want to fail rather than hang a keystroke.
timeout_ms=${MONOCEROS_CLIPBOARD_TIMEOUT_MS:-2000}

req="$dir/paste-req.$$"
res="$dir/paste-res.$$"
rm -f "$res" 2>/dev/null

# Stage and rename here too: the host must never read a request whose target
# is still half-written.
printf '%s' "$target" > "$req.tmp" 2>/dev/null || exit 1
mv "$req.tmp" "$req" 2>/dev/null || {
  rm -f "$req.tmp" 2>/dev/null
  exit 1
}

# Poll for the answer. The host stages its response the same way, so the file
# appearing means the whole payload is there.
waited=0
while [ ! -e "$res" ]; do
  if [ "$waited" -ge "$timeout_ms" ]; then
    rm -f "$req" 2>/dev/null
    exit 1
  fi
  sleep 0.02
  waited=$((waited + 20))
done

# An empty response is the host saying "the clipboard holds nothing of that
# target" - report it as the real tool would, with no output and a failure.
if [ -s "$res" ]; then
  cat "$res"
  rm -f "$res" 2>/dev/null
  exit 0
fi
rm -f "$res" 2>/dev/null
exit 1
