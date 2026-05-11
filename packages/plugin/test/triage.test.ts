import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLocalFindingsStore } from '@monoceros/adapter-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseTriageStatus, triageItem } from '../src/triage.js';

interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'monoceros-plugin-triage-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('parseTriageStatus', () => {
  it('accepts jetzt, später and verworfen', () => {
    expect(parseTriageStatus('jetzt')).toBe('jetzt');
    expect(parseTriageStatus('später')).toBe('später');
    expect(parseTriageStatus('verworfen')).toBe('verworfen');
  });

  it('rejects anything else with a clear error message', () => {
    expect(() => parseTriageStatus('open')).toThrow(/Invalid triage status/);
    expect(() => parseTriageStatus('done')).toThrow(/jetzt, später, verworfen/);
  });
});

describe('triageItem', () => {
  let fix: Fixture;
  beforeEach(async () => {
    fix = await makeFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it('marks an open item and reports the previous status', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    const id = await store.appendConcern({
      sourceIteration: 'i',
      text: 'concern A',
    });
    const message = await triageItem(store, id, 'jetzt');
    expect(message).toContain(id);
    expect(message).toContain('marked as jetzt');
    expect(message).toContain('was open');
    const item = await store.get(id);
    expect(item?.status).toBe('jetzt');
  });

  it('reports the previous status when re-triaging', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    const id = await store.appendConcern({
      sourceIteration: 'i',
      text: 'concern B',
    });
    await store.markStatus(id, 'später');
    const message = await triageItem(store, id, 'verworfen');
    expect(message).toContain('was später');
  });

  it('throws when the id does not exist', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    await expect(triageItem(store, 'does-not-exist', 'jetzt')).rejects.toThrow(
      /Item not found/,
    );
  });
});
