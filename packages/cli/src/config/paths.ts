import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Path helpers for the M2.5 Phase 3 yml-profile model.
 *
 *   <workbench-root>/
 *     templates/yml/<template>.yml          ← shipped read-only templates
 *     .local/container-configs/<name>.yml   ← builder-owned user configs
 *
 * During dev/test the workbench is a git checkout and both directories
 * live inside it. Distribution channel (M4) may move the user-config
 * dir elsewhere (e.g. `~/.monoceros/container-configs/`) — the rest of
 * the code goes through these helpers so that move is a one-file
 * change.
 */

let cachedWorkbenchRoot: string | null = null;

/**
 * Walk upwards from this module until we find the workbench checkout's
 * marker file. We pick `templates/yml/README.md` because it ships with
 * the Phase-3 work and is unlikely to be deleted; if it ever goes
 * away, the create-scaffold side has its own marker so this function
 * is the only one to update.
 */
export function workbenchRoot(): string {
  if (cachedWorkbenchRoot) return cachedWorkbenchRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const marker = path.join(dir, 'templates', 'yml', 'README.md');
    if (existsSync(marker)) {
      cachedWorkbenchRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        'Could not locate monoceros workbench root (no templates/yml/README.md found by walking up). Run the CLI from a workbench checkout.',
      );
    }
    dir = parent;
  }
}

/** Reset the cached workbench-root lookup. Test-only. */
export function _resetWorkbenchRootForTests(): void {
  cachedWorkbenchRoot = null;
}

export function templatesDir(root: string = workbenchRoot()): string {
  return path.join(root, 'templates', 'yml');
}

export function templatePath(
  template: string,
  root: string = workbenchRoot(),
): string {
  return path.join(templatesDir(root), `${template}.yml`);
}

export function configsDir(root: string = workbenchRoot()): string {
  return path.join(root, '.local', 'container-configs');
}

export function configPath(
  name: string,
  root: string = workbenchRoot(),
): string {
  return path.join(configsDir(root), `${name}.yml`);
}
