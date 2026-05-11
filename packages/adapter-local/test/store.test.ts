import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ReviewFinding } from '@monoceros/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalFindingsStore, parseFile } from '../src/index.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const sampleFinding: ReviewFinding = {
  category: 'spec_compliance',
  severity: 'high',
  blocking: true,
  file: 'src/foo.ts',
  line: 42,
  message: 'Build fehlschlägt — App kann nicht starten',
  suggestion: 'Fehlende Path-Alias in tsconfig.json ergänzen',
};

interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'monoceros-adapter-local-'));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function makeDeterministicDeps(opts?: { startMs?: number }) {
  let counter = 0;
  const startMs = opts?.startMs ?? Date.parse('2026-05-11T20:30:12.456Z');
  return {
    // each call advances by 1 ms so ids stay distinct even within a
    // test that appends multiple items in quick succession
    clock: () => new Date(startMs + counter++ * 1000),
    randomSuffix: () => 'abc123',
  };
}

describe('createLocalFindingsStore', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await makeFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it('writes a finding under .monoceros/findings/ with full frontmatter', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...makeDeterministicDeps(),
    });
    const id = await store.appendFinding({
      sourceIteration: 'iter-1',
      finding: sampleFinding,
    });
    expect(id).toBe(
      '2026-05-11T20-30-12-456Z-abc123-build-fehlschlagt-app-kann-nicht-starten',
    );
    const filepath = path.join(fix.root, '.monoceros/findings', `${id}.md`);
    const raw = await readFile(filepath, 'utf8');
    const { frontmatter, body } = parseFile(raw);
    expect(frontmatter).toEqual({
      id,
      kind: 'finding',
      status: 'open',
      sourceIteration: 'iter-1',
      createdAt: '2026-05-11T20:30:12.456Z',
      category: 'spec_compliance',
      severity: 'high',
      blocking: true,
      file: 'src/foo.ts',
      line: 42,
      suggestion: 'Fehlende Path-Alias in tsconfig.json ergänzen',
    });
    expect(body.trimEnd()).toBe(sampleFinding.message);
  });

  it('omits optional finding fields when not provided', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...makeDeterministicDeps(),
    });
    const id = await store.appendFinding({
      sourceIteration: 'iter-2',
      finding: {
        category: 'tests',
        severity: 'low',
        blocking: false,
        message: 'tests not green',
      },
    });
    const raw = await readFile(
      path.join(fix.root, '.monoceros/findings', `${id}.md`),
      'utf8',
    );
    expect(raw).not.toContain('file:');
    expect(raw).not.toContain('line:');
    expect(raw).not.toContain('suggestion:');
  });

  it('writes a concern under .monoceros/concerns/', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...makeDeterministicDeps(),
    });
    const id = await store.appendConcern({
      sourceIteration: 'iter-3',
      text: 'Endpoint ohne Rate-Limit',
      confidence: 'medium',
    });
    const raw = await readFile(
      path.join(fix.root, '.monoceros/concerns', `${id}.md`),
      'utf8',
    );
    const { frontmatter, body } = parseFile(raw);
    expect(frontmatter.kind).toBe('concern');
    expect(frontmatter.confidence).toBe('medium');
    expect(body.trimEnd()).toBe('Endpoint ohne Rate-Limit');
  });

  it('writes a risk under .monoceros/risks/', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...makeDeterministicDeps(),
    });
    const id = await store.appendRisk({
      sourceIteration: 'iter-4',
      description: 'Auth-Anforderung unklar',
      severity: 'high',
    });
    const raw = await readFile(
      path.join(fix.root, '.monoceros/risks', `${id}.md`),
      'utf8',
    );
    const { frontmatter } = parseFile(raw);
    expect(frontmatter.kind).toBe('risk');
    expect(frontmatter.severity).toBe('high');
  });

  it('writes an iteration audit as JSON under .monoceros/iterations/', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...makeDeterministicDeps(),
    });
    const id = await store.appendIteration({
      userPrompt: 'Add a healthz endpoint',
      sessions: { planner: 'sess-p', generator: 'sess-g', reviewer: 'sess-r' },
      rewound: false,
      failedPhase: null,
    });
    const raw = await readFile(
      path.join(fix.root, '.monoceros/iterations', `${id}.json`),
      'utf8',
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.id).toBe(id);
    expect(parsed.userPrompt).toBe('Add a healthz endpoint');
    expect(parsed.sessions).toEqual({
      planner: 'sess-p',
      generator: 'sess-g',
      reviewer: 'sess-r',
    });
  });

  it('listAll returns items from every kind, sorted by id', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...makeDeterministicDeps(),
    });
    await store.appendFinding({
      sourceIteration: 'i',
      finding: { ...sampleFinding, message: 'A finding' },
    });
    await store.appendConcern({ sourceIteration: 'i', text: 'A concern' });
    await store.appendRisk({
      sourceIteration: 'i',
      description: 'A risk',
      severity: 'low',
    });
    const all = await store.listAll();
    expect(all).toHaveLength(3);
    expect(all.map((i) => i.kind).sort()).toEqual([
      'concern',
      'finding',
      'risk',
    ]);
  });

  it('listOpen filters out triaged items', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...makeDeterministicDeps(),
    });
    const a = await store.appendFinding({
      sourceIteration: 'i',
      finding: { ...sampleFinding, message: 'item a' },
    });
    const b = await store.appendFinding({
      sourceIteration: 'i',
      finding: { ...sampleFinding, message: 'item b' },
    });
    await store.markStatus(a, 'jetzt');
    await store.markStatus(b, 'verworfen');
    const open = await store.listOpen();
    expect(open).toHaveLength(0);
    const all = await store.listAll();
    expect(all.find((i) => i.id === a)!.status).toBe('jetzt');
    expect(all.find((i) => i.id === b)!.status).toBe('verworfen');
  });

  it('markStatus updates the frontmatter in place, body intact', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...makeDeterministicDeps(),
    });
    const id = await store.appendConcern({
      sourceIteration: 'i',
      text: 'A multi-line\n\nbody with paragraphs',
    });
    const before = await store.get(id);
    await store.markStatus(id, 'später');
    const after = await store.get(id);
    expect(before?.status).toBe('open');
    expect(after?.status).toBe('später');
    expect(after?.body.trimEnd()).toBe(before?.body.trimEnd());
  });

  it('markStatus throws when the id does not exist', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    await expect(store.markStatus('nope', 'jetzt')).rejects.toThrow(
      /not found/,
    );
  });

  it('get returns null for an unknown id without throwing', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    expect(await store.get('does-not-exist')).toBeNull();
  });

  it('returns an empty list before any item exists, without creating dirs', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    expect(await store.listOpen()).toEqual([]);
    expect(await store.listAll()).toEqual([]);
  });

  it('produces deterministic ids when clock + suffix are injected', async () => {
    const store = createLocalFindingsStore({
      solutionRoot: fix.root,
      ...makeDeterministicDeps(),
    });
    const id1 = await store.appendFinding({
      sourceIteration: 'i',
      finding: { ...sampleFinding, message: 'first' },
    });
    const id2 = await store.appendFinding({
      sourceIteration: 'i',
      finding: { ...sampleFinding, message: 'second' },
    });
    expect(id1).toBe('2026-05-11T20-30-12-456Z-abc123-first');
    expect(id2).toBe('2026-05-11T20-30-13-456Z-abc123-second');
  });
});
