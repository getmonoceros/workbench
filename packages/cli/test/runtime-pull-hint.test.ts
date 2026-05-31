import { describe, expect, it } from 'vitest';
import {
  createRuntimePullHintStream,
  RUNTIME_PULL_HINT,
  RUNTIME_PULL_MARKER,
  type PullHintState,
} from '../src/devcontainer/runtime-pull-hint.js';

/** Feed `input` through the transform and collect the emitted output. */
async function run(input: string, state: PullHintState): Promise<string> {
  const stream = createRuntimePullHintStream(state);
  const chunks: string[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  const done = new Promise<void>((resolve) =>
    stream.on('end', () => resolve()),
  );
  stream.end(input);
  await done;
  return chunks.join('');
}

describe('createRuntimePullHintStream', () => {
  it('passes ordinary output through unchanged', async () => {
    const out = await run('building feature layers\nall good\n', {
      hinted: false,
    });
    expect(out).toBe('building feature layers\nall good\n');
  });

  it('appends the hint right after the manifest marker line', async () => {
    const input = `[12:00:00] @devcontainers/cli\nError fetching image details: ${RUNTIME_PULL_MARKER}:1.\n`;
    const out = await run(input, { hinted: false });
    expect(out).toContain(RUNTIME_PULL_MARKER);
    expect(out).toContain(RUNTIME_PULL_HINT);
    // Hint comes after the marker, not before.
    expect(out.indexOf(RUNTIME_PULL_HINT)).toBeGreaterThan(
      out.indexOf(RUNTIME_PULL_MARKER),
    );
  });

  it('fires only once even if the marker recurs', async () => {
    const state: PullHintState = { hinted: false };
    const line = `Error: ${RUNTIME_PULL_MARKER}:1.\n`;
    const out = await run(line + line, state);
    const occurrences = out.split(RUNTIME_PULL_HINT).length - 1;
    expect(occurrences).toBe(1);
    expect(state.hinted).toBe(true);
  });

  it('does not fire when state is already hinted (shared across streams)', async () => {
    const out = await run(`Error: ${RUNTIME_PULL_MARKER}:1.\n`, {
      hinted: true,
    });
    expect(out).not.toContain(RUNTIME_PULL_HINT);
  });
});
