import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { type DockerExec } from '../proxy/index.js';
import { createSecretMaskStream } from '../util/mask-secrets.js';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';

export { type DockerExec, type DockerResult } from '../proxy/index.js';

export type ComposeSpawn = (args: string[], cwd: string) => Promise<number>;

// Default spawn: shells out to `docker compose` (the v2 docker
// subcommand). Stdout/stderr are streamed through a secret masker
// (see util/mask-secrets.ts) so feature option dumps, ENV-printouts
// and similar do not leak Atlassian/GitHub/Anthropic tokens onto
// the host terminal.
export const spawnDockerCompose: ComposeSpawn = (args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', ...args], {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(createSecretMaskStream()).pipe(process.stdout);
    child.stderr?.pipe(createSecretMaskStream()).pipe(process.stderr);
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
};

// Direct invocation of `docker <args>` with no shell wrapper.
// BOTH stdout and stderr are buffered, never live-streamed: the
// cleanup pipeline routinely runs docker calls that are expected to
// fail (e.g. `docker network rm <name>` for image-mode containers
// that never had a project network — "network not found" is the
// happy path). Live streaming would leak that noise to the user.
// Callers print buffered stderr on the failure paths they actually
// care about.
//
// Why no bash. The old cleanup path piped a script through
// `bash -c <script>` which on Windows is typically WSL's bash via
// the C:\Users\…\WindowsApps\bash.exe launcher. Quoting a label
// value with backslashes (`c:\Users\…\.monoceros\…`) survives PS,
// CreateProcess, WSL launcher, and bash's own parser only to come
// out the other end mangled when handed to docker, and the label
// filter then silently matches nothing. Going through Node spawn
// directly removes every one of those layers.
//
// Shape matches `DockerExec` re-exported above (originally from
// proxy/index.ts) so tests can swap in the same fake across both the
// proxy lifecycle and the cleanup pipelines.
export const spawnDocker: DockerExec = (args) => {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      resolve({ exitCode: code ?? 0, stdout, stderr }),
    );
  });
};

/**
 * Collect container IDs matching ANY of the given docker `--filter`
 * values, deduplicated. Tolerates per-filter failures (treats them as
 * empty) so a malformed/unsupported filter doesn't take the whole
 * cleanup down.
 *
 * Each `filter` is the literal value passed after `--filter`, e.g.
 * `label=com.docker.compose.project=foo` or `name=^foo-`.
 */
export async function findContainerIds(
  filters: readonly string[],
  exec: DockerExec = spawnDocker,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const filter of filters) {
    const result = await exec(['ps', '-aq', '--filter', filter]);
    if (result.exitCode !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/)) {
      const id = line.trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export interface CleanupDockerObjectsOptions {
  /** Display name in log lines (`[cleanup] tearing down docker project <projectName>…`). */
  projectName: string;
  /** Docker `--filter` values; containers matching ANY are removed. */
  filters: readonly string[];
  /** Optional network name to `docker network rm` after container removal. Failure is ignored (network may not exist). */
  network?: string;
  /** `[cleanup] …` prefix on log lines. Defaults to `cleanup`; `remove/index.ts` uses `remove` to match the existing on-screen tag. */
  logTag?: string;
  logger: { info: (message: string) => void };
  exec?: DockerExec;
}

export interface CleanupDockerObjectsResult {
  exitCode: number;
  removedIds: string[];
}

/**
 * Replacement for the previous `bash -c '…'` cleanup script in
 * `remove` and the apply pre-cleanup. Drives docker directly via
 * Node spawn (`spawnDocker`) so backslash-bearing Windows label
 * values reach docker unmangled.
 *
 * `exitCode` is 0 unless `docker rm -f` itself returned non-zero;
 * per-filter `docker ps` failures are tolerated silently. Use
 * {@link findContainerIds} afterwards if you need to verify the
 * tear-down actually emptied the project.
 */
export async function cleanupDockerObjects(
  opts: CleanupDockerObjectsOptions,
): Promise<CleanupDockerObjectsResult> {
  const exec = opts.exec ?? spawnDocker;
  const tag = opts.logTag ?? 'cleanup';
  opts.logger.info(`[${tag}] tearing down docker project ${opts.projectName}…`);

  const ids = await findContainerIds(opts.filters, exec);

  let rmExit = 0;
  if (ids.length > 0) {
    opts.logger.info(`[${tag}] removing containers: ${ids.join(' ')}`);
    const rmResult = await exec(['rm', '-f', ...ids]);
    rmExit = rmResult.exitCode;
    if (rmExit !== 0 && rmResult.stderr.trim()) {
      // Real failure path — surface what docker said so the builder
      // doesn't see a bare non-zero exit with no explanation.
      opts.logger.info(`[${tag}] ${rmResult.stderr.trim()}`);
    }
  } else {
    opts.logger.info(`[${tag}] no containers found`);
  }

  if (opts.network) {
    const netResult = await exec(['network', 'rm', opts.network]);
    if (netResult.exitCode === 0) {
      opts.logger.info(`[${tag}] network ${opts.network} removed`);
    }
    // Otherwise: silent. The common failure here is "network not
    // found" because image-mode devcontainers (no compose) never
    // created one — expected, not actionable, kept the bash version
    // quiet with `2>/dev/null`. A real docker error (daemon down)
    // already showed up on the earlier ps/rm calls.
  }

  opts.logger.info(`[${tag}] docker cleanup done`);
  return { exitCode: rmExit, removedIds: ids };
}

interface ResolvedCompose {
  composeFile: string;
  projectName: string;
}

// Match the project name `@devcontainers/cli` derives when it brings a
// compose-mode devcontainer up: `<root-basename>_devcontainer`.
// Aligning here means `monoceros start/stop/status/logs` and the
// implicit `devcontainer up` from `monoceros run/shell` act on the
// same compose project — without it docker would create two parallel
// stacks.
export function composeProjectName(root: string): string {
  return `${path.basename(root)}_devcontainer`;
}

/**
 * Resolve compose-mode metadata for the container rooted at `root`.
 * `root` is `<MONOCEROS_HOME>/container/<name>/` and must already
 * exist with a `.devcontainer/compose.yaml` inside. The compose-only
 * lifecycle commands (`start/stop/status/logs/down`) error when the
 * file is missing.
 */
export function resolveCompose(root: string): ResolvedCompose {
  if (!existsSync(path.join(root, '.devcontainer'))) {
    throw new Error(
      `No .devcontainer/ at ${root}. Run \`monoceros apply <name>\` first.`,
    );
  }
  const composeFile = path.join(root, '.devcontainer', 'compose.yaml');
  if (!existsSync(composeFile)) {
    throw new Error(
      `No compose.yaml at ${composeFile}. \`start\` / \`stop\` / \`status\` / \`logs\` require services configured via \`monoceros add-service <name> <svc>\`. Use \`monoceros shell <name>\` to enter the container directly.`,
    );
  }
  return { composeFile, projectName: composeProjectName(root) };
}

export interface ComposeActionOptions {
  root: string;
  service?: string;
  spawn?: ComposeSpawn;
}

async function runComposeAction(
  buildSubArgs: (service: string | undefined) => string[],
  opts: ComposeActionOptions,
): Promise<number> {
  const { composeFile, projectName } = resolveCompose(opts.root);
  const spawnFn = opts.spawn ?? spawnDockerCompose;
  const subArgs = buildSubArgs(opts.service);
  return spawnFn(['-f', composeFile, '-p', projectName, ...subArgs], opts.root);
}

export interface StartOptions {
  root: string;
  spawn?: DevcontainerSpawn;
  logger?: { info: (message: string) => void };
  /**
   * Forwarded to {@link DevcontainerSpawnOptions.logSink}. See ADR 0013
   * and apply/apply-log.ts.
   */
  logSink?: NodeJS.WritableStream;
  /** Forwarded to {@link DevcontainerSpawnOptions.progressSink}. */
  progressSink?: NodeJS.WritableStream;
  /** Forwarded to {@link DevcontainerSpawnOptions.silent}. */
  silent?: boolean;
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
export async function runStart(opts: StartOptions): Promise<number> {
  resolveCompose(opts.root); // throws if no compose.yaml
  const logger = opts.logger ?? { info: (msg) => consola.info(msg) };
  const spawnFn = opts.spawn ?? spawnDevcontainer;
  logger.info(`Bringing devcontainer up at ${opts.root}…`);
  return spawnFn(
    ['up', '--workspace-folder', opts.root, '--mount-workspace-git-root=false'],
    opts.root,
    buildSpawnOptions(opts),
  );
}

function buildSpawnOptions(
  opts: Pick<StartOptions, 'logSink' | 'progressSink' | 'silent'>,
): DevcontainerSpawnOptionsForwarded | undefined {
  const out: DevcontainerSpawnOptionsForwarded = {};
  if (opts.logSink) out.logSink = opts.logSink;
  if (opts.progressSink) out.progressSink = opts.progressSink;
  if (opts.silent) out.silent = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

interface DevcontainerSpawnOptionsForwarded {
  logSink?: NodeJS.WritableStream;
  progressSink?: NodeJS.WritableStream;
  silent?: boolean;
}

export interface RunContainerCycleOptions {
  hasCompose: boolean;
  /**
   * Inject a fake docker exec for tests. Replaces the previous
   * `cleanupSpawn: ComposeSpawn` which fed a bash script to
   * `bash -c`; we now drive docker directly via Node spawn, so the
   * shell layer (and its Windows quoting failures) is out of the
   * picture.
   */
  dockerExec?: DockerExec;
  devcontainerSpawn?: DevcontainerSpawn;
  /**
   * Forwarded to the underlying `spawnDevcontainer` as
   * {@link DevcontainerSpawnOptions.logSink}. See ADR 0013.
   */
  logSink?: NodeJS.WritableStream;
  /** Forwarded to {@link DevcontainerSpawnOptions.progressSink}. */
  progressSink?: NodeJS.WritableStream;
  /** Forwarded to {@link DevcontainerSpawnOptions.silent}. */
  silent?: boolean;
  logger: {
    info: (message: string) => void;
    warn?: (message: string) => void;
  };
}

/**
 * Container teardown + up for a devcontainer rooted at `root`.
 * Used by `runApply` (apply/index.ts) after writing the scaffold.
 */
export async function runContainerCycle(
  root: string,
  opts: RunContainerCycleOptions,
): Promise<number> {
  const { hasCompose, logger } = opts;

  if (hasCompose) {
    const projectName = composeProjectName(root);
    logger.info(
      `Force-removing existing ${projectName} containers (volumes preserved)…`,
    );
    // Two-step removal so a container with stale/missing labels still
    // gets caught:
    //   - by docker-compose project label
    //   - by container-name prefix `<project>-*`
    // After removal we re-query: if anything remains, VS Code's Remote
    // Containers extension is the likely culprit (auto-recreates on
    // container loss); we abort with a clear hint rather than letting
    // `devcontainer up` collide.
    const exec = opts.dockerExec ?? spawnDocker;
    const filters = [
      `label=com.docker.compose.project=${projectName}`,
      `name=^${projectName}-`,
    ];
    const { exitCode: rmExit } = await cleanupDockerObjects({
      projectName,
      filters,
      network: `${projectName}_default`,
      logger,
      exec,
    });
    if (rmExit !== 0) return rmExit;

    const remaining = await findContainerIds(filters, exec);
    if (remaining.length > 0) {
      const warn = logger.warn ?? logger.info;
      warn(
        `ERROR: containers under project ${projectName} reappeared after removal.\n` +
          `This typically means VS Code's Remote Containers extension is connected\n` +
          `to this devcontainer and auto-recreated it. Close the dev container\n` +
          `session in VS Code (Cmd+Shift+P → 'Dev Containers: Close Remote Connection')\n` +
          `and retry \`monoceros apply\`.`,
      );
      return 1;
    }

    return runStart({
      root,
      ...(opts.devcontainerSpawn ? { spawn: opts.devcontainerSpawn } : {}),
      ...(opts.logSink ? { logSink: opts.logSink } : {}),
      ...(opts.progressSink ? { progressSink: opts.progressSink } : {}),
      ...(opts.silent ? { silent: true } : {}),
      logger,
    });
  }

  logger.info(`Recreating image-mode devcontainer at ${root}…`);
  const spawnFn = opts.devcontainerSpawn ?? spawnDevcontainer;
  return spawnFn(
    [
      'up',
      '--workspace-folder',
      root,
      '--mount-workspace-git-root=false',
      '--remove-existing-container',
    ],
    root,
    buildSpawnOptions(opts),
  );
}

export function runStop(opts: ComposeActionOptions): Promise<number> {
  return runComposeAction(
    (service) => ['stop', ...(service ? [service] : [])],
    opts,
  );
}

export function runStatus(opts: ComposeActionOptions): Promise<number> {
  return runComposeAction(
    (service) => ['ps', ...(service ? [service] : [])],
    opts,
  );
}

export interface LogsOptions extends ComposeActionOptions {
  follow?: boolean;
}

export function runLogs(opts: LogsOptions): Promise<number> {
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
