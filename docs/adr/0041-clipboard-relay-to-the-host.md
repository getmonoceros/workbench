# ADR 0041: Copying in the container reaches the host clipboard

- Status: accepted
- Date: 2026-07-30
- Amended by: [ADR 0048](0048-pasting-reaches-the-host-clipboard-too.md), which
  adds the paste direction this one left out

## Context

Copying text out of a tool that runs inside the container did not
work. Not "worked badly" - the copy went nowhere and nothing said so.

A container has no clipboard. There is no X server, no Wayland
compositor, and no macOS pasteboard. A terminal program that wants to
put text on the user's clipboard therefore has two ways out, and in a
Monoceros container both of them are closed:

1. **OSC 52.** The program writes `ESC ]52;c;<base64>BEL` to stdout and
   the terminal emulator does the copying. This is the mechanism built
   for exactly this situation - it travels over SSH, `docker exec` and
   anything else that carries a TTY. But the terminal has to implement
   it, and Apple Terminal does not: it swallows the sequence. On macOS
   that is not an edge case, it is the common case. macOS has no
   default-terminal setting, so Spotlight always opens Apple Terminal,
   and a user who never chose a terminal has that one.
2. **A clipboard binary.** The program shells out to `xclip`, `xsel`,
   `wl-copy` or `pbcopy`. The runtime image installs none of them, and
   even a real `xclip` would have no display to talk to.

OpenCode makes the point concretely: its copy path emits OSC 52 _and_
then calls whichever clipboard binary a `which` probe finds. Both
halves are dead here, and because both fail silently by design (a
clipboard error must not crash a TUI), the user sees a successful copy
and an unchanged clipboard.

Telling people to switch terminals is not an answer. It shifts a
workbench defect onto every user, and on macOS it does not even stick.

The mirror-image problem is already solved. A container cannot open a
browser either, so the runtime ships a relay `xdg-open` that writes the
URL to a file in the bind-mounted `.monoceros-bridge` dir, and a
host-side watcher - the per-session bridge for `run`/`shell`, the
always-on `monoceros __bridge` daemon for everything else - opens it on
the host (ADR 0022 follow-up).

## Decision

Relay the clipboard over the same rails, in the other direction.

**In the container**, one relay script installed under the names tools
actually probe for - `xclip`, `xsel`, `wl-copy`, `pbcopy`, as symlinks
so the script can tell from `$0` which tool it is standing in for. It
reads stdin and writes the payload to `.monoceros-bridge/clipboard`,
staging to a temp file and renaming into place so a reader never sees a
half-written payload. Copy or paste is decided the way the real tool
would decide it: `xclip` reads stdin unless told to output, `xsel`
prints unless told to read, and an explicit `-o`/`-i` flag wins. The
script exits 0 whatever happens - a relay must never fail the tool that
called it.

Being in the image rather than in a per-session PATH prepend is what
makes this work in an IDE or desktop-app SSH attach, not just in
`monoceros run`/`shell`.

**On the host**, the bridge takes the payload - renaming the file away
first, then reading it - and pipes it into the host's own clipboard:
`pbcopy` on macOS, PowerShell's `Set-Clipboard` on Windows and from
WSL, `wl-copy`/`xclip`/`xsel` on Linux, tried in order so a missing
tool falls through instead of losing the copy. Both the per-session
bridge and the always-on daemon run this watcher; the rename is the
handover, so two watchers can never relay the same payload twice.

The terminal is not involved at any point, which is the whole point:
Apple Terminal cannot break what it never sees.

## Consequences

Copying inside the container now lands on the host clipboard in every
session type and in every terminal. Pasting back needs nothing new -
the text is on the host clipboard, so `Cmd`+`V` in the terminal is an
ordinary paste, which is also why the relay does not implement a paste
direction: output-mode invocations produce nothing.

> That last conclusion was wrong, and ADR 0048 reverses it. It holds
> for text only. An image has no characters for a terminal to type, so
> a screenshot on the host clipboard could not reach a tool inside the
> container at all - and pasting a screenshot into an AI coding tool is
> the common case, not an edge case.

A tool that speaks **only** OSC 52 and never calls a clipboard binary
stays uncovered. Catching those would mean proxying the session through
a PTY to scan the byte stream, which breaks the direct-TTY passthrough
`devcontainer/cli.ts` deliberately keeps and would not help an SSH
attach anyway. Not worth it for the tools we actually ship.

The shims shadow a real `xclip` an apt-packages feature may install,
because `/usr/local/bin` precedes `/usr/bin`. That is the intent: the
real one has no display either.

Any process in the container can put text on the host clipboard. That
is a widening of the container's reach onto the host, and it is the
same boundary the browser relay already crosses when it opens an
arbitrary URL. Worth naming, not worth blocking: both are the cost of
a headless container that has to reach a human sitting at a desktop.

The payload lives on disk only between the copy and the take, in the
container directory - not inside any project repo, so it cannot be
committed by accident. A payload left behind by an earlier session is
deleted when a bridge starts, so a stale copy never hijacks the
clipboard.

Requires runtime image >= 1.7.0 for the shims and CLI >= 1.46.0 for the
host watcher. An older image with a new CLI simply never writes the
file; a new image with an older CLI writes a file nobody takes.
