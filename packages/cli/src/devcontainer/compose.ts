import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { findSolutionRoot } from './locate.js';

export type ComposeSpawn = (args: string[], cwd: string) => Promise<number>;

// Default spawn: shells out to `docker compose` (the v2 docker subcommand).
// Stdio is inherited so live output (logs -f, ps tables, …) flows through
// to the host terminal.
export const spawnDockerCompose: ComposeSpawn = (args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', ...args], {
      cwd,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
};

interface ResolvedCompose {
  root: string;
  composeFile: string;
}

export function resolveCompose(
  cwd: string,
  project: string | undefined,
): ResolvedCompose {
  const startDir = project ? path.resolve(cwd, project) : cwd;
  const root = findSolutionRoot(startDir);
  if (!root) {
    throw new Error(
      `No .devcontainer/ found at or above ${startDir}. Run \`monoceros create\` first or change into a solution directory.`,
    );
  }
  const composeFile = path.join(root, '.devcontainer', 'compose.yaml');
  if (!existsSync(composeFile)) {
    throw new Error(
      `No compose.yaml at ${composeFile}. \`start\` / \`stop\` / \`status\` / \`logs\` require services configured via \`monoceros add-service\`. Use \`monoceros shell\` to enter the container directly.`,
    );
  }
  return { root, composeFile };
}

export interface ComposeActionOptions {
  cwd?: string;
  project?: string;
  service?: string;
  spawn?: ComposeSpawn;
}

async function runComposeAction(
  buildSubArgs: (service: string | undefined) => string[],
  opts: ComposeActionOptions,
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const { root, composeFile } = resolveCompose(cwd, opts.project);
  const spawnFn = opts.spawn ?? spawnDockerCompose;
  const subArgs = buildSubArgs(opts.service);
  return spawnFn(['-f', composeFile, ...subArgs], root);
}

export function runStart(opts: ComposeActionOptions = {}): Promise<number> {
  return runComposeAction(
    (service) => ['up', '-d', ...(service ? [service] : [])],
    opts,
  );
}

export function runStop(opts: ComposeActionOptions = {}): Promise<number> {
  return runComposeAction(
    (service) => ['stop', ...(service ? [service] : [])],
    opts,
  );
}

export function runStatus(opts: ComposeActionOptions = {}): Promise<number> {
  return runComposeAction(
    (service) => ['ps', ...(service ? [service] : [])],
    opts,
  );
}

export interface LogsOptions extends ComposeActionOptions {
  follow?: boolean;
}

export function runLogs(opts: LogsOptions = {}): Promise<number> {
  const follow = opts.follow ?? true;
  return runComposeAction(
    (service) => [
      'logs',
      ...(follow ? ['-f'] : []),
      ...(service ? [service] : []),
    ],
    opts,
  );
}
