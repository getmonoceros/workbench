import type {
  Options as SdkOptions,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runPhase, type PhaseEvent, type QueryFn } from '../src/index.js';

const OutputSchema = z.object({ greeting: z.string() });
const SESSION_ID = 'sess_test_abc';

function makeFakeQuery(messages: SDKMessage[]): {
  fn: QueryFn;
  calls: Array<{ prompt: string; options?: SdkOptions }>;
} {
  const calls: Array<{ prompt: string; options?: SdkOptions }> = [];
  const fn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    return (async function* () {
      for (const m of messages) yield m;
    })() as unknown as ReturnType<QueryFn>;
  };
  return { fn, calls };
}

function userMsg(uuid?: string): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: 'x' },
    parent_tool_use_id: null,
    uuid,
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

function assistantToolUse(toolName: string, input: unknown): SDKMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: toolName, id: 'tu_1', input }],
    },
    parent_tool_use_id: null,
    uuid: 'au_1',
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

function assistantText(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    uuid: 'au_2',
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

function resultSuccess(structured: unknown): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1234,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 3,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0123,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    structured_output: structured,
    uuid: 'r_1',
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

function resultSuccessNoStructured(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 0,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: 'r',
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

function resultError(
  subtype:
    | 'error_max_turns'
    | 'error_during_execution'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries',
  errors: string[],
): SDKMessage {
  return {
    type: 'result',
    subtype,
    duration_ms: 100,
    duration_api_ms: 50,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: 'r_err',
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

const basePhaseOpts = {
  phase: 'planner' as const,
  systemPrompt: 'You are the planner.',
  userPrompt: 'Plan the work',
  outputSchema: OutputSchema,
  allowedTools: ['Read', 'Glob'] as const,
  cwd: '/workspace',
};

describe('runPhase — happy path', () => {
  it('returns success with parsed output, sessionId, metrics', async () => {
    const { fn } = makeFakeQuery([
      userMsg(),
      assistantText('thinking...'),
      resultSuccess({ greeting: 'hello' }),
    ]);
    const result = await runPhase(basePhaseOpts, fn);
    expect(result).toEqual({
      ok: true,
      output: { greeting: 'hello' },
      sessionId: SESSION_ID,
      checkpointId: null,
      numTurns: 3,
      durationMs: 1234,
      costUsd: 0.0123,
    });
  });

  it('converts the Zod schema to JSON schema and passes it as outputFormat', async () => {
    const { fn, calls } = makeFakeQuery([resultSuccess({ greeting: 'x' })]);
    await runPhase(basePhaseOpts, fn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.outputFormat).toEqual({
      type: 'json_schema',
      schema: expect.objectContaining({
        type: 'object',
        properties: expect.any(Object),
      }),
    });
  });

  it('forwards system prompt, allowedTools, cwd to the SDK', async () => {
    const { fn, calls } = makeFakeQuery([resultSuccess({ greeting: 'x' })]);
    await runPhase(basePhaseOpts, fn);
    const opts = calls[0]!.options!;
    expect(opts.systemPrompt).toBe('You are the planner.');
    expect(opts.allowedTools).toEqual(['Read', 'Glob']);
    expect(opts.cwd).toBe('/workspace');
  });

  it('passes the resume sessionId when given', async () => {
    const { fn, calls } = makeFakeQuery([resultSuccess({ greeting: 'x' })]);
    await runPhase({ ...basePhaseOpts, resumeSessionId: 'sess_prev' }, fn);
    expect(calls[0]!.options?.resume).toBe('sess_prev');
  });

  it('passes the model override when given', async () => {
    const { fn, calls } = makeFakeQuery([resultSuccess({ greeting: 'x' })]);
    await runPhase({ ...basePhaseOpts, model: 'claude-opus-4-7' }, fn);
    expect(calls[0]!.options?.model).toBe('claude-opus-4-7');
  });
});

describe('runPhase — permission mode and checkpointing', () => {
  it('does not set permissionMode when the toolset is read-only', async () => {
    const { fn, calls } = makeFakeQuery([resultSuccess({ greeting: 'x' })]);
    await runPhase(basePhaseOpts, fn);
    expect(calls[0]!.options?.permissionMode).toBeUndefined();
  });

  it('sets acceptEdits when Edit/Write is in the toolset', async () => {
    const { fn, calls } = makeFakeQuery([resultSuccess({ greeting: 'x' })]);
    await runPhase(
      {
        ...basePhaseOpts,
        phase: 'generator',
        allowedTools: ['Read', 'Edit', 'Bash'],
      },
      fn,
    );
    expect(calls[0]!.options?.permissionMode).toBe('acceptEdits');
  });

  it('wires all four checkpointing options together when enabled', async () => {
    const { fn, calls } = makeFakeQuery([
      userMsg('uuid-anchor-1'),
      resultSuccess({ greeting: 'x' }),
    ]);
    const result = await runPhase(
      {
        ...basePhaseOpts,
        phase: 'generator',
        allowedTools: ['Edit'],
        enableCheckpointing: true,
      },
      fn,
    );
    const opts = calls[0]!.options!;
    expect(opts.enableFileCheckpointing).toBe(true);
    expect(opts.permissionMode).toBe('acceptEdits');
    expect(opts.extraArgs).toEqual({ 'replay-user-messages': null });
    expect(opts.env?.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('1');
    if (!result.ok) throw new Error('expected ok');
    expect(result.checkpointId).toBe('uuid-anchor-1');
  });

  it('returns checkpointId = null when checkpointing is disabled', async () => {
    const { fn } = makeFakeQuery([
      userMsg('uuid-still-there'),
      resultSuccess({ greeting: 'x' }),
    ]);
    const result = await runPhase(basePhaseOpts, fn);
    if (!result.ok) throw new Error('expected ok');
    expect(result.checkpointId).toBeNull();
  });
});

describe('runPhase — event emission', () => {
  it('emits session_started, tool_use, assistant_text and phase_finished in order', async () => {
    const events: PhaseEvent[] = [];
    const { fn } = makeFakeQuery([
      userMsg(),
      assistantToolUse('Read', { path: 'a.ts' }),
      assistantText('done'),
      resultSuccess({ greeting: 'hi' }),
    ]);
    await runPhase({ ...basePhaseOpts, emit: (e) => events.push(e) }, fn);
    expect(events.map((e) => e.type)).toEqual([
      'session_started',
      'tool_use',
      'assistant_text',
      'phase_finished',
    ]);
    expect(events[1]).toMatchObject({
      toolName: 'Read',
      input: { path: 'a.ts' },
      phase: 'planner',
    });
    expect(events[2]).toMatchObject({ text: 'done', phase: 'planner' });
  });

  it('skips empty assistant text blocks', async () => {
    const events: PhaseEvent[] = [];
    const { fn } = makeFakeQuery([
      assistantText(''),
      resultSuccess({ greeting: 'hi' }),
    ]);
    await runPhase({ ...basePhaseOpts, emit: (e) => events.push(e) }, fn);
    expect(events.map((e) => e.type)).not.toContain('assistant_text');
  });
});

describe('runPhase — failure modes', () => {
  it('returns schema_validation when structured_output does not match', async () => {
    const { fn } = makeFakeQuery([resultSuccess({ greeting: 42 })]);
    const result = await runPhase(basePhaseOpts, fn);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('schema_validation');
    if (result.error.kind !== 'schema_validation') return;
    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(result.error.issues[0]!.path).toBe('greeting');
    expect(result.error.rawOutput).toEqual({ greeting: 42 });
    expect(result.error.sessionId).toBe(SESSION_ID);
  });

  it('returns sdk_error for an error subtype result', async () => {
    const { fn } = makeFakeQuery([
      resultError('error_max_turns', ['too many turns']),
    ]);
    const result = await runPhase(basePhaseOpts, fn);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toEqual({
      kind: 'sdk_error',
      subtype: 'error_max_turns',
      errors: ['too many turns'],
      sessionId: SESSION_ID,
    });
  });

  it('returns sdk_error for error_max_structured_output_retries', async () => {
    const { fn } = makeFakeQuery([
      resultError('error_max_structured_output_retries', [
        'schema not matched 3x',
      ]),
    ]);
    const result = await runPhase(basePhaseOpts, fn);
    if (result.ok) throw new Error('expected failure');
    if (result.error.kind !== 'sdk_error') throw new Error('wrong kind');
    expect(result.error.subtype).toBe('error_max_structured_output_retries');
  });

  it('returns missing_output when the stream ends without a result message', async () => {
    const { fn } = makeFakeQuery([userMsg(), assistantText('huh')]);
    const result = await runPhase(basePhaseOpts, fn);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('missing_output');
  });

  it('returns missing_output when result is success but structured_output is undefined', async () => {
    const { fn } = makeFakeQuery([resultSuccessNoStructured()]);
    const result = await runPhase(basePhaseOpts, fn);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('missing_output');
  });

  it('returns aborted when the abortController is aborted mid-stream', async () => {
    const abortController = new AbortController();
    const fn: QueryFn = () =>
      (async function* () {
        yield userMsg();
        abortController.abort();
        throw new Error('cancelled in test');
      })() as unknown as ReturnType<QueryFn>;
    const result = await runPhase({ ...basePhaseOpts, abortController }, fn);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('aborted');
  });

  it('re-throws unexpected errors when the controller is not aborted', async () => {
    const fn: QueryFn = () =>
      // eslint-disable-next-line require-yield -- iterator throws before its first yield
      (async function* () {
        throw new Error('network blew up');
      })() as unknown as ReturnType<QueryFn>;
    await expect(runPhase(basePhaseOpts, fn)).rejects.toThrow(
      'network blew up',
    );
  });
});
