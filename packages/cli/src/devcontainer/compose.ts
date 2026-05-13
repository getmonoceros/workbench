import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
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
  projectName: string;
}

// Match the project name `@devcontainers/cli` derives when it brings a
// compose-mode devcontainer up: `<solution-folder-basename>_devcontainer`.
// Aligning here means `monoceros start/stop/status/logs` and the implicit
// `devcontainer up` from `monoceros run/shell` act on the same compose
// project — without it docker would create two parallel stacks.
export function composeProjectName(root: string): string {
  return `${path.basename(root)}_devcontainer`;
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
  return { root, composeFile, projectName: composeProjectName(root) };
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
  const { root, composeFile, projectName } = resolveCompose(cwd, opts.project);
  const spawnFn = opts.spawn ?? spawnDockerCompose;
  const subArgs = buildSubArgs(opts.service);
  return spawnFn(['-f', composeFile, '-p', projectName, ...subArgs], root);
}

export interface StartOptions {
  cwd?: string;
  project?: string;
  spawn?: DevcontainerSpawn;
  logger?: { info: (message: string) => void };
}

// `monoceros start` delegates to `devcontainer up` rather than to
// `docker compose up -d`. The detour through @devcontainers/cli matters
// because:
//   - it labels the workspace container with `devcontainer.local_folder`
//     so subsequent `devcontainer exec` (from `monoceros run/shell`) can
//     find the container by workspace path,
//   - it applies devcontainer features (which docker compose ignores), and
//   - it triggers the postCreateCommand once.
// The auxiliary services come up alongside because the generated
// devcontainer.json lists them under `runServices`.
export async function runStart(opts: StartOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const startDir = opts.project ? path.resolve(cwd, opts.project) : cwd;
  const root = findSolutionRoot(startDir);
  if (!root) {
    throw new Error(
      `No .devcontainer/ found at or above ${startDir}. Run \`monoceros create\` first or change into a solution directory.`,
    );
  }
  const composeFile = path.join(root, '.devcontainer', 'compose.yaml');
  if (!existsSync(composeFile)) {
    throw new Error(
      `No compose.yaml at ${composeFile}. \`monoceros start\` is only meaningful with services configured via \`monoceros add-service\`. Use \`monoceros shell\` to enter an image-mode container directly.`,
    );
  }
  const logger = opts.logger ?? { info: (msg) => consola.info(msg) };
  const spawnFn = opts.spawn ?? spawnDevcontainer;

  logger.info(`Bringing devcontainer up at ${root}…`);
  return spawnFn(['up', '--workspace-folder', root], root);
}

export interface DownOptions {
  cwd?: string;
  project?: string;
  // When true, also drop named volumes (postgres-data etc.). Default
  // is false — `down` removes containers and the project network so a
  // subsequent `start` recreates the workspace from the current image,
  // but service data survives.
  volumes?: boolean;
  spawn?: ComposeSpawn;
}

// `monoceros down` removes containers + network for the project so a
// fresh `start` picks up image changes (after `pnpm image:rebuild`,
// after edits to compose.yaml, …). `stop` alone leaves the container
// in place and `devcontainer up` will reuse it.
export async function runDown(opts: DownOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const { root, composeFile, projectName } = resolveCompose(cwd, opts.project);
  const spawnFn = opts.spawn ?? spawnDockerCompose;
  const args = ['-f', composeFile, '-p', projectName, 'down'];
  if (opts.volumes) args.push('-v');
  return spawnFn(args, root);
}

export interface ApplyOptions {
  cwd?: string;
  project?: string;
  // Compose-mode `apply` shells out to `docker compose down`; this hook
  // injects an alternative spawn for tests.
  dockerComposeSpawn?: ComposeSpawn;
  // Both compose- and image-mode `apply` call `devcontainer up` at the
  // end; this hook covers that side.
  devcontainerSpawn?: DevcontainerSpawn;
  logger?: { info: (message: string) => void };
}

// `monoceros apply` is the convenience step the builder runs after any
// `monoceros add-*` to materialise the change in the running container.
// Internally:
//   - compose-mode (compose.yaml present): `docker compose down`
//     (volumes preserved) followed by `devcontainer up`. The down step
//     wipes the workspace container so the rebuild picks up new
//     devcontainer features; named volumes (postgres-data etc.) survive.
//   - image-mode (no compose.yaml): `devcontainer up --remove-existing-container`,
//     which stops + removes the workspace container and recreates it
//     in one step. Equivalent to the compose-mode down+start, just
//     without an aux-service compose stack to manage.
// If the down step fails (non-zero exit), the up step is skipped so
// the failure surfaces clearly instead of being masked by a successful
// `up` on a half-broken stack.
export async function runApply(opts: ApplyOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const startDir = opts.project ? path.resolve(cwd, opts.project) : cwd;
  const root = findSolutionRoot(startDir);
  if (!root) {
    throw new Error(
      `No .devcontainer/ found at or above ${startDir}. Run \`monoceros create\` first or change into a solution directory.`,
    );
  }
  const composeFile = path.join(root, '.devcontainer', 'compose.yaml');
  const hasCompose = existsSync(composeFile);
  const logger = opts.logger ?? { info: (msg) => consola.info(msg) };

  if (hasCompose) {
    logger.info('Stopping containers (volumes preserved)…');
    const downCode = await runDown({
      cwd,
      ...(opts.project !== undefined ? { project: opts.project } : {}),
      volumes: false,
      ...(opts.dockerComposeSpawn ? { spawn: opts.dockerComposeSpawn } : {}),
    });
    if (downCode !== 0) return downCode;

    return runStart({
      cwd,
      ...(opts.project !== undefined ? { project: opts.project } : {}),
      ...(opts.devcontainerSpawn ? { spawn: opts.devcontainerSpawn } : {}),
      logger,
    });
  }

  logger.info(`Recreating image-mode devcontainer at ${root}…`);
  const spawnFn = opts.devcontainerSpawn ?? spawnDevcontainer;
  return spawnFn(
    ['up', '--workspace-folder', root, '--remove-existing-container'],
    root,
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
