import path from 'node:path';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
import { findSolutionRoot } from './locate.js';

export interface RunInContainerOptions {
  command: string[];
  cwd?: string;
  project?: string;
  spawn?: DevcontainerSpawn;
}

// Run a one-off command inside the solution's devcontainer. Brings the
// container up if needed (silently — only the inner command's stdio is
// passed through), then forwards the command verbatim to
// `devcontainer exec`. The inner command's exit code is propagated.
export async function runInContainer(
  opts: RunInContainerOptions,
): Promise<number> {
  if (opts.command.length === 0) {
    throw new Error(
      'No command provided. Usage: `monoceros run -- <cmd> [args…]`.',
    );
  }
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

  return spawnFn(['exec', '--workspace-folder', root, ...opts.command], root);
}

// Pull everything after the first `--` from the raw argv. Required because
// citty parses unknown flags (e.g. `-la`) into named args otherwise; users
// must use `--` to mark the boundary between monoceros flags and the inner
// command.
export function extractInnerCommand(rawArgs: string[]): string[] {
  const idx = rawArgs.indexOf('--');
  if (idx === -1) return [];
  return rawArgs.slice(idx + 1);
}
