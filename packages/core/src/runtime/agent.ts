import {
  query as sdkQuery,
  type Options as SdkOptions,
  type Query as SdkQuery,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { resolveClaudeBinary } from './claude-binary.js';
import type {
  PhaseEvent,
  PhaseError,
  PhaseRunOptions,
  PhaseRunResult,
} from './types.js';

/**
 * Signature of the SDK `query()` function. Exposed so tests can
 * inject a fake without touching the module loader.
 */
export type QueryFn = (params: {
  prompt: string;
  options?: SdkOptions;
}) => SdkQuery;

/**
 * Single-phase invocation against the Claude Agent SDK. This is the
 * one place in the codebase that imports `query()` directly — ADR
 * 0003 keeps the SDK touchpoint local so a future swap remains a
 * single-file change.
 *
 * Returns a tagged result: `{ ok: true, output, … }` on success,
 * `{ ok: false, error }` on SDK errors, schema-validation failures,
 * missing structured output, or abort.
 */
export async function runPhase<TSchema extends z.ZodType>(
  opts: PhaseRunOptions<TSchema>,
  queryFn: QueryFn = sdkQuery,
): Promise<PhaseRunResult<z.infer<TSchema>>> {
  const jsonSchema = z.toJSONSchema(opts.outputSchema) as Record<
    string,
    unknown
  >;

  // Capture the last 4 KB of the `claude` subprocess's stderr so we
  // can surface it on missing_output / sdk_error. Without this the
  // failure mode is opaque.
  const stderrBuffer: string[] = [];
  const STDERR_TAIL_LIMIT = 4096;
  function appendStderr(chunk: string): void {
    stderrBuffer.push(chunk);
    let total = stderrBuffer.reduce((sum, s) => sum + s.length, 0);
    while (total > STDERR_TAIL_LIMIT * 2 && stderrBuffer.length > 1) {
      total -= stderrBuffer.shift()!.length;
    }
  }
  function stderrTail(): string | undefined {
    if (stderrBuffer.length === 0) return undefined;
    const joined = stderrBuffer.join('');
    return joined.slice(-STDERR_TAIL_LIMIT);
  }

  const sdkOptions: SdkOptions = {
    systemPrompt: opts.systemPrompt,
    allowedTools: [...opts.allowedTools],
    cwd: opts.cwd,
    outputFormat: { type: 'json_schema', schema: jsonSchema },
    stderr: appendStderr,
  };

  // Work around the SDK's musl-first platform resolution on linux.
  // See claude-binary.ts for the full story.
  const claudeBinary = resolveClaudeBinary();
  if (claudeBinary !== undefined) {
    sdkOptions.pathToClaudeCodeExecutable = claudeBinary;
  }

  if (opts.model !== undefined) sdkOptions.model = opts.model;
  if (opts.resumeSessionId !== undefined) {
    sdkOptions.resume = opts.resumeSessionId;
  }
  if (opts.abortController !== undefined) {
    sdkOptions.abortController = opts.abortController;
  }

  // Surface SDK debug logging on stderr when MONOCEROS_DEBUG_SDK=1
  // is set in the calling environment. Useful for diagnosing
  // missing_output / no_result_message failures.
  if (process.env.MONOCEROS_DEBUG_SDK === '1') {
    sdkOptions.env = {
      ...process.env,
      DEBUG_CLAUDE_AGENT_SDK: '1',
    } as Record<string, string>;
  }

  if (opts.enableCheckpointing === true) {
    sdkOptions.enableFileCheckpointing = true;
    sdkOptions.permissionMode = 'acceptEdits';
    sdkOptions.extraArgs = { 'replay-user-messages': null };
    sdkOptions.env = {
      ...(sdkOptions.env ?? process.env),
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
    } as Record<string, string>;
  } else if (allowsWrites(opts.allowedTools)) {
    // Generator without checkpointing still needs acceptEdits to
    // bypass the per-edit permission prompt — there's no UI to
    // answer it in a headless pipeline run.
    sdkOptions.permissionMode = 'acceptEdits';
  }

  let sessionId: string | null = null;
  let checkpointId: string | null = null;
  let resultMessage: Extract<SDKMessage, { type: 'result' }> | null = null;
  const messageTypes: string[] = [];

  const stream = queryFn({ prompt: opts.userPrompt, options: sdkOptions });

  try {
    for await (const msg of stream) {
      messageTypes.push(msg.type);
      if (
        sessionId === null &&
        'session_id' in msg &&
        typeof msg.session_id === 'string'
      ) {
        sessionId = msg.session_id;
        opts.emit?.({
          type: 'session_started',
          phase: opts.phase,
          sessionId,
        });
      }

      if (
        opts.enableCheckpointing === true &&
        checkpointId === null &&
        msg.type === 'user' &&
        typeof msg.uuid === 'string'
      ) {
        checkpointId = msg.uuid;
      }

      if (msg.type === 'assistant') {
        forwardAssistantBlocks(opts.phase, msg, opts.emit);
      }

      if (msg.type === 'result') {
        resultMessage = msg;
      }
    }
  } catch (err) {
    if (opts.abortController?.signal.aborted === true) {
      return { ok: false, error: { kind: 'aborted', sessionId } };
    }
    throw err;
  }

  if (resultMessage === null) {
    const error: PhaseError = {
      kind: 'missing_output',
      sessionId,
      reason: 'no_result_message',
      messageTypes,
    };
    const tail = stderrTail();
    if (tail !== undefined) error.stderrTail = tail;
    return { ok: false, error };
  }

  if (resultMessage.subtype !== 'success') {
    const error: PhaseError = {
      kind: 'sdk_error',
      subtype: resultMessage.subtype,
      errors: resultMessage.errors,
      sessionId: resultMessage.session_id,
    };
    const tail = stderrTail();
    if (tail !== undefined) error.stderrTail = tail;
    return { ok: false, error };
  }

  if (resultMessage.structured_output === undefined) {
    const error: PhaseError = {
      kind: 'missing_output',
      sessionId: resultMessage.session_id,
      reason: 'no_structured_output',
      messageTypes,
    };
    const tail = stderrTail();
    if (tail !== undefined) error.stderrTail = tail;
    return { ok: false, error };
  }

  const parsed = opts.outputSchema.safeParse(resultMessage.structured_output);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: 'schema_validation',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
        rawOutput: resultMessage.structured_output,
        sessionId: resultMessage.session_id,
      },
    };
  }

  opts.emit?.({
    type: 'phase_finished',
    phase: opts.phase,
    sessionId: resultMessage.session_id,
  });

  return {
    ok: true,
    output: parsed.data as z.infer<TSchema>,
    sessionId: resultMessage.session_id,
    checkpointId,
    numTurns: resultMessage.num_turns,
    durationMs: resultMessage.duration_ms,
    costUsd: resultMessage.total_cost_usd,
  };
}

function allowsWrites(tools: readonly string[]): boolean {
  return tools.some((tool) => tool === 'Edit' || tool === 'Write');
}

function forwardAssistantBlocks(
  phase: PhaseEvent extends { phase: infer P } ? P : never,
  msg: Extract<SDKMessage, { type: 'assistant' }>,
  emit: ((event: PhaseEvent) => void) | undefined,
): void {
  if (emit === undefined) return;
  const content = (msg.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const blockType = (block as { type?: unknown }).type;
    if (blockType === 'tool_use') {
      emit({
        type: 'tool_use',
        phase,
        toolName: String((block as { name?: unknown }).name ?? 'unknown'),
        input: (block as { input?: unknown }).input,
      });
    } else if (blockType === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) {
        emit({ type: 'assistant_text', phase, text });
      }
    }
  }
}
