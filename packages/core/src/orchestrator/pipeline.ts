import {
  buildGeneratorSystemPrompt,
  buildPlannerSystemPrompt,
  buildReviewerSystemPrompt,
} from '../prompts/index.js';
import {
  rewindToCheckpoint,
  runPhase,
  type PhaseRunOptions,
  type QueryFn,
} from '../runtime/index.js';
import {
  GeneratorReportSchema,
  IterationPlanSchema,
  ReviewReportSchema,
  type IterationPlan,
  type GeneratorReport,
} from '../schemas/index.js';
import {
  buildGeneratorUserPrompt,
  buildReviewerUserPrompt,
} from './prompts.js';
import type {
  IterationEvent,
  IterationPipelineInput,
  IterationPipelineResult,
} from './types.js';

/**
 * Per-phase tool whitelists. Planner reads, Generator edits and
 * writes, Reviewer reads + runs the test/build commands but cannot
 * mutate files.
 */
export const PLANNER_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
];
export const GENERATOR_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
];
export const REVIEWER_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Bash',
  'Glob',
  'Grep',
];

/**
 * Runs the three pipeline phases (Plan → Generate → Review) end to
 * end, with file checkpointing on the Generator and an automatic
 * rewind to the pre-Generator state when the Reviewer recommends
 * `reject`.
 *
 * `queryFn` is the SDK touchpoint; defaults to the real
 * `@anthropic-ai/claude-agent-sdk` `query`, but tests inject a fake
 * that walks through canned message streams.
 */
export async function runIterationPipeline(
  input: IterationPipelineInput,
  queryFn?: QueryFn,
): Promise<IterationPipelineResult> {
  const emit = input.emit;
  emit?.({ type: 'iteration_started', userPrompt: input.userPrompt });

  // ---- Phase 1: Planner --------------------------------------------
  emit?.({ type: 'phase_started', phase: 'planner' });
  const plannerOpts: PhaseRunOptions<typeof IterationPlanSchema> = {
    phase: 'planner',
    systemPrompt: buildPlannerSystemPrompt(),
    userPrompt: input.userPrompt,
    outputSchema: IterationPlanSchema,
    allowedTools: PLANNER_ALLOWED_TOOLS,
    cwd: input.cwd,
    emit,
  };
  if (input.models?.planner !== undefined) {
    plannerOpts.model = input.models.planner;
  }
  if (input.abortController !== undefined) {
    plannerOpts.abortController = input.abortController;
  }
  const plannerResult = await runPhase(plannerOpts, queryFn);
  if (!plannerResult.ok) {
    emit?.({
      type: 'phase_failed',
      phase: 'planner',
      error: plannerResult.error,
    });
    return {
      ok: false,
      failedPhase: 'planner',
      error: plannerResult.error,
      partial: {},
    };
  }
  const plan: IterationPlan = plannerResult.output;

  // ---- Phase 2: Generator ------------------------------------------
  emit?.({ type: 'phase_started', phase: 'generator' });
  const generatorOpts: PhaseRunOptions<typeof GeneratorReportSchema> = {
    phase: 'generator',
    systemPrompt: buildGeneratorSystemPrompt(),
    userPrompt: buildGeneratorUserPrompt(input.userPrompt, plan),
    outputSchema: GeneratorReportSchema,
    allowedTools: GENERATOR_ALLOWED_TOOLS,
    cwd: input.cwd,
    enableCheckpointing: true,
    emit,
  };
  if (input.models?.generator !== undefined) {
    generatorOpts.model = input.models.generator;
  }
  if (input.generatorResumeSessionId !== undefined) {
    generatorOpts.resumeSessionId = input.generatorResumeSessionId;
  }
  if (input.abortController !== undefined) {
    generatorOpts.abortController = input.abortController;
  }
  const generatorResult = await runPhase(generatorOpts, queryFn);
  if (!generatorResult.ok) {
    emit?.({
      type: 'phase_failed',
      phase: 'generator',
      error: generatorResult.error,
    });
    return {
      ok: false,
      failedPhase: 'generator',
      error: generatorResult.error,
      partial: { plan },
    };
  }
  const generatorReport: GeneratorReport = generatorResult.output;

  // ---- Phase 3: Reviewer -------------------------------------------
  emit?.({ type: 'phase_started', phase: 'reviewer' });
  const reviewerOpts: PhaseRunOptions<typeof ReviewReportSchema> = {
    phase: 'reviewer',
    systemPrompt: buildReviewerSystemPrompt(),
    userPrompt: buildReviewerUserPrompt(
      input.userPrompt,
      plan,
      generatorReport,
    ),
    outputSchema: ReviewReportSchema,
    allowedTools: REVIEWER_ALLOWED_TOOLS,
    cwd: input.cwd,
    emit,
  };
  if (input.models?.reviewer !== undefined) {
    reviewerOpts.model = input.models.reviewer;
  }
  if (input.abortController !== undefined) {
    reviewerOpts.abortController = input.abortController;
  }
  const reviewerResult = await runPhase(reviewerOpts, queryFn);
  if (!reviewerResult.ok) {
    emit?.({
      type: 'phase_failed',
      phase: 'reviewer',
      error: reviewerResult.error,
    });
    return {
      ok: false,
      failedPhase: 'reviewer',
      error: reviewerResult.error,
      partial: { plan, generatorReport },
    };
  }
  const reviewReport = reviewerResult.output;

  // ---- Rewind on reject --------------------------------------------
  let rewound = false;
  if (
    reviewReport.recommendation === 'reject' &&
    generatorResult.checkpointId !== null
  ) {
    emit?.({
      type: 'rewind_started',
      checkpointId: generatorResult.checkpointId,
    });
    await rewindToCheckpoint(
      generatorResult.sessionId,
      generatorResult.checkpointId,
      input.cwd,
      queryFn,
    );
    rewound = true;
    emit?.({ type: 'rewind_finished' });
  }

  emit?.({
    type: 'iteration_finished',
    recommendation: reviewReport.recommendation,
    rewound,
  });

  return {
    ok: true,
    plan,
    generatorReport,
    reviewReport,
    sessions: {
      planner: plannerResult.sessionId,
      generator: generatorResult.sessionId,
      reviewer: reviewerResult.sessionId,
    },
    metrics: {
      planner: {
        numTurns: plannerResult.numTurns,
        durationMs: plannerResult.durationMs,
        costUsd: plannerResult.costUsd,
      },
      generator: {
        numTurns: generatorResult.numTurns,
        durationMs: generatorResult.durationMs,
        costUsd: generatorResult.costUsd,
      },
      reviewer: {
        numTurns: reviewerResult.numTurns,
        durationMs: reviewerResult.durationMs,
        costUsd: reviewerResult.costUsd,
      },
    },
    rewound,
  };
}

// Re-export type for convenience so callers don't need a deep import.
export type { IterationEvent };
