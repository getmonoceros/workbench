import {
  query as sdkQuery,
  type Options as SdkOptions,
} from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from './agent.js';

/**
 * Rewinds the solution workspace to the state captured at
 * `checkpointId`. The checkpoint UUID comes from the first
 * user-message of a prior `runPhase` call that ran with
 * `enableCheckpointing: true` (the Generator phase in our pipeline).
 *
 * Mechanics — verbatim from the SDK file-checkpointing guide:
 * resume the previous session with an empty prompt, then invoke
 * `rewindFiles(uuid)` on the returned Query object as soon as the
 * connection is open.
 */
export async function rewindToCheckpoint(
  sessionId: string,
  checkpointId: string,
  cwd: string,
  queryFn: QueryFn = sdkQuery,
): Promise<void> {
  const options: SdkOptions = {
    cwd,
    resume: sessionId,
    enableFileCheckpointing: true,
    permissionMode: 'acceptEdits',
    extraArgs: { 'replay-user-messages': null },
    env: {
      ...process.env,
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
    } as Record<string, string>,
  };

  const stream = queryFn({ prompt: '', options });

  for await (const _msg of stream) {
    await stream.rewindFiles(checkpointId);
    break;
  }
}
