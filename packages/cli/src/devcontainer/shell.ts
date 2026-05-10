import path from 'node:path';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
import { findSolutionRoot } from './locate.js';

// Kept exported for backwards compatibility with run.ts; nothing in
// shell.ts uses it directly anymore (the implicit `up` is silent unless
// it fails, and the bash exec inherits stdio).
export interface ShellLogger {
  info: (message: string) => void;
}

export interface RunShellOptions {
  cwd?: string;
  project?: string;
  spawn?: DevcontainerSpawn;
}

export async function runShell(opts: RunShellOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const startDir = opts.project ? path.resolve(cwd, opts.project) : cwd;
  const root = findSolutionRoot(startDir);
  if (!root) {
    throw new Error(
      `No .devcontainer/ found at or above ${startDir}. Run \`monoceros create\` first or change into a solution directory.`,
    );
  }

  const spawnFn = opts.spawn ?? spawnDevcontainer;

  const upCode = await spawnFn(['up', '--workspace-folder', root], root, {
    quiet: true,
  });
  if (upCode !== 0) return upCode;

  return spawnFn(['exec', '--workspace-folder', root, 'bash'], root);
}
