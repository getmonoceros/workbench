import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLocalFindingsStore } from '@monoceros/adapter-local';
import type {
  GeneratorReport,
  IterationPipelineResult,
  IterationPlan,
  PhaseMetrics,
  ReviewReport,
} from '@monoceros/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runIterateCommand, summarizeOutcome } from '../src/iterate.js';

const mockMetrics: {
  planner: PhaseMetrics;
  generator: PhaseMetrics;
  reviewer: PhaseMetrics;
} = {
  planner: { numTurns: 3, durationMs: 12_300, costUsd: 0.02 },
  generator: { numTurns: 7, durationMs: 28_100, costUsd: 0.05 },
  reviewer: { numTurns: 4, durationMs: 15_200, costUsd: 0.03 },
};

const plan: IterationPlan = {
  planSummary: 'Add /healthz endpoint.',
  acceptanceCriteria: [
    {
      given: 'service up',
      when: 'GET /healthz',
      then: '200 { ok: true }',
      source: 'derived_from_prompt',
    },
  ],
  affectedModules: [],
  fileChanges: [],
  risks: [
    { description: 'Auth on /healthz?', severity: 'high' },
    { description: 'Caching?', severity: 'medium' },
  ],
  outOfScope: [],
  planMarkdown: '# Plan',
};

const generatorReport: GeneratorReport = {
  changesSummary: {
    filesCreated: ['src/routes/healthz.ts'],
    filesModified: ['src/routes/index.ts'],
    filesDeleted: [],
  },
  testRun: { executed: true, passed: 3, failed: 0 },
  planDeviations: [],
  reviewerNotes: [],
  selfAssessment: {
    confidence: 'medium',
    concerns: ['No rate-limit on /healthz', 'No structured logging yet'],
  },
};

const reviewReport: ReviewReport = {
  acceptanceCriteriaResults: [
    { acIndex: 0, status: 'met', evidence: 'src/routes/healthz.ts:8' },
  ],
  findings: [
    {
      category: 'code_quality',
      severity: 'low',
      blocking: false,
      message: 'Endpoint could share helper with /readyz',
    },
  ],
  testVerification: { allTestsPass: true },
  recommendation: 'approve',
  summary: 'ACs met, tests green.',
};

interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'monoceros-plugin-iterate-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('runIterateCommand — happy path', () => {
  let fix: Fixture;
  beforeEach(async () => {
    fix = await makeFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it('persists 1 finding, 2 concerns, 2 risks, and one iteration audit', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    const successResult: IterationPipelineResult = {
      ok: true,
      plan,
      generatorReport,
      reviewReport,
      sessions: { planner: 'sp', generator: 'sg', reviewer: 'sr' },
      metrics: mockMetrics,
      rewound: false,
    };
    const outcome = await runIterateCommand(
      store,
      { userPrompt: 'Add a healthz endpoint', cwd: fix.root },
      { pipeline: async () => successResult },
    );
    expect(outcome.iterationId).toMatch(/iter/);
    expect(outcome.appendedFindingIds).toHaveLength(1);
    expect(outcome.appendedConcernIds).toHaveLength(2);
    expect(outcome.appendedRiskIds).toHaveLength(2);

    const all = await store.listAll();
    expect(all.filter((i) => i.kind === 'finding')).toHaveLength(1);
    expect(all.filter((i) => i.kind === 'concern')).toHaveLength(2);
    expect(all.filter((i) => i.kind === 'risk')).toHaveLength(2);
    // every appended item points at the iteration audit
    for (const item of all) {
      expect(item.sourceIteration).toBe(outcome.iterationId);
    }
  });

  it('summarizes a successful outcome as Markdown', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    const successResult: IterationPipelineResult = {
      ok: true,
      plan,
      generatorReport,
      reviewReport,
      sessions: { planner: 'sp', generator: 'sg', reviewer: 'sr' },
      metrics: mockMetrics,
      rewound: false,
    };
    const outcome = await runIterateCommand(
      store,
      { userPrompt: 'p', cwd: fix.root },
      { pipeline: async () => successResult },
    );
    const text = summarizeOutcome(outcome);
    expect(text).toMatch(/^## ✓ Iteration .* — \*\*approve\*\*/);
    expect(text).toContain('**Plan**');
    expect(text).toContain('**Generate**');
    expect(text).toContain('**Review**');
    expect(text).toContain('### Acceptance Criteria — 1/1 met');
    expect(text).toContain('### Files changed');
    expect(text).toContain('### Tests');
    expect(text).toContain('### Captured');
    expect(text).toContain('1 finding (1 low)');
    expect(text).toContain('2 concerns');
    expect(text).toContain('2 risks');
    expect(text).toContain('### Reviewer');
    expect(text).toContain(reviewReport.summary);
  });

  it('shows the "rewound" section when the workspace was rewound', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    const rejectReport: ReviewReport = {
      ...reviewReport,
      recommendation: 'reject',
    };
    const successResult: IterationPipelineResult = {
      ok: true,
      plan,
      generatorReport,
      reviewReport: rejectReport,
      sessions: { planner: 'sp', generator: 'sg', reviewer: 'sr' },
      metrics: mockMetrics,
      rewound: true,
    };
    const outcome = await runIterateCommand(
      store,
      { userPrompt: 'p', cwd: fix.root },
      { pipeline: async () => successResult },
    );
    const text = summarizeOutcome(outcome);
    expect(text).toContain('### Workspace rewound');
    expect(text).toMatch(/^## ✗ .* — \*\*reject\*\*/);
  });
});

describe('runIterateCommand — failure handling', () => {
  let fix: Fixture;
  beforeEach(async () => {
    fix = await makeFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it('writes only an iteration audit (no items) when the pipeline fails', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    const failedResult: IterationPipelineResult = {
      ok: false,
      failedPhase: 'generator',
      error: {
        kind: 'sdk_error',
        subtype: 'error_max_turns',
        errors: ['too many turns'],
        sessionId: 'sg',
      },
      partial: { plan },
    };
    const outcome = await runIterateCommand(
      store,
      { userPrompt: 'p', cwd: fix.root },
      { pipeline: async () => failedResult },
    );
    expect(outcome.appendedFindingIds).toHaveLength(0);
    expect(outcome.appendedConcernIds).toHaveLength(0);
    expect(outcome.appendedRiskIds).toHaveLength(0);
    expect(await store.listAll()).toHaveLength(0);
  });

  it('summarizes a failed outcome as Markdown with the failed phase and error kind', async () => {
    const store = createLocalFindingsStore({ solutionRoot: fix.root });
    const failedResult: IterationPipelineResult = {
      ok: false,
      failedPhase: 'reviewer',
      error: {
        kind: 'missing_output',
        sessionId: 'sr',
        reason: 'no_result_message',
        messageTypes: ['system', 'assistant'],
        stderrTail: 'some stderr output here',
      },
      partial: { plan, generatorReport },
    };
    const outcome = await runIterateCommand(
      store,
      { userPrompt: 'p', cwd: fix.root },
      { pipeline: async () => failedResult },
    );
    const text = summarizeOutcome(outcome);
    expect(text).toMatch(/^## ✗ .* — FAILED in \*\*reviewer\*\*/);
    expect(text).toContain('### Error: `missing_output` / `no_result_message`');
    expect(text).toContain('`system`, `assistant`');
    expect(text).toContain('### Stderr tail');
    expect(text).toContain('some stderr output here');
    expect(text).toContain('### Partial output');
    expect(text).toContain('Planner produced a plan');
    expect(text).toContain('Generator report captured');
  });
});
