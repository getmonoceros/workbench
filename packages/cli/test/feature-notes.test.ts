import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatFeatureNotes,
  NOTES_DIRNAME,
  notesDirInContainer,
  readFeatureNotes,
} from '../src/create/feature-notes.js';
import { stripAnsi } from '../src/util/format.js';

describe('feature notes', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-notes-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (name: string, body: string): Promise<void> => {
    const dir = path.join(root, NOTES_DIRNAME);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), body);
  };

  it('reads one note per line, sorted by feature', async () => {
    await write('forge.txt', 'forge is 13.0.0, not 13.3.0\nPin a Node.\n');
    await write('acli.txt', 'Rovo Dev is unauthenticated.\n');
    expect(await readFeatureNotes(root)).toEqual([
      { feature: 'acli', lines: ['Rovo Dev is unauthenticated.'] },
      {
        feature: 'forge',
        lines: ['forge is 13.0.0, not 13.3.0', 'Pin a Node.'],
      },
    ]);
  });

  it('skips blank lines and files that carry nothing', async () => {
    await write('empty.txt', '\n  \n');
    await write('real.txt', '\nsomething\n\n');
    expect(await readFeatureNotes(root)).toEqual([
      { feature: 'real', lines: ['something'] },
    ]);
  });

  it('ignores anything that is not a .txt note', async () => {
    await write('notes.json', '{"nope":true}');
    expect(await readFeatureNotes(root)).toEqual([]);
  });

  it('treats an absent dir as no notes, never as an error', async () => {
    expect(await readFeatureNotes(root)).toEqual([]);
    expect(await readFeatureNotes(path.join(root, 'nope'))).toEqual([]);
  });

  it('renders as a warning block, same vocabulary as the repo-access one', () => {
    const block = stripAnsi(
      formatFeatureNotes([
        { feature: 'atlassian-forge', lines: ['held at 13.0.0', 'pin a node'] },
      ]),
    );
    expect(block.split('\n')).toEqual([
      '⚠  Feature notes',
      '',
      '   atlassian-forge',
      '     • held at 13.0.0',
      '     • pin a node',
    ]);
  });

  it('separates two features with a blank line, and ends without one', () => {
    const block = stripAnsi(
      formatFeatureNotes([
        { feature: 'a', lines: ['one'] },
        { feature: 'b', lines: ['two'] },
      ]),
    );
    expect(block.endsWith('two')).toBe(true);
    expect(block).toContain('   a\n     • one\n\n   b');
  });

  it('wraps a long note under a hanging indent', () => {
    const long = `word `.repeat(30).trim();
    const block = stripAnsi(
      formatFeatureNotes([{ feature: 'x', lines: [long] }]),
    );
    const body = block.split('\n').slice(2);
    expect(body.length).toBeGreaterThan(2);
    expect(body[1]).toMatch(/^ {5}• /);
    // Continuations line up under the bullet's text, not under the bullet.
    expect(body[2]).toMatch(/^ {7}\S/);
    for (const line of body) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('points at the workspace path the post-create copy writes to', () => {
    expect(notesDirInContainer('acme')).toBe(
      '/workspaces/acme/.monoceros/notes',
    );
  });
});
