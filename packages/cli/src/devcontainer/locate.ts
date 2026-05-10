import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

// Walk upwards from `startDir` looking for a `.devcontainer/` directory.
// Returns the directory that contains it (the solution root) or null when
// the walk reaches the filesystem root without finding one.
export function findSolutionRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, '.devcontainer');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
