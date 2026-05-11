import type { z } from 'zod';

/**
 * Identifies which iteration phase a `runPhase()` invocation belongs
 * to. Used by the emit callback so a UI surface can label events.
 */
export type PhaseName = 'planner' | 'generator' | 'reviewer';

/**
 * Streaming events emitted by `runPhase()` while a phase is running.
 * The set is intentionally small — just what a plugin UI needs to
 * show progress. We can extend it as M2 Task 5 wires the plugin.
 */
export type PhaseEvent =
  | { type: 'session_started'; phase: PhaseName; sessionId: string }
  | {
      type: 'tool_use';
      phase: PhaseName;
      toolName: string;
      input: unknown;
    }
  | { type: 'assistant_text'; phase: PhaseName; text: string }
  | { type: 'phase_finished'; phase: PhaseName; sessionId: string };

export interface PhaseRunOptions<TSchema extends z.ZodType> {
  phase: PhaseName;
  systemPrompt: string;
  userPrompt: string;
  /**
   * Zod schema describing the phase's expected JSON output. The
   * runtime converts it to JSON-Schema via `z.toJSONSchema()` and
   * hands it to the Agent SDK as `outputFormat`, then re-validates
   * the SDK's `structured_output` with the same schema as a
   * defence-in-depth step.
   */
  outputSchema: TSchema;
  /** Tool whitelist for this phase (e.g. `['Read', 'Glob', 'Bash']`). */
  allowedTools: readonly string[];
  /** Workspace folder the phase operates in (Devcontainer-mounted). */
  cwd: string;
  /** Optional model override. SDK default applies otherwise. */
  model?: string;
  /**
   * Resume a previous SDK session (multi-turn). Used by the
   * orchestrator to keep Generator context across iterations.
   */
  resumeSessionId?: string;
  /**
   * Enable file-checkpointing so the orchestrator can `rewindFiles`
   * after a `recommendation: 'reject'` from the Reviewer. Generator
   * phase only — Planner and Reviewer don't edit files.
   */
  enableCheckpointing?: boolean;
  /** Aborting the controller cancels the SDK call. */
  abortController?: AbortController;
  /** Stream callback for live UX (tool-use, assistant text). */
  emit?: (event: PhaseEvent) => void;
}

export interface PhaseRunSuccess<TOutput> {
  ok: true;
  output: TOutput;
  sessionId: string;
  /**
   * UUID of the first user message in the SDK stream — the anchor
   * `rewindFiles()` needs. `null` when checkpointing is disabled or
   * the stream produced no addressable user message.
   */
  checkpointId: string | null;
  numTurns: number;
  durationMs: number;
  costUsd: number;
}

export type PhaseValidationIssue = { path: string; message: string };

/**
 * Reason the stream ended without producing a usable output.
 *
 *  - `no_result_message`: the SDK stream finished without ever
 *    yielding a `type: 'result'` message. Usually means the
 *    `claude` subprocess died without reporting an error subtype.
 *  - `no_structured_output`: a successful result arrived but
 *    `structured_output` was absent. The SDK should have caught
 *    this internally and emitted `error_max_structured_output_retries`
 *    instead — seeing it bare means the SDK didn't enforce
 *    `outputFormat` for this call.
 */
export type MissingOutputReason = 'no_result_message' | 'no_structured_output';

export type PhaseError =
  | {
      kind: 'sdk_error';
      subtype:
        | 'error_during_execution'
        | 'error_max_turns'
        | 'error_max_budget_usd'
        | 'error_max_structured_output_retries';
      errors: string[];
      sessionId: string | null;
      /** Last 4 KB of stderr captured from the `claude` subprocess. */
      stderrTail?: string;
    }
  | {
      kind: 'schema_validation';
      issues: PhaseValidationIssue[];
      rawOutput: unknown;
      sessionId: string;
    }
  | {
      kind: 'missing_output';
      sessionId: string | null;
      reason: MissingOutputReason;
      /** Message types seen on the stream, in order, for diagnostics. */
      messageTypes: string[];
      /** Last 4 KB of stderr captured from the `claude` subprocess. */
      stderrTail?: string;
    }
  | { kind: 'aborted'; sessionId: string | null };

export type PhaseRunResult<TOutput> =
  | PhaseRunSuccess<TOutput>
  | { ok: false; error: PhaseError };
