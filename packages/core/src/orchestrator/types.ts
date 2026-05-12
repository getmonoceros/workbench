import type {
  GeneratorReport,
  IterationPlan,
  ReviewReport,
} from '../schemas/index.js';
import type { PhaseError, PhaseEvent, PhaseName } from '../runtime/index.js';

export interface IterationPipelineInput {
  /** Free-form prompt the Builder wrote for this iteration. */
  userPrompt: string;
  /** Workspace folder all three phases operate in. */
  cwd: string;
  /** Optional per-phase model overrides. SDK default applies otherwise. */
  models?: {
    planner?: string;
    generator?: string;
    reviewer?: string;
  };
  /**
   * Resume the Generator from a prior session id (multi-turn) so it
   * remembers the previous iteration's reasoning. Plan and Reviewer
   * always run fresh.
   */
  generatorResumeSessionId?: string;
  /** Aborting cancels whichever phase is currently in-flight. */
  abortController?: AbortController;
  /** Stream callback for both phase-level and pipeline-level events. */
  emit?: (event: IterationEvent) => void;
}

/** Pipeline-level events, on top of the per-phase events forwarded as-is. */
export type IterationEvent =
  | PhaseEvent
  | { type: 'iteration_started'; userPrompt: string }
  | { type: 'phase_started'; phase: PhaseName }
  | { type: 'phase_failed'; phase: PhaseName; error: PhaseError }
  | { type: 'rewind_started'; checkpointId: string }
  | { type: 'rewind_finished' }
  | {
      type: 'iteration_finished';
      recommendation: 'approve' | 'request_changes' | 'reject';
      rewound: boolean;
    };

export interface PhaseMetrics {
  numTurns: number;
  durationMs: number;
  costUsd: number;
}

export interface IterationPipelineSuccess {
  ok: true;
  plan: IterationPlan;
  generatorReport: GeneratorReport;
  reviewReport: ReviewReport;
  sessions: { planner: string; generator: string; reviewer: string };
  metrics: {
    planner: PhaseMetrics;
    generator: PhaseMetrics;
    reviewer: PhaseMetrics;
  };
  /**
   * `true` if the Reviewer rejected and the Generator's file edits
   * were rolled back to the pre-Phase-2 state via
   * `rewindToCheckpoint`. Stays `false` for approve / request_changes
   * (the Builder reviews the changes manually before continuing).
   */
  rewound: boolean;
}

export interface IterationPipelineFailure {
  ok: false;
  failedPhase: PhaseName;
  error: PhaseError;
  /** Outputs from earlier phases that completed before the failure. */
  partial: {
    plan?: IterationPlan;
    generatorReport?: GeneratorReport;
  };
}

export type IterationPipelineResult =
  | IterationPipelineSuccess
  | IterationPipelineFailure;
