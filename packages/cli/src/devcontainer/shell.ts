import path from 'node:path';
import { consola } from 'consola';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
import { findSolutionRoot } from './locate.js';

export interface ShellLogger {
  info: (message: string) => void;
}

export interface RunShellOptions {
  cwd?: string;
  project?: string;
  spawn?: DevcontainerSpawn;
  logger?: ShellLogger;
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

  const logger: ShellLogger = opts.logger ?? {
    info: (msg) => consola.info(msg),
  };
  const spawnFn = opts.spawn ?? spawnDevcontainer;

  logger.info(`Bringing devcontainer up at ${root}…`);
  const upCode = await spawnFn(['up', '--workspace-folder', root], root);
  if (upCode !== 0) return upCode;

  logger.info(`Opening shell in ${root}…`);
  return spawnFn(['exec', '--workspace-folder', root, 'bash'], root);
}
