import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findSolutionRoot } from '../src/locate.js';

interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'monoceros-plugin-locate-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('findSolutionRoot', () => {
  let fix: Fixture;
  beforeEach(async () => {
    fix = await makeFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it('returns the directory containing .monoceros/', async () => {
    await mkdir(path.join(fix.root, '.monoceros'), { recursive: true });
    expect(await findSolutionRoot(fix.root)).toBe(fix.root);
  });

  it('returns the directory containing .devcontainer/', async () => {
    await mkdir(path.join(fix.root, '.devcontainer'), { recursive: true });
    expect(await findSolutionRoot(fix.root)).toBe(fix.root);
  });

  it('walks upward to find the marker', async () => {
    await mkdir(path.join(fix.root, '.monoceros'), { recursive: true });
    const deep = path.join(fix.root, 'a', 'b', 'c');
    await mkdir(deep, { recursive: true });
    expect(await findSolutionRoot(deep)).toBe(fix.root);
  });

  it('prefers the nearest marker when nested', async () => {
    const outer = fix.root;
    const inner = path.join(outer, 'sub');
    await mkdir(path.join(outer, '.monoceros'), { recursive: true });
    await mkdir(path.join(inner, '.monoceros'), { recursive: true });
    expect(await findSolutionRoot(inner)).toBe(inner);
  });

  it('throws a clear error when no marker is found', async () => {
    // start at an empty directory under a freshly-created tmp dir
    const empty = path.join(fix.root, 'no-marker');
    await mkdir(empty, { recursive: true });
    // Also seed a sentinel so a walk that escapes the tmp dir would
    // hit it — but we expect failure before that.
    await writeFile(path.join(fix.root, 'noise.txt'), '');
    // Note: this test assumes the host filesystem above fix.root has
    // no .monoceros/ — true for /tmp on macOS/Linux CI runners.
    await expect(findSolutionRoot(empty)).rejects.toThrow(
      /Not inside a Monoceros solution/,
    );
  });
});
