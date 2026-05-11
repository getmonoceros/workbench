import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLocalFindingsStore } from '@monoceros/adapter-local';
import type { ReviewFinding } from '@monoceros/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderList } from '../src/list.js';

const finding: ReviewFinding = {
  category: 'security',
  severity: 'high',
  blocking: true,
  message: 'Hardcoded secret in src/auth.ts',
};

interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'monoceros-plugin-list-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function deterministicDeps() {
  let counter = 0;
  const start = Date.parse('2026-05-11T20:30:12.456Z');
  return {
    clock: () => new Date(start + counter++ * 1000),
    randomSuffix: () => 'abc123',
  };
}

describe('renderList', () => {
  let fix: Fixture;
  beforeEach(async () => {
    fix = await makeFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it('returns a friendly empty message when nothing is captured', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    expect(await renderList({ store, all: false })).toBe(
      'No open items. Use `--all` to include triaged items.',
    );
    expect(await renderList({ store, all: true })).toBe(
      'No items captured yet.',
    );
  });

  it('groups items by kind with a heading and a tag summary per item', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...deterministicDeps(),
    });
    await store.appendFinding({ sourceIteration: 'i', finding });
    await store.appendConcern({
      sourceIteration: 'i',
      text: 'Rate-limit missing',
    });
    await store.appendRisk({
      sourceIteration: 'i',
      description: 'Auth requirement unclear',
      severity: 'medium',
    });

    const out = await renderList({ store, all: false });
    expect(out).toContain('## Findings (1)');
    expect(out).toContain('## Concerns (1)');
    expect(out).toContain('## Risks (1)');
    // tag summary on the finding line includes status, severity,
    // category and the blocking marker
    expect(out).toMatch(/\(open, high, security, blocking\) Hardcoded secret/);
    expect(out).toMatch(/\(open\) Rate-limit missing/);
    expect(out).toMatch(/\(open, medium\) Auth requirement unclear/);
  });

  it('hides triaged items by default and shows them with all=true', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...deterministicDeps(),
    });
    const triaged = await store.appendFinding({
      sourceIteration: 'i',
      finding: { ...finding, message: 'Triaged item' },
    });
    await store.appendFinding({
      sourceIteration: 'i',
      finding: { ...finding, message: 'Open item' },
    });
    await store.markStatus(triaged, 'verworfen');

    const openOnly = await renderList({ store, all: false });
    expect(openOnly).toContain('Open item');
    expect(openOnly).not.toContain('Triaged item');

    const all = await renderList({ store, all: true });
    expect(all).toContain('Open item');
    expect(all).toContain('Triaged item');
    expect(all).toContain('verworfen');
  });

  it('omits sections that have no items', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...deterministicDeps(),
    });
    await store.appendConcern({ sourceIteration: 'i', text: 'Just a concern' });
    const out = await renderList({ store, all: false });
    expect(out).toContain('## Concerns');
    expect(out).not.toContain('## Findings');
    expect(out).not.toContain('## Risks');
  });
});
