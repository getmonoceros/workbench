import type {
  Options as SdkOptions,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  runIterationPipeline,
  type GeneratorReport,
  type IterationEvent,
  type IterationPlan,
  type QueryFn,
  type ReviewReport,
} from '../src/index.js';

// ---------- minimal valid example outputs ---------------------------

const planExample: IterationPlan = {
  planSummary: 'Add a /healthz endpoint returning 200 OK.',
  acceptanceCriteria: [
    {
      given: 'the service is up',
      when: 'GET /healthz is called',
      then: 'response is 200 with { ok: true }',
      source: 'derived_from_prompt',
    },
  ],
  affectedModules: [
    { name: 'src/routes/healthz', kind: 'backend', reason: 'new endpoint' },
  ],
  fileChanges: [
    { path: 'src/routes/healthz.ts', kind: 'create', notes: 'handler' },
  ],
  risks: [],
  outOfScope: [],
  planMarkdown: '# Plan\nAdd healthz.',
};

const generatorReportExample: GeneratorReport = {
  changesSummary: {
    filesCreated: ['src/routes/healthz.ts'],
    filesModified: [],
    filesDeleted: [],
  },
  testRun: { executed: true, passed: 1, failed: 0 },
  planDeviations: [],
  reviewerNotes: [],
  selfAssessment: { confidence: 'high' },
};

const approveReportExample: ReviewReport = {
  acceptanceCriteriaResults: [
    { acIndex: 0, status: 'met', evidence: 'src/routes/healthz.ts:8' },
  ],
  findings: [],
  testVerification: { allTestsPass: true },
  recommendation: 'approve',
  summary: 'All ACs met, tests green.',
};

const rejectReportExample: ReviewReport = {
  ...approveReportExample,
  recommendation: 'reject',
  summary: 'Runtime probe fails — server returns 500.',
};

// ---------- SDK message helpers -------------------------------------

function userMsg(uuid: string, sessionId: string): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: 'x' },
    parent_tool_use_id: null,
    uuid,
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function resultSuccess(sessionId: string, structured: unknown): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 100,
    duration_api_ms: 50,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    structured_output: structured,
    uuid: 'r',
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function resultError(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_max_turns',
    duration_ms: 50,
    duration_api_ms: 20,
    is_error: true,
    num_turns: 10,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    errors: ['too many turns'],
    uuid: 'r',
    session_id: sessionId,
  } as unknown as SDKMessage;
}

// ---------- multi-call fake queryFn ---------------------------------

interface Call {
  prompt: string;
  options?: SdkOptions;
  rewindFilesCalled?: string;
}

interface FakeQuery {
  fn: QueryFn;
  calls: Call[];
}

/**
 * Builds a queryFn that consumes one scripted "phase response"
 * per call. Each response is either a list of messages or a special
 * marker for the rewind call.
 */
function makeFakePipelineQuery(phaseStreams: SDKMessage[][]): FakeQuery {
  const calls: Call[] = [];
  let phaseIndex = 0;
  const fn: QueryFn = ({ prompt, options }) => {
    const call: Call = { prompt, options };
    calls.push(call);
    const stream = phaseStreams[phaseIndex] ?? [];
    phaseIndex++;
    const iter = (async function* () {
      for (const m of stream) yield m;
    })();
    // attach rewindFiles to capture invocation
    const queryLike = Object.assign(iter, {
      async rewindFiles(uuid: string): Promise<void> {
        call.rewindFilesCalled = uuid;
      },
      async interrupt() {},
      async setPermissionMode() {},
      async setModel() {},
      async setMaxThinkingTokens() {},
      async supportedCommands() {
        return [];
      },
      async supportedModels() {
        return [];
      },
      async mcpServerStatus() {
        return [];
      },
      async accountInfo() {
        return {};
      },
    });
    return queryLike as unknown as ReturnType<QueryFn>;
  };
  return { fn, calls };
}

const baseInput = {
  userPrompt: 'Add a healthz endpoint',
  cwd: '/workspace',
};

// ---------- tests ---------------------------------------------------

describe('runIterationPipeline — happy path', () => {
  it('runs all three phases sequentially and returns combined outputs', async () => {
    const fake = makeFakePipelineQuery([
      [
        userMsg('p1', 'sess-planner'),
        resultSuccess('sess-planner', planExample),
      ],
      [
        userMsg('g1', 'sess-gen'),
        resultSuccess('sess-gen', generatorReportExample),
      ],
      [
        userMsg('r1', 'sess-rev'),
        resultSuccess('sess-rev', approveReportExample),
      ],
    ]);
    const result = await runIterationPipeline(baseInput, fake.fn);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual(planExample);
    expect(result.generatorReport).toEqual(generatorReportExample);
    expect(result.reviewReport).toEqual(approveReportExample);
    expect(result.sessions).toEqual({
      planner: 'sess-planner',
      generator: 'sess-gen',
      reviewer: 'sess-rev',
    });
    expect(result.rewound).toBe(false);
    expect(fake.calls).toHaveLength(3);
  });

  it('collects per-phase metrics (turns, duration, cost) from runPhase results', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [resultSuccess('sg', generatorReportExample)],
      [resultSuccess('sr', approveReportExample)],
    ]);
    const result = await runIterationPipeline(baseInput, fake.fn);
    if (!result.ok) throw new Error('expected ok');
    // resultSuccess fixture sets num_turns=1, duration_ms=100, total_cost_usd=0.01
    expect(result.metrics).toEqual({
      planner: { numTurns: 1, durationMs: 100, costUsd: 0.01 },
      generator: { numTurns: 1, durationMs: 100, costUsd: 0.01 },
      reviewer: { numTurns: 1, durationMs: 100, costUsd: 0.01 },
    });
  });

  it('uses the per-phase tool whitelists', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sess-planner', planExample)],
      [resultSuccess('sess-gen', generatorReportExample)],
      [resultSuccess('sess-rev', approveReportExample)],
    ]);
    await runIterationPipeline(baseInput, fake.fn);
    expect(fake.calls[0]!.options?.allowedTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Bash',
    ]);
    expect(fake.calls[1]!.options?.allowedTools).toEqual([
      'Read',
      'Edit',
      'Write',
      'Bash',
      'Glob',
      'Grep',
    ]);
    expect(fake.calls[2]!.options?.allowedTools).toEqual([
      'Read',
      'Bash',
      'Glob',
      'Grep',
    ]);
  });

  it('passes the Builder prompt verbatim to the Planner', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [resultSuccess('sg', generatorReportExample)],
      [resultSuccess('sr', approveReportExample)],
    ]);
    await runIterationPipeline(baseInput, fake.fn);
    expect(fake.calls[0]!.prompt).toBe('Add a healthz endpoint');
  });

  it('embeds the Plan in the Generator prompt and Plan + Report in the Reviewer prompt', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [resultSuccess('sg', generatorReportExample)],
      [resultSuccess('sr', approveReportExample)],
    ]);
    await runIterationPipeline(baseInput, fake.fn);
    expect(fake.calls[1]!.prompt).toContain('Iterations-Plan');
    expect(fake.calls[1]!.prompt).toContain('Add a healthz endpoint');
    expect(fake.calls[1]!.prompt).toContain(planExample.planSummary);
    expect(fake.calls[2]!.prompt).toContain('Iterations-Plan');
    expect(fake.calls[2]!.prompt).toContain('Generator-Report');
    expect(fake.calls[2]!.prompt).toContain(planExample.planSummary);
    expect(fake.calls[2]!.prompt).toContain(
      generatorReportExample.changesSummary.filesCreated[0]!,
    );
  });

  it('forwards per-phase model overrides', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [resultSuccess('sg', generatorReportExample)],
      [resultSuccess('sr', approveReportExample)],
    ]);
    await runIterationPipeline(
      {
        ...baseInput,
        models: { planner: 'claude-opus-4-7', generator: 'claude-sonnet-4-6' },
      },
      fake.fn,
    );
    expect(fake.calls[0]!.options?.model).toBe('claude-opus-4-7');
    expect(fake.calls[1]!.options?.model).toBe('claude-sonnet-4-6');
    expect(fake.calls[2]!.options?.model).toBeUndefined();
  });

  it('passes generatorResumeSessionId to the Generator only', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [resultSuccess('sg', generatorReportExample)],
      [resultSuccess('sr', approveReportExample)],
    ]);
    await runIterationPipeline(
      { ...baseInput, generatorResumeSessionId: 'sess_prev_gen' },
      fake.fn,
    );
    expect(fake.calls[0]!.options?.resume).toBeUndefined();
    expect(fake.calls[1]!.options?.resume).toBe('sess_prev_gen');
    expect(fake.calls[2]!.options?.resume).toBeUndefined();
  });

  it('enables file-checkpointing on the Generator phase only', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [resultSuccess('sg', generatorReportExample)],
      [resultSuccess('sr', approveReportExample)],
    ]);
    await runIterationPipeline(baseInput, fake.fn);
    expect(fake.calls[0]!.options?.enableFileCheckpointing).toBeUndefined();
    expect(fake.calls[1]!.options?.enableFileCheckpointing).toBe(true);
    expect(fake.calls[2]!.options?.enableFileCheckpointing).toBeUndefined();
  });
});

describe('runIterationPipeline — recommendation → rewind', () => {
  it('triggers rewindFiles when the Reviewer recommends reject', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [
        userMsg('gen-anchor-uuid', 'sess-gen'),
        resultSuccess('sess-gen', generatorReportExample),
      ],
      [resultSuccess('sr', rejectReportExample)],
      [], // rewind call — empty stream is fine, we break on first iter
    ]);
    const result = await runIterationPipeline(baseInput, fake.fn);
    if (!result.ok) throw new Error('expected ok');
    expect(result.rewound).toBe(true);
    expect(result.reviewReport.recommendation).toBe('reject');
    // 4th call = the rewind one
    expect(fake.calls).toHaveLength(4);
    const rewindCall = fake.calls[3]!;
    expect(rewindCall.prompt).toBe('');
    expect(rewindCall.options?.resume).toBe('sess-gen');
    expect(rewindCall.options?.enableFileCheckpointing).toBe(true);
  });

  it('does not rewind on approve', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [userMsg('g-anchor', 'sg'), resultSuccess('sg', generatorReportExample)],
      [resultSuccess('sr', approveReportExample)],
    ]);
    const result = await runIterationPipeline(baseInput, fake.fn);
    if (!result.ok) throw new Error('expected ok');
    expect(result.rewound).toBe(false);
    expect(fake.calls).toHaveLength(3);
  });

  it('does not rewind on request_changes', async () => {
    const requestChanges: ReviewReport = {
      ...approveReportExample,
      recommendation: 'request_changes',
    };
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [userMsg('g-anchor', 'sg'), resultSuccess('sg', generatorReportExample)],
      [resultSuccess('sr', requestChanges)],
    ]);
    const result = await runIterationPipeline(baseInput, fake.fn);
    if (!result.ok) throw new Error('expected ok');
    expect(result.rewound).toBe(false);
    expect(fake.calls).toHaveLength(3);
  });
});

describe('runIterationPipeline — failure handling', () => {
  it('reports planner failure with empty partial', async () => {
    const fake = makeFakePipelineQuery([[resultError('sp')]]);
    const result = await runIterationPipeline(baseInput, fake.fn);
    if (result.ok) throw new Error('expected failure');
    expect(result.failedPhase).toBe('planner');
    expect(result.error.kind).toBe('sdk_error');
    expect(result.partial).toEqual({});
    expect(fake.calls).toHaveLength(1);
  });

  it('reports generator failure with plan in partial', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [resultError('sg')],
    ]);
    const result = await runIterationPipeline(baseInput, fake.fn);
    if (result.ok) throw new Error('expected failure');
    expect(result.failedPhase).toBe('generator');
    expect(result.partial.plan).toEqual(planExample);
    expect(result.partial.generatorReport).toBeUndefined();
    expect(fake.calls).toHaveLength(2);
  });

  it('reports reviewer failure with plan + generatorReport in partial', async () => {
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [resultSuccess('sg', generatorReportExample)],
      [resultError('sr')],
    ]);
    const result = await runIterationPipeline(baseInput, fake.fn);
    if (result.ok) throw new Error('expected failure');
    expect(result.failedPhase).toBe('reviewer');
    expect(result.partial.plan).toEqual(planExample);
    expect(result.partial.generatorReport).toEqual(generatorReportExample);
    expect(fake.calls).toHaveLength(3);
  });
});

describe('runIterationPipeline — event emission', () => {
  it('emits iteration_started, phase_started for each phase, iteration_finished', async () => {
    const events: IterationEvent[] = [];
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [resultSuccess('sg', generatorReportExample)],
      [resultSuccess('sr', approveReportExample)],
    ]);
    await runIterationPipeline(
      { ...baseInput, emit: (e) => events.push(e) },
      fake.fn,
    );
    const pipelineEvents = events.filter(
      (e) =>
        e.type === 'iteration_started' ||
        e.type === 'phase_started' ||
        e.type === 'iteration_finished',
    );
    expect(pipelineEvents.map((e) => e.type)).toEqual([
      'iteration_started',
      'phase_started',
      'phase_started',
      'phase_started',
      'iteration_finished',
    ]);
    const phaseStarts = pipelineEvents
      .filter((e) => e.type === 'phase_started')
      .map((e) => (e as { phase: string }).phase);
    expect(phaseStarts).toEqual(['planner', 'generator', 'reviewer']);
    const finish = pipelineEvents.find(
      (e) => e.type === 'iteration_finished',
    ) as { recommendation: string; rewound: boolean };
    expect(finish.recommendation).toBe('approve');
    expect(finish.rewound).toBe(false);
  });

  it('emits phase_failed and stops on failure', async () => {
    const events: IterationEvent[] = [];
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [resultError('sg')],
    ]);
    await runIterationPipeline(
      { ...baseInput, emit: (e) => events.push(e) },
      fake.fn,
    );
    const failed = events.find((e) => e.type === 'phase_failed') as
      | { phase: string }
      | undefined;
    expect(failed?.phase).toBe('generator');
    const finished = events.find((e) => e.type === 'iteration_finished');
    expect(finished).toBeUndefined();
  });

  it('emits rewind_started + rewind_finished bracketing the rewind call', async () => {
    const events: IterationEvent[] = [];
    const fake = makeFakePipelineQuery([
      [resultSuccess('sp', planExample)],
      [userMsg('g-anchor', 'sg'), resultSuccess('sg', generatorReportExample)],
      [resultSuccess('sr', rejectReportExample)],
      [],
    ]);
    await runIterationPipeline(
      { ...baseInput, emit: (e) => events.push(e) },
      fake.fn,
    );
    const rewindEvents = events.filter(
      (e) => e.type === 'rewind_started' || e.type === 'rewind_finished',
    );
    expect(rewindEvents.map((e) => e.type)).toEqual([
      'rewind_started',
      'rewind_finished',
    ]);
    const start = rewindEvents[0] as { checkpointId: string };
    expect(start.checkpointId).toBe('g-anchor');
  });
});
