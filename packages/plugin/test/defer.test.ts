import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLocalFindingsStore } from '@monoceros/adapter-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deferConcern, MANUAL_ITERATION_ID } from '../src/defer.js';

interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'monoceros-plugin-defer-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('deferConcern', () => {
  let fix: Fixture;
  beforeEach(async () => {
    fix = await makeFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it('writes a concern with sourceIteration = "manual"', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    const id = await deferConcern(
      store,
      'No retry policy on the payment webhook handler.',
    );
    const item = await store.get(id);
    expect(item).not.toBeNull();
    expect(item?.kind).toBe('concern');
    expect(item?.status).toBe('open');
    expect(item?.sourceIteration).toBe(MANUAL_ITERATION_ID);
    expect(item?.body.trimEnd()).toBe(
      'No retry policy on the payment webhook handler.',
    );
  });

  it('trims whitespace from the input', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    const id = await deferConcern(store, '   trailing whitespace  \n');
    const item = await store.get(id);
    expect(item?.body.trimEnd()).toBe('trailing whitespace');
  });

  it('rejects empty or whitespace-only input', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    await expect(deferConcern(store, '')).rejects.toThrow(/must not be empty/);
    await expect(deferConcern(store, '   \n\t  ')).rejects.toThrow(
      /must not be empty/,
    );
  });
});
