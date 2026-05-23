import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';

export interface ShellLogger {
  info: (message: string) => void;
}

export interface RunShellOptions {
  /** Container root: `<MONOCEROS_HOME>/container/<name>/`. */
  root: string;
  spawn?: DevcontainerSpawn;
}

export async function runShell(opts: RunShellOptions): Promise<number> {
  assertContainerExists(opts.root);
  const spawnFn = opts.spawn ?? spawnDevcontainer;

  const upCode = await spawnFn(
    ['up', '--workspace-folder', opts.root, '--mount-workspace-git-root=false'],
    opts.root,
    { quiet: true },
  );
  if (upCode !== 0) return upCode;

  return spawnFn(
    [
      'exec',
      '--workspace-folder',
      opts.root,
      '--mount-workspace-git-root=false',
      'bash',
    ],
    opts.root,
    { interactive: true },
  );
}

export function assertContainerExists(root: string): void {
  if (!existsSync(path.join(root, '.devcontainer'))) {
    throw new Error(
      `No .devcontainer/ at ${root}. Run \`monoceros apply <name>\` first.`,
    );
  }
}
