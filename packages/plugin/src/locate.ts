import { access } from 'node:fs/promises';
import path from 'node:path';

/**
 * Walks up from the given start directory looking for a Monoceros
 * solution root, signalled by the presence of `.monoceros/` or
 * `.devcontainer/`. Returns the directory containing whichever marker
 * is found first.
 *
 * Throws if neither marker exists from `start` up to the filesystem
 * root — that's the case where the slash command was invoked outside
 * a Monoceros solution.
 */
export async function findSolutionRoot(start: string): Promise<string> {
  let dir = path.resolve(start);
  while (true) {
    if (await hasMarker(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Not inside a Monoceros solution — no .monoceros/ or .devcontainer/ found from ${start} upwards.`,
      );
    }
    dir = parent;
  }
}

async function hasMarker(dir: string): Promise<boolean> {
  for (const name of ['.monoceros', '.devcontainer']) {
    try {
      await access(path.join(dir, name));
      return true;
    } catch {
      // ENOENT — try the next marker
    }
  }
  return false;
}
