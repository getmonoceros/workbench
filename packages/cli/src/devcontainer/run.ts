import path from 'node:path';
import { consola } from 'consola';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
import { findSolutionRoot } from './locate.js';
import type { ShellLogger } from './shell.js';

export interface RunInContainerOptions {
  command: string[];
  cwd?: string;
  project?: string;
  spawn?: DevcontainerSpawn;
  logger?: ShellLogger;
}

// Run a one-off command inside the solution's devcontainer. Brings the
// container up if needed, then forwards the command verbatim to
// `devcontainer exec`. Stdio is inherited so output streams to the host
// terminal and the inner command's exit code is propagated.
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

  const logger: ShellLogger = opts.logger ?? {
    info: (msg) => consola.info(msg),
  };
  const spawnFn = opts.spawn ?? spawnDevcontainer;

  logger.info(`Bringing devcontainer up at ${root}…`);
  const upCode = await spawnFn(['up', '--workspace-folder', root], root);
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
