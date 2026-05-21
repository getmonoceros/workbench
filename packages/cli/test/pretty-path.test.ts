import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prettyPath } from '../src/config/paths.js';

const home = os.homedir();

describe('prettyPath', () => {
  it('collapses a $HOME prefix to ~', () => {
    expect(prettyPath(path.join(home, '.monoceros', 'container-configs'))).toBe(
      `~${path.sep}.monoceros${path.sep}container-configs`,
    );
  });

  it('returns ~ for exactly $HOME', () => {
    expect(prettyPath(home)).toBe('~');
  });

  it('leaves paths outside $HOME untouched', () => {
    expect(prettyPath('/tmp/foo/bar')).toBe('/tmp/foo/bar');
    expect(prettyPath('/usr/local/bin/monoceros')).toBe(
      '/usr/local/bin/monoceros',
    );
  });

  it("does not match a directory that starts with $HOME's name but is not a child", () => {
    // e.g. $HOME = /Users/x, path = /Users/xyz/... — must NOT be
    // collapsed.
    const sibling = home + 'xyz';
    expect(prettyPath(sibling)).toBe(sibling);
  });
});
