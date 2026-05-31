import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { createSecretMaskStream } from '../util/mask-secrets.js';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';

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

// Generic shell spawn used by `monoceros apply`/`remove` for label-
// based docker cleanup pipelines. Same ComposeSpawn shape so tests
// can inject a fake; `args[0]` is `-c`, `args[1]` is the shell
// command string. Output goes through the secret masker for the
// same reasons spawnDockerCompose does.
//
// MSYS_NO_PATHCONV + MSYS2_ARG_CONV_EXCL on Windows: bash on
// Windows is usually Git Bash (MSYS2-based), which by default
// rewrites Windows-style paths in args to POSIX form on the way
// to native executables -- so a literal
//   docker ps --filter label=devcontainer.local_folder=c:\Users\foo
// becomes
//   docker ps --filter label=...=/c/Users/foo
// and the docker label match silently misses. Both env vars are
// no-ops on a real Linux bash, so safe to set unconditionally.
export const spawnBash: ComposeSpawn = (args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MSYS_NO_PATHCONV: '1',
        MSYS2_ARG_CONV_EXCL: '*',
      },
    });
    child.stdout?.pipe(createSecretMaskStream()).pipe(process.stdout);
    child.stderr?.pipe(createSecretMaskStream()).pipe(process.stderr);
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
};

/**
 * Normalize a host filesystem path into the form devcontainer-cli
 * stores in the `devcontainer.local_folder` Docker label.
 *
 * On Windows, @devcontainers/cli lowercases the drive letter (e.g.
 * `C:\Users\...` → `c:\Users\...`) before stamping it onto every
 * container it creates. Docker's `--filter label=…=<value>` does an
 * exact byte-for-byte match, so feeding it our untouched
 * `path.join(USERPROFILE, ...)` (which preserves the uppercase
 * drive) silently misses and leaves the container behind on
 * `monoceros remove`.
 *
 * No-op on macOS / Linux: there is no drive letter to lowercase.
 */
export function dockerLocalFolderLabel(p: string): string {
  if (process.platform !== 'win32') return p;
  return p.replace(
    /^([A-Z]):/,
    (_, drive: string) => `${drive.toLowerCase()}:`,
  );
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
  );
}

export interface RunContainerCycleOptions {
  hasCompose: boolean;
  cleanupSpawn?: ComposeSpawn;
  devcontainerSpawn?: DevcontainerSpawn;
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
    const cleanupSpawn = opts.cleanupSpawn ?? spawnBash;
    // Two-step removal so a container with stale/missing labels still
    // gets caught:
    //   - by docker-compose project label
    //   - by container-name prefix `<project>-*`
    // After removal we re-query: if anything remains, VS Code's Remote
    // Containers extension is the likely culprit (auto-recreates on
    // container loss); we abort with a clear hint rather than letting
    // `devcontainer up` collide.
    const script = [
      `set -u`,
      `echo "[cleanup] checking project ${projectName}…"`,
      `by_label=$(docker ps -aq --filter "label=com.docker.compose.project=${projectName}" 2>/dev/null || true)`,
      `by_name=$(docker ps -aq --filter "name=^${projectName}-" 2>/dev/null || true)`,
      `to_remove=$(printf "%s\\n%s\\n" "$by_label" "$by_name" | sort -u | grep -v "^$" || true)`,
      // Unquoted `$to_remove` so bash word-splitting joins the
      // newline-separated IDs with single spaces on echo. A `tr "\n" " "`
      // pipe here used to do the same job but tripped MSYS2's arg
      // translation on Git Bash for Windows ("tr: extra operand").
      `if [ -n "$to_remove" ]; then echo "[cleanup] removing:" $to_remove; docker rm -f $to_remove >/dev/null || true; else echo "[cleanup] no containers to remove"; fi`,
      `docker network rm ${projectName}_default 2>/dev/null && echo "[cleanup] network ${projectName}_default removed" || echo "[cleanup] network ${projectName}_default not present"`,
      `remaining_label=$(docker ps -aq --filter "label=com.docker.compose.project=${projectName}" 2>/dev/null || true)`,
      `remaining_name=$(docker ps -aq --filter "name=^${projectName}-" 2>/dev/null || true)`,
      `if [ -n "$remaining_label" ] || [ -n "$remaining_name" ]; then echo "" >&2; echo "ERROR: containers under project ${projectName} reappeared after removal." >&2; echo "This typically means VS Code's Remote Containers extension is connected to" >&2; echo "this devcontainer and auto-recreated it. Close the dev container session" >&2; echo "in VS Code (Cmd+Shift+P → 'Dev Containers: Close Remote Connection')" >&2; echo "and retry \\\`monoceros apply\\\`." >&2; exit 1; fi`,
      `echo "[cleanup] done"`,
    ].join('; ');
    const cleanupCode = await cleanupSpawn(['-c', script], root);
    if (cleanupCode !== 0) return cleanupCode;

    return runStart({
      root,
      ...(opts.devcontainerSpawn ? { spawn: opts.devcontainerSpawn } : {}),
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
