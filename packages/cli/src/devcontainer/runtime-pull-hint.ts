import { Transform, type TransformCallback } from 'node:stream';
import { dim } from '../util/format.js';

/**
 * devcontainer-cli logs this line when it probes the multi-arch GHCR
 * manifest for our runtime image before pulling it. It reads as an
 * "Error", but it's harmless — the buildx pull right after consumes
 * the image fine. The catch: on a cold cache Docker then downloads the
 * base for ~1–2 min with NO further output. Left unannotated, the
 * "Error … No manifest found" line is the LAST thing on screen before
 * that silence, so builders reasonably conclude the apply broke.
 */
export const RUNTIME_PULL_MARKER =
  'No manifest found for ghcr.io/getmonoceros/monoceros-runtime';

export const RUNTIME_PULL_HINT =
  'Downloading the Monoceros runtime image now — expected on first apply, ' +
  'takes ~1–2 min (Docker pulls the multi-arch base with no progress ' +
  'output). The "No manifest found" line above is harmless. Please wait…';

export interface PullHintState {
  hinted: boolean;
}

/**
 * Line-oriented transform that passes devcontainer-cli output through
 * untouched and, the first time it sees {@link RUNTIME_PULL_MARKER},
 * appends {@link RUNTIME_PULL_HINT} on its own line right after.
 *
 * `state` is shared across the stdout and stderr instances so the hint
 * fires exactly once regardless of which stream devcontainer-cli logged
 * the marker on. Sits after the secret-mask stream in the pipe chain.
 */
export function createRuntimePullHintStream(state: PullHintState): Transform {
  let buffer = '';
  const appendHintIfMarker = (block: string): string => {
    if (state.hinted || !block.includes(RUNTIME_PULL_MARKER)) return block;
    state.hinted = true;
    return `${block}${dim(`ℹ ${RUNTIME_PULL_HINT}`)}\n`;
  };
  return new Transform({
    decodeStrings: true,
    transform(chunk: Buffer | string, _enc, cb: TransformCallback): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      buffer += text;
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline === -1) {
        cb(null);
        return;
      }
      const flushable = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      cb(null, appendHintIfMarker(flushable));
    },
    flush(cb: TransformCallback): void {
      if (buffer.length === 0) {
        cb(null);
        return;
      }
      const tail = buffer;
      buffer = '';
      cb(null, appendHintIfMarker(tail));
    },
  });
}
