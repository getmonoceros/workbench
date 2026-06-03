import { describe, expect, it } from 'vitest';
import { renderUsageBlock } from '../src/help.js';
import { main } from '../src/main.js';

// Strip ANSI so assertions match the visible text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI_RE, '');

describe('renderUsageBlock — top-level COMMANDS', () => {
  const out = plain(renderUsageBlock(main, ['monoceros']));

  it('hides the completion + __complete commands from help', () => {
    // Lines listing a command start with the command name flush-left.
    expect(out).not.toMatch(/^completion\b/m);
    expect(out).not.toMatch(/^__complete\b/m);
    // Their now-empty groups drop out too.
    expect(out).not.toContain('Tooling');
    expect(out).not.toMatch(/^internal$/m);
  });

  it('still lists the real commands, grouped', () => {
    expect(out).toMatch(/^init\b/m);
    expect(out).toMatch(/^add-service\b/m);
    expect(out).toMatch(/^tunnel\b/m);
    expect(out).toContain('Edit container yml');
    expect(out).toContain('Discovery');
  });

  it('aligns every command description at the same column (uniform across groups)', () => {
    // Take the description-start column for a short-named command and a
    // long-named one from different groups; they must match.
    const lines = out.split('\n');
    const colOf = (name: string): number => {
      const line = lines.find((l) => new RegExp(`^${name}\\s{2,}`).test(l));
      if (!line) throw new Error(`no command line for ${name}`);
      return line.length - line.replace(/^[^ ]+\s+/, '').length;
    };
    // `run` (3 chars) and `add-apt-packages` (16 chars) live in
    // different groups; their description columns must line up.
    expect(colOf('run')).toBe(colOf('add-apt-packages'));
  });

  it('puts a blank line between command entries', () => {
    // `shell` (single-line desc) is immediately followed by a blank
    // line, then the `run` entry.
    expect(out).toMatch(/^shell\b[^\n]*\n\nrun\b/m);
  });
});
