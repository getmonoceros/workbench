# ADR 0048: Pasting reads the host clipboard, not just copying writing to it

- Status: accepted
- Date: 2026-08-08
- Amends: [ADR 0041](0041-clipboard-relay-to-the-host.md)

## Context

ADR 0041 built the clipboard relay in one direction and said so
plainly: copying inside the container reaches the host clipboard, and
"pasting back needs nothing new - the text is on the host clipboard, so
`Cmd`+`V` in the terminal is an ordinary paste, which is also why the
relay does not implement a paste direction".

That reasoning holds for text and only for text. A terminal paste is
the terminal typing characters into the session. An image has no
characters. So the one thing terminals cannot paste is exactly the
thing developers paste most often into an AI coding tool: a screenshot.

Every such tool reaches for the clipboard the same way. Claude Code's
Linux branch is representative:

```
xclip -selection clipboard -t TARGETS -o | grep -E "image/(png|jpeg|…)"
xclip -selection clipboard -t image/png -o > <file>
  || wl-paste --type image/png > <file>
  || xclip -selection clipboard -t image/bmp -o > <file>
```

All four are output-mode invocations, and the relay answered every one
of them with `exit 0` and no output - by design. The probe found no
image and the tool reported an empty clipboard, in a session where the
host clipboard demonstrably held a PNG. Nothing failed loudly; the
feature simply did not exist and looked like a bug in the tool.

The cost is not cosmetic. Pasting a screenshot of a broken layout into
the agent is how frontend work with an AI tool actually proceeds. A
workbench where that does not work pushes anyone doing UI work back
onto the host, which is the one thing the workbench exists to avoid.

The alternatives were worse. Forwarding X11 or Wayland into the
container to get a real `xclip` means running a display server for a
clipboard. Telling people to save the screenshot to the workspace and
reference it by path replaces one keystroke with a file, a path and a
cleanup, and puts the file in a directory that belongs to Monoceros
rather than to the user.

## Decision

Carry the paste direction over the rails the copy direction already
uses, and make the container behave the way it would on the host.

**In the container**, the relay script gains an output mode. It parses
the target the caller asked for - `-t`/`--type`, with `-l` and
`--list-types` meaning the same question `xclip` spells `-t TARGETS` -
writes a request naming that target into the relay dir, and waits for
an answer to appear. It is installed under two more names, `wl-paste`
and `pbpaste`, because those only ever paste.

**On the host**, the bridge answers from its own clipboard: `TARGETS`
becomes the MIME type list (translated out of `clipboard info` on
macOS, out of `Clipboard::ContainsImage` on Windows, passed through to
the real tools on Linux), and a concrete target becomes the bytes.
Requests are taken by rename, the same handover the copy direction
uses, so the per-session bridge and the always-on daemon cannot answer
the same request twice.

**A paste reports failure when it has nothing**, which is the one place
the two directions deliberately differ. A copy still exits 0 whatever
happens, because a relay must never fail the tool that called it. But
callers chain pastes on the exit code, and a paste that exits 0 with no
output leaves the caller holding an empty file it believes is a PNG.

The payload travels as a file in the relay dir, staged and renamed on
both ends, so neither side ever reads a half-written image.

## Consequences

Pasting an image from the host clipboard now works in every session
type and every terminal, for every tool that probes for a clipboard
binary - the CLI that prompted this, and any other one, since the
contract implemented is the tools' own, not one tool's.

Any process in the container can now read the host clipboard, where
before it could only write to it. That is a real widening: a clipboard
often holds a password on its way to a login form. It is the same
boundary ADR 0041 already crossed in the other direction and the
browser relay crosses when it opens a URL, and it is the cost of a
headless container that has to reach a human at a desktop. Worth
naming, and worth knowing: a container is not a security boundary
against the workspace it was given.

Reading is on request rather than on a poll, so the bridge touches the
clipboard only when something inside actually asks for it. The daemon
never watches what the user copies.

A paste blocks until the host answers, with a 2 second ceiling. Under
the bind-mount poll on both ends the round trip is tens of
milliseconds; the ceiling only matters when nothing is listening - an
older CLI, or no bridge running - and there failing beats hanging a
keystroke.

Requires runtime image >= 1.9.0 for the output mode and the two new
names, and CLI >= 1.54.0 for the host-side answerer. An older image
with a new CLI never writes a request; a new image with an older CLI
writes requests nobody answers and pastes fail as they did before.
