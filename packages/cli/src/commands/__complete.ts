import { defineCommand } from 'citty';
import { resolveCompletions } from '../completion/resolve.js';

/**
 * Internal CLI entrypoint shell-completion scripts call. NOT part of
 * the user-facing surface — the leading `__` keeps it out of typical
 * help listings. Generated bash / zsh / pwsh wrappers (see
 * `commands/completion.ts`) call this with the current command-line
 * and cursor position, and emit each line of stdout as a candidate
 * completion.
 *
 * Contract (must stay stable; the shipped wrappers depend on it):
 *
 *   monoceros __complete --line "<full line>" --point <N>
 *
 *   - Exit 0 always (errors → empty output; completion is a comfort
 *     feature, never a fatal one).
 *   - Output: one candidate per line, no decorations, no escapes.
 *   - Comma-separated value flags (`--with-features=github,claude`) get
 *     returned with the leading prefix already attached so the shell inserts
 *     the full token in place — see resolveValues in resolve.ts.
 */

export const __completeCommand = defineCommand({
  meta: {
    name: '__complete',
    group: 'internal',
    description:
      'Internal — shell completion engine. Used by the wrappers emitted by `monoceros completion <shell>`. Output one candidate completion per line.',
  },
  args: {
    line: {
      type: 'string',
      description:
        'Full command line buffer up to (and possibly past) the cursor.',
      default: '',
    },
    point: {
      type: 'string',
      description:
        'Byte offset of the cursor within --line. Default: end of line.',
      default: '',
    },
  },
  async run({ args }) {
    const line = String(args.line ?? '');
    const point =
      args.point && String(args.point).length > 0
        ? Number.parseInt(String(args.point), 10)
        : line.length;
    let candidates: string[];
    try {
      candidates = await resolveCompletions(
        line,
        Number.isFinite(point) ? point : line.length,
      );
    } catch {
      // Never fail the shell's completion request — silent empty
      // suggestion is the worst it should ever be.
      candidates = [];
    }
    if (candidates.length > 0) {
      process.stdout.write(candidates.join('\n') + '\n');
    }
  },
});
