/**
 * Put the builder's terminal back into a sane state after an interactive
 * session ends.
 *
 * Why this is needed: a TUI inside the container (opencode, claude, lazygit,
 * htop, …) switches the terminal into modes that live on the HOST terminal,
 * not in the container — mouse reporting, the alternate screen, bracketed
 * paste, focus events, a hidden cursor. It undoes them when it exits
 * normally. It does not get the chance when the container is pulled out from
 * under it, which is exactly what `monoceros apply` does: it recreates the
 * container, every process inside dies at once, and the session's terminal is
 * left in whatever mode the TUI had set. The symptom is a terminal that
 * prints escape junk on every mouse movement, and it outlives the session
 * that caused it.
 *
 * Since a `docker exec` cannot be asked to clean up after a process that is
 * already gone, the host side does it: whoever attached the TTY resets it
 * when the session ends, for whatever reason.
 *
 * Deliberately NOT a full `reset`: that would clear the scrollback and drop
 * the builder's history. This only turns off the modes an inner TUI can have
 * turned on, so a session that left the terminal alone sees no difference.
 */

/**
 * Disable mouse reporting (all four protocols), focus events, bracketed
 * paste, leave the alternate screen, show the cursor, reset attributes. Sent
 * in that order so the cursor and attribute resets land on the screen the
 * builder ends up looking at.
 *
 * The alternate screen is left with 1047, not 1049. 1049 is 1047 plus a cursor
 * restore (DECRC), and xterm does that restore unconditionally - even when the
 * terminal was never in the alternate screen at all. Terminals that follow
 * xterm here (Ghostty does since 1.2.0) then move the cursor back to a stale
 * saved position, and the shell prompt redraws over output that was already
 * printed: a plain `monoceros run <name> -- ls -la` lost its listing that way.
 * 1047 is a true no-op on the primary screen and still gets a TUI that died
 * mid-flight out of the alternate one, which is all this has to do.
 */
const RESTORE_SEQUENCE = [
  '\u001b[?1000l', // X10 / normal mouse tracking
  '\u001b[?1002l', // button-event tracking
  '\u001b[?1003l', // any-event tracking (the one that fires on plain moves)
  '\u001b[?1006l', // SGR extended coordinates
  '\u001b[?1004l', // focus in/out reporting
  '\u001b[?2004l', // bracketed paste
  '\u001b[?1047l', // leave alternate screen (no cursor restore, see above)
  '\u001b[?25h', // show cursor
  '\u001b[0m', // reset attributes
].join('');

/**
 * Write the restore sequence to `stream` when it is a TTY. A no-op
 * otherwise, so piping `monoceros shell` output into a file does not get
 * escape codes appended.
 */
export function restoreTerminalModes(
  stream: NodeJS.WriteStream = process.stdout,
): void {
  if (!stream.isTTY) return;
  stream.write(RESTORE_SEQUENCE);
}
