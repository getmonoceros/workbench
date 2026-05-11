import type {
  FindingsStore,
  IterationPipelineInput,
  IterationPipelineResult,
} from '@monoceros/core';
import { runIterationPipeline } from '@monoceros/core';

export interface IterateDeps {
  /**
   * Pipeline runner. Defaults to the real
   * `runIterationPipeline`; tests inject a stub returning a canned
   * result.
   */
  pipeline?: (
    input: IterationPipelineInput,
  ) => Promise<IterationPipelineResult>;
}

export interface IterateOutcome {
  iterationId: string;
  result: IterationPipelineResult;
  appendedFindingIds: string[];
  appendedConcernIds: string[];
  appendedRiskIds: string[];
}

/**
 * Runs the iteration pipeline and fans the structured outputs into
 * the FindingsStore: one iteration-audit entry, one finding per
 * Reviewer finding, one concern per Generator concern, one risk per
 * Planner risk.
 *
 * Both success and failure cases write an iteration-audit entry —
 * the audit is the complete record of the run regardless of which
 * phase terminated it.
 */
export async function runIterateCommand(
  store: FindingsStore,
  input: IterationPipelineInput,
  deps: IterateDeps = {},
): Promise<IterateOutcome> {
  const pipeline = deps.pipeline ?? runIterationPipeline;
  const result = await pipeline(input);

  const iterationId = await store.appendIteration(
    buildAuditInput(input, result),
  );

  const appendedFindingIds: string[] = [];
  const appendedConcernIds: string[] = [];
  const appendedRiskIds: string[] = [];

  if (result.ok) {
    for (const finding of result.reviewReport.findings) {
      const id = await store.appendFinding({
        sourceIteration: iterationId,
        finding,
      });
      appendedFindingIds.push(id);
    }
    for (const concern of result.generatorReport.selfAssessment.concerns ??
      []) {
      const id = await store.appendConcern({
        sourceIteration: iterationId,
        text: concern,
        confidence: result.generatorReport.selfAssessment.confidence,
      });
      appendedConcernIds.push(id);
    }
    for (const risk of result.plan.risks) {
      const id = await store.appendRisk({
        sourceIteration: iterationId,
        description: risk.description,
        severity: risk.severity,
      });
      appendedRiskIds.push(id);
    }
  }

  return {
    iterationId,
    result,
    appendedFindingIds,
    appendedConcernIds,
    appendedRiskIds,
  };
}

export function summarizeOutcome(outcome: IterateOutcome): string {
  const lines: string[] = [];
  lines.push(`Iteration ${outcome.iterationId}`);
  if (outcome.result.ok) {
    const r = outcome.result;
    lines.push(`  recommendation: ${r.reviewReport.recommendation}`);
    lines.push(
      `  tests: ${r.reviewReport.testVerification.allTestsPass ? 'pass' : 'fail'}`,
    );
    lines.push(`  rewound: ${r.rewound ? 'yes' : 'no'}`);
    lines.push(
      `  appended: ${outcome.appendedFindingIds.length} findings, ${outcome.appendedConcernIds.length} concerns, ${outcome.appendedRiskIds.length} risks`,
    );
    lines.push(`  summary: ${r.reviewReport.summary}`);
  } else {
    lines.push(`  FAILED in phase: ${outcome.result.failedPhase}`);
    lines.push(`  error.kind: ${outcome.result.error.kind}`);
  }
  return lines.join('\n');
}

function buildAuditInput(
  input: IterationPipelineInput,
  result: IterationPipelineResult,
): Parameters<FindingsStore['appendIteration']>[0] {
  const base: Parameters<FindingsStore['appendIteration']>[0] = {
    userPrompt: input.userPrompt,
  };
  if (result.ok) {
    base.plan = result.plan;
    base.generatorReport = result.generatorReport;
    base.reviewReport = result.reviewReport;
    base.sessions = result.sessions;
    base.rewound = result.rewound;
    base.failedPhase = null;
  } else {
    base.failedPhase = result.failedPhase;
    base.errorSummary = `${result.error.kind}: ${
      result.error.kind === 'sdk_error'
        ? `${result.error.subtype} — ${result.error.errors.join('; ')}`
        : result.error.kind
    }`;
    if (result.partial.plan !== undefined) base.plan = result.partial.plan;
    if (result.partial.generatorReport !== undefined) {
      base.generatorReport = result.partial.generatorReport;
    }
  }
  return base;
}
