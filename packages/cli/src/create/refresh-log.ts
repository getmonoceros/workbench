import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bold, dim } from '../util/format.js';

/**
 * Refresh log: what the container's refresh hooks did on this apply.
 *
 * A tool feature installs its CLI into a cached image layer, and every apply
 * recreates the container from that layer. Left alone, the builder therefore
 * starts on the version that was current when the layer was first built, and
 * any self-update the previous container had applied is gone (ADR 0054). The
 * refresh hooks fix that at container start; this file is how they tell the
 * builder they did.
 *
 * The channel has to be a file, not the build log: post-create output scrolls
 * past behind the spinner, and the whole point of the exercise is that the
 * builder can *see* they are current. Same reasoning as the feature notes next
 * door, so the mechanics are the same — the hook appends a line into a
 * workspace file, apply reads it after the container is up and prints it.
 *
 * Deliberately dumb: one line per tool, plain text, written by shell. No
 * severity, no schema. The log is cleared at the start of every refresh pass,
 * so it always describes the apply the builder just ran.
 */

/** Workspace-relative path of the refresh log. */
export const REFRESH_LOG_FILENAME = path.join('.monoceros', 'refresh.log');

/** In-container path of the refresh log for a container name. */
export function refreshLogInContainer(containerName: string): string {
  return `/workspaces/${containerName}/${REFRESH_LOG_FILENAME}`;
}

/**
 * Read the lines the last refresh pass left behind. An absent or unreadable
 * file means "nothing to report": this is a reporting nicety and must never be
 * the reason an apply looks broken.
 */
export async function readRefreshLog(targetDir: string): Promise<string[]> {
  let content: string;
  try {
    content = await fs.readFile(
      path.join(targetDir, REFRESH_LOG_FILENAME),
      'utf8',
    );
  } catch {
    return [];
  }
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Render the refresh lines as a plain end-of-apply block. Not a warning: it
 * reports normal, successful work, so it gets neither the `⚠` heading nor the
 * yellow of the notes block. A tool that could not be checked says so on its
 * own line and is not escalated either — the builder still has a working tool
 * from the image.
 */
export function formatRefreshLog(lines: readonly string[]): string {
  const out = [bold('   Tools refreshed')];
  for (const line of lines) out.push(`     • ${line}`);
  out.push(
    dim('     Services and the base image move on `monoceros upgrade`.'),
  );
  return out.join('\n');
}
