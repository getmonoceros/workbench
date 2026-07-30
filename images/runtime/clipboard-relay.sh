#!/bin/sh
# Monoceros host-clipboard relay (ADR 0041).
#
# The container has no clipboard of its own: no X server, no Wayland. A TUI
# that knows this writes an OSC 52 escape instead and lets the terminal do the
# copying - but Apple Terminal does not implement OSC 52 and drops it, and on
# macOS that is the terminal most people have (there is no default-terminal
# setting to point somewhere else). So a copy inside the container silently
# copies into the void.
#
# This is the copy side of the relay the browser bridge already uses: we write
# the payload to `.monoceros-bridge/clipboard` under the workspace dir - that
# dir is bind-mounted to the host, where the bridge daemon (`monoceros
# __bridge`) takes the payload and pipes it into the HOST clipboard.
#
# Installed under the names tools actually probe for (xclip, xsel, wl-copy,
# pbcopy), so it works in EVERY session - including an IDE / desktop-app SSH
# attach, not just `monoceros run`/`shell`. Paste/output invocations (`xclip
# -o`, a bare `xsel`, …) produce nothing on purpose: the copied text is on the
# HOST clipboard, so pasting it back is an ordinary terminal paste. Exits 0
# unconditionally - a relay must never fail the tool that called it.

# Copy or paste, decided the way the real tool would: xclip reads stdin unless
# told to output, xsel prints the selection unless told to read, and the
# pbcopy/wl-copy names only ever copy. An explicit flag overrides the default.
case "${0##*/}" in
  xsel) mode=paste ;;
  *) mode=copy ;;
esac
for arg in "$@"; do
  case "$arg" in
    -o | -out | --output) mode=paste ;;
    -i | --input | -a | --append) mode=copy ;;
  esac
done
[ "$mode" = copy ] || exit 0

# Test/CI override; in a real container the single workspace dir wins.
dir=$MONOCEROS_BRIDGE_DIR
if [ -z "$dir" ]; then
  for ws in /workspaces/*/; do
    [ -d "$ws" ] || continue
    dir="${ws}.monoceros-bridge"
    break
  done
fi
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
