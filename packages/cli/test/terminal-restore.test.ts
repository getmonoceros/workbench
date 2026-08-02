import { describe, expect, it } from 'vitest';
import { restoreTerminalModes } from '../src/util/terminal-restore.js';

/**
 * `monoceros apply` recreates the container, so a TUI running in a
 * `monoceros shell` (opencode, claude, …) dies without undoing the terminal
 * modes it had set on the BUILDER's terminal. The symptom the builder sees is
 * escape junk on every mouse movement, in a terminal whose session is long
 * gone. The host side has to reset it, because nothing inside is left to do
 * it.
 */
describe('restoreTerminalModes', () => {
  function fakeTty(isTTY: boolean) {
    const writes: string[] = [];
    const stream = {
      isTTY,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    return { stream, writes };
  }

  it('turns off every mode an inner TUI can leave enabled', () => {
    const { stream, writes } = fakeTty(true);
    restoreTerminalModes(stream);
    const out = writes.join('');
    // The four mouse protocols. 1003 is the one that fires on plain movement,
    // which is what the builder actually sees as junk.
    expect(out).toContain('\u001b[?1000l');
    expect(out).toContain('\u001b[?1002l');
    expect(out).toContain('\u001b[?1003l');
    expect(out).toContain('\u001b[?1006l');
    // Focus events and bracketed paste produce the same class of junk.
    expect(out).toContain('\u001b[?1004l');
    expect(out).toContain('\u001b[?2004l');
    // Back to the normal screen, cursor visible, attributes reset.
    expect(out).toContain('\u001b[?1047l');
    expect(out).toContain('\u001b[?25h');
    expect(out).toContain('\u001b[0m');
  });

  it('leaves the alternate screen only after disabling the mouse modes', () => {
    const { stream, writes } = fakeTty(true);
    restoreTerminalModes(stream);
    const out = writes.join('');
    expect(out.indexOf('\u001b[?1003l')).toBeLessThan(
      out.indexOf('\u001b[?1047l'),
    );
    // Cursor and attribute resets land on the screen the builder keeps.
    expect(out.indexOf('\u001b[?1047l')).toBeLessThan(
      out.indexOf('\u001b[?25h'),
    );
  });

  /**
   * 1049 is 1047 plus an unconditional cursor restore (DECRC). A terminal that
   * follows xterm there (Ghostty does since 1.2.0) performs that restore even
   * when nothing ever entered the alternate screen: the cursor jumps back to a
   * stale saved position and the shell prompt redraws over output that was
   * already printed. `monoceros run <name> -- ls -la` showed its listing and
   * then lost it. Nothing in the sequence may move the cursor.
   */
  it('does not restore the cursor position, which would swallow output', () => {
    const { stream, writes } = fakeTty(true);
    restoreTerminalModes(stream);
    const out = writes.join('');
    expect(out).not.toContain('[?1049l'); // 1047 plus a cursor restore
    expect(out).not.toContain('[?1048l'); // the cursor restore on its own
    expect(out).not.toContain('[u'); // SCORC
    expect(out).not.toContain('[H'); // cursor home
  });

  it('is not a full reset — it must not clear the screen or the scrollback', () => {
    const { stream, writes } = fakeTty(true);
    restoreTerminalModes(stream);
    const out = writes.join('');
    expect(out).not.toContain('\u001b[2J'); // erase display
    expect(out).not.toContain('\u001b[3J'); // erase scrollback
    expect(out).not.toContain('\u001bc'); // full terminal reset
  });

  it('writes nothing when the stream is not a TTY', () => {
    const { stream, writes } = fakeTty(false);
    restoreTerminalModes(stream);
    expect(writes).toHaveLength(0);
  });
});
