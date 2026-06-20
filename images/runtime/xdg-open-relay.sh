#!/bin/sh
# Monoceros host-browser-bridge relay (ADR 0022 follow-up).
#
# The container is headless and cannot open a browser, so a tool that wants to
# open a URL (`gh auth`, `glab auth`, the agent opening the running app, …)
# hands it here. We write the URL to `.monoceros-bridge/url` under the single
# workspace dir - that dir is bind-mounted to the host, where the bridge daemon
# (`monoceros __bridge`) watches the file and opens the URL in the HOST browser.
#
# Installed at /usr/local/bin/xdg-open (on PATH) and pointed at by $BROWSER, so
# both open conventions are relayed in EVERY session - including ones Monoceros
# does not spawn (an IDE / desktop-app SSH attach), not just `monoceros
# run`/`shell`. Self-healing: it recreates the relay dir if a `run`/`shell`
# session disposed it. Exits 0 unconditionally - a relay must never fail a tool.
url=$1
[ -n "$url" ] || exit 0
for ws in /workspaces/*/; do
  [ -d "$ws" ] || continue
  d="${ws}.monoceros-bridge"
  mkdir -p "$d" 2>/dev/null || exit 0
  printf '%s\n' "$url" > "$d/url" 2>/dev/null || exit 0
  exit 0
done
exit 0
