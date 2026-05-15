import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import type { RepoEntry, StackFile } from '../create/types.js';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
import { collectGitCredentials, type CredentialsSpawn } from './credentials.js';
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

// Generic shell spawn used by `monoceros apply` for the label-based
// container cleanup (a small pipeline that's awkward to express as a
// pure argv vector). Same ComposeSpawn shape so tests can inject a
// fake; `args[0]` is `-c`, `args[1]` is the shell command string.
export const spawnBash: ComposeSpawn = (args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', args, {
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
  // Compose-mode `apply` shells out to a bash one-liner that force-
  // removes the project's containers and network. Same shape as
  // ComposeSpawn so tests can inject a fake. Args are `['-c', '<script>']`.
  cleanupSpawn?: ComposeSpawn;
  // Both compose- and image-mode `apply` call `devcontainer up` at the
  // end; this hook covers that side.
  devcontainerSpawn?: DevcontainerSpawn;
  // Host-side `git credential fill` for HTTPS repos. Default spawns
  // real git; tests inject a fake. Skipped when no HTTPS repos in
  // stack.json.
  credentialsSpawn?: CredentialsSpawn;
  logger?: {
    info: (message: string) => void;
    warn?: (message: string) => void;
  };
}

// `monoceros apply` is the convenience step the builder runs after any
// `monoceros add-*` to materialise the change in the running container.
// Internally:
//   - compose-mode (compose.yaml present): force-remove all containers
//     carrying the project label, drop the default network, then
//     `devcontainer up` to rebuild. Named volumes (postgres-data etc.)
//     survive because the cleanup only touches containers + network.
//   - image-mode (no compose.yaml): `devcontainer up --remove-existing-container`,
//     which stops + removes the workspace container and recreates it
//     in one step.
//
// Why a direct label-based cleanup instead of `docker compose down`:
// docker compose's down only matches containers whose
// `com.docker.compose.project.config_files` label matches the current
// compose-file set. When a builder mixes `@devcontainers/cli`-managed
// containers (via `monoceros start/apply`) with VS Code's
// "Reopen in Container" extension — both write `project=<solution>_devcontainer`
// but use different temporary merge files — compose-down silently
// skips the containers from the "other" tool. The label-based force
// remove sidesteps that entirely.
//
// If the cleanup step fails (non-zero exit), the up step is skipped so
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
  const logger = opts.logger ?? {
    info: (msg) => consola.info(msg),
    warn: (msg) => consola.warn(msg),
  };
  const credsLogger = {
    info: logger.info,
    warn: logger.warn ?? logger.info,
  };

  // Step 0: pull host-side git credentials for any HTTPS repos. Runs
  // before container teardown so the credentials file is in place
  // when post-create.sh tries to clone.
  const repos = await readRepoEntries(root);
  if (repos.some((r) => r.url.startsWith('https://'))) {
    await collectGitCredentials(root, repos, {
      ...(opts.credentialsSpawn ? { spawn: opts.credentialsSpawn } : {}),
      logger: credsLogger,
    });
  }

  if (hasCompose) {
    const projectName = composeProjectName(root);
    logger.info(
      `Force-removing existing ${projectName} containers (volumes preserved)…`,
    );
    const cleanupSpawn = opts.cleanupSpawn ?? spawnBash;
    // Two-step removal so a container with stale/missing labels still
    // gets caught:
    //   - by docker-compose project label (covers tool-managed
    //     containers from @devcontainers/cli or VS Code's Remote
    //     Containers extension)
    //   - by container-name prefix `<project>-*` (covers leftover
    //     containers whose labels drifted or were never set)
    // Each command is guarded with `|| true` so a missing target
    // (empty list, no such network) doesn't abort the whole script.
    // After removal we re-query: if anything remains, VS Code's
    // Remote Containers extension is the most likely culprit
    // (auto-recreates on container loss), so we abort with a clear
    // hint rather than letting `devcontainer up` collide.
    const script = [
      `set -u`,
      `echo "[cleanup] checking project ${projectName}…"`,
      `by_label=$(docker ps -aq --filter "label=com.docker.compose.project=${projectName}" 2>/dev/null || true)`,
      `by_name=$(docker ps -aq --filter "name=^${projectName}-" 2>/dev/null || true)`,
      `to_remove=$(printf "%s\\n%s\\n" "$by_label" "$by_name" | sort -u | grep -v "^$" || true)`,
      `if [ -n "$to_remove" ]; then echo "[cleanup] removing: $(echo $to_remove | tr "\\n" " ")"; docker rm -f $to_remove >/dev/null || true; else echo "[cleanup] no containers to remove"; fi`,
      `docker network rm ${projectName}_default 2>/dev/null && echo "[cleanup] network ${projectName}_default removed" || echo "[cleanup] network ${projectName}_default not present"`,
      `remaining_label=$(docker ps -aq --filter "label=com.docker.compose.project=${projectName}" 2>/dev/null || true)`,
      `remaining_name=$(docker ps -aq --filter "name=^${projectName}-" 2>/dev/null || true)`,
      `if [ -n "$remaining_label" ] || [ -n "$remaining_name" ]; then echo "" >&2; echo "ERROR: containers under project ${projectName} reappeared after removal." >&2; echo "This typically means VS Code's Remote Containers extension is connected to" >&2; echo "this devcontainer and auto-recreated it. Close the dev container session" >&2; echo "in VS Code (Cmd+Shift+P → 'Dev Containers: Close Remote Connection')" >&2; echo "and retry \\\`monoceros apply\\\`." >&2; exit 1; fi`,
      `echo "[cleanup] done"`,
    ].join('; ');
    const cleanupCode = await cleanupSpawn(['-c', script], root);
    if (cleanupCode !== 0) return cleanupCode;

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

async function readRepoEntries(root: string): Promise<RepoEntry[]> {
  const stackPath = path.join(root, '.monoceros', 'stack.json');
  try {
    const content = await fs.readFile(stackPath, 'utf8');
    const stack = JSON.parse(content) as StackFile;
    return stack.repos ?? [];
  } catch {
    return [];
  }
}
