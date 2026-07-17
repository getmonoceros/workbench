import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { consola } from 'consola';
import { type DockerExec } from '../proxy/index.js';
import { createSecretMaskStream } from '../util/mask-secrets.js';
import { DEFERRED_SERVICE_PROFILE } from '../create/catalog.js';
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

// A `docker compose` spawn that routes the (secret-masked) output to a
// log sink, and to the screen only when not silent. Used for the deferred
// second wave (ADR 0025): in the apply spinner UI its raw container/pull
// lines would litter the screen after "container ready" — they belong in
// the log file, like the main devcontainer-cli stream (ADR 0013). In
// verbose mode (no spinner) silent is false, so it streams live as usual.
function spawnDockerComposeTo(opts: {
  logSink?: NodeJS.WritableStream;
  silent?: boolean;
}): ComposeSpawn {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn('docker', ['compose', ...args], {
        cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
      });
      const route = (
        src: NodeJS.ReadableStream | null,
        screen: NodeJS.WriteStream,
      ): void => {
        if (!src) return;
        src.pipe(createSecretMaskStream()).on('data', (chunk: Buffer) => {
          opts.logSink?.write(chunk);
          if (!opts.silent) screen.write(chunk);
        });
      };
      route(child.stdout, process.stdout);
      route(child.stderr, process.stderr);
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 0));
    });
}

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

/**
 * True when the devcontainer workspace rooted at `root` has a RUNNING
 * container. The devcontainer CLI labels the workspace container with
 * `devcontainer.local_folder=<workspace path>`; we query running containers
 * (no `-a`) carrying that label. Used by global `monoceros upgrade` to refresh
 * only live containers — never to start a stopped one or materialize a config
 * that was only `init`-ed.
 */
export async function isWorkspaceRunning(
  root: string,
  exec: DockerExec = spawnDocker,
): Promise<boolean> {
  const result = await exec([
    'ps',
    '-q',
    '--filter',
    `label=devcontainer.local_folder=${root}`,
  ]);
  return result.exitCode === 0 && result.stdout.trim().length > 0;
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
// compose-mode devcontainer up: it lowercases `<root-basename>_devcontainer`
// and strips characters outside [a-z0-9_-] (docker compose rejects
// project names with uppercase letters). Aligning here means `monoceros
// start/stop/status/logs` and the implicit `devcontainer up` from
// `monoceros run/shell` act on the same compose project — without the
// same normalization an uppercase container name (e.g. `FFC`) yields
// `FFC_devcontainer` here while the CLI brings the stack up as
// `ffc_devcontainer`, so docker rejects our `-p` (deferred services
// fail to start) and creates a second parallel stack.
export function composeProjectName(root: string): string {
  return `${path.basename(root)}_devcontainer`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

/**
 * Resolve compose-mode metadata for the container rooted at `root`.
 * `root` is `<MONOCEROS_HOME>/container/<name>/` and must already
 * exist with a `.devcontainer/compose.yaml` inside. The compose-only
 * lifecycle commands (`start/stop/status/logs/down`) error when the
 * file is missing.
 */
/** Throw unless the container has been materialized (`apply` ran). */
export function assertDevcontainer(root: string): void {
  if (!existsSync(path.join(root, '.devcontainer'))) {
    throw new Error(
      `No .devcontainer/ at ${root}. Run \`monoceros apply <name>\` first.`,
    );
  }
}

/**
 * Whether the container is compose-mode (has services). Image-mode
 * containers have no `compose.yaml`; `start`/`stop`/`status` handle both,
 * but `logs` is compose-only (a bare container's main process is just the
 * keep-alive). See ADR 0022 for why image-mode lifecycle is now wired.
 */
export function isComposeMode(root: string): boolean {
  return existsSync(path.join(root, '.devcontainer', 'compose.yaml'));
}

export function resolveCompose(root: string): ResolvedCompose {
  assertDevcontainer(root);
  const composeFile = path.join(root, '.devcontainer', 'compose.yaml');
  if (!existsSync(composeFile)) {
    throw new Error(
      `No compose.yaml at ${composeFile}. \`monoceros logs\` tails compose service logs, which require services configured via \`monoceros add-service <name> <svc>\`. For a bare container, use \`monoceros shell <name>\` or read logs/<app>.log.`,
    );
  }
  return { composeFile, projectName: composeProjectName(root) };
}

export interface ComposeActionOptions {
  root: string;
  service?: string;
  spawn?: ComposeSpawn;
  /** Plain `docker` exec for the image-mode path (no compose.yaml). Tests inject. */
  dockerExec?: DockerExec;
  logger?: { info: (message: string) => void };
}

async function runComposeAction(
  buildSubArgs: (service: string | undefined) => string[],
  opts: ComposeActionOptions,
): Promise<number> {
  const { composeFile, projectName } = resolveCompose(opts.root);
  const spawnFn = opts.spawn ?? spawnDockerCompose;
  const subArgs = buildSubArgs(opts.service);
  // Activate the deferred-service profile so `stop`/`ps`/`logs` see the
  // services that were brought up in the second wave (ADR 0025).
  // docker compose ignores profile-gated services unless the profile is
  // active, so without this a deferred keycloak keeps running through
  // `monoceros stop` and never shows up in `status`/`logs`.
  return spawnFn(
    [
      '-f',
      composeFile,
      '-p',
      projectName,
      '--profile',
      DEFERRED_SERVICE_PROFILE,
      ...subArgs,
    ],
    opts.root,
  );
}

export interface DeferredStartOptions {
  root: string;
  /** Service names to bring up in the second wave (ADR 0025). */
  services: string[];
  spawn?: ComposeSpawn;
  /** Tee the compose output here (the apply log). */
  logSink?: NodeJS.WritableStream;
  /** Keep the compose output off the screen (spinner mode); it still goes to logSink. */
  silent?: boolean;
  logger?: { info: (message: string) => void };
}

/**
 * Bring up services that were deliberately left out of the initial
 * `devcontainer up` (ADR 0025) — the "second wave". Runs host-side AFTER
 * `devcontainer up` has returned, i.e. after post-create (the repo clone)
 * has finished, so a service that bind-mounts a cloned repo file finds it
 * present at boot. The services are named explicitly so the already-running
 * workspace container is untouched; `up -d` is a no-op for anything already
 * up. A no-op (returns 0) when there are no deferred services.
 */
export async function startDeferredServices(
  opts: DeferredStartOptions,
): Promise<number> {
  if (opts.services.length === 0) return 0;
  const { composeFile, projectName } = resolveCompose(opts.root);
  // Route the raw container/pull lines to the log (off-screen in spinner
  // mode); the one status line below is all the screen needs. A test-
  // injected spawn wins (and ignores the sink).
  const spawnFn =
    opts.spawn ??
    spawnDockerComposeTo({
      ...(opts.logSink ? { logSink: opts.logSink } : {}),
      ...(opts.silent ? { silent: true } : {}),
    });
  opts.logger?.info(
    `Starting deferred service(s): ${opts.services.join(', ')}…`,
  );
  // `--profile`: the deferred services carry the DEFERRED_SERVICE_PROFILE
  // in compose.yaml so `devcontainer up`'s profile-less `up` skipped them;
  // we activate that profile here to bring them up. `--quiet-pull`: a first
  // apply pulls the service image here, and the per-layer download progress
  // (hundreds of lines) would flood the terminal AFTER the main spinner has
  // already finished — the flag keeps the summary lines and drops the noise.
  return spawnFn(
    [
      '-f',
      composeFile,
      '-p',
      projectName,
      '--profile',
      DEFERRED_SERVICE_PROFILE,
      'up',
      '-d',
      '--quiet-pull',
      ...opts.services,
    ],
    opts.root,
  );
}

export interface StartOptions {
  root: string;
  spawn?: DevcontainerSpawn;
  /**
   * Pass `--build-no-cache` to `devcontainer up` so feature install layers
   * rebuild from scratch and re-pull their latest tools (ADR 0018, used by
   * `monoceros upgrade`). Only takes effect when the container is (re)created,
   * which the apply cycle ensures via prior teardown / `--remove-existing-container`.
   */
  noCache?: boolean;
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
  /**
   * Forwarded to {@link DevcontainerSpawnOptions.quiet}: buffer the
   * `devcontainer up` output and flush it to stderr only on a non-zero
   * exit. Used by `monoceros start`, which wants a clean status line on
   * success but must NOT swallow the error when the `up` fails.
   */
  quiet?: boolean;
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
  // `devcontainer up` handles both image- and compose-mode, so `start`
  // works for either - it only needs a materialized container (ADR 0022).
  assertDevcontainer(opts.root);
  const logger = opts.logger ?? { info: (msg) => consola.info(msg) };
  const spawnFn = opts.spawn ?? spawnDevcontainer;
  logger.info(`Bringing devcontainer up at ${opts.root}…`);
  return spawnFn(
    [
      'up',
      '--workspace-folder',
      opts.root,
      '--mount-workspace-git-root=false',
      ...(opts.noCache ? ['--build-no-cache'] : []),
    ],
    opts.root,
    buildSpawnOptions(opts),
  );
}

function buildSpawnOptions(
  opts: Pick<StartOptions, 'logSink' | 'progressSink' | 'silent' | 'quiet'>,
): DevcontainerSpawnOptionsForwarded | undefined {
  const out: DevcontainerSpawnOptionsForwarded = {};
  if (opts.logSink) out.logSink = opts.logSink;
  if (opts.progressSink) out.progressSink = opts.progressSink;
  if (opts.silent) out.silent = true;
  if (opts.quiet) out.quiet = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

interface DevcontainerSpawnOptionsForwarded {
  logSink?: NodeJS.WritableStream;
  progressSink?: NodeJS.WritableStream;
  silent?: boolean;
  quiet?: boolean;
}

export interface RunContainerCycleOptions {
  hasCompose: boolean;
  /** Rebuild feature layers from scratch (`--build-no-cache`). See ADR 0018. */
  noCache?: boolean;
  /** Override the bind-source-retry delay (ms). Test seam; default 500. */
  bindRetryDelayMs?: number;
  /**
   * Image used to "nudge" Docker Desktop's VirtioFS into exposing freshly
   * created bind sources when an `up` hits "bind source path does not exist"
   * (typically the resolved runtime image, already pulled). When unset, the
   * retry still happens but without the nudge.
   */
  prewarmImage?: string;
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

// Docker Desktop on macOS (VirtioFS) does not always make a just-created
// host directory/file visible to the VM immediately, so a bind mount whose
// source we created moments earlier in the scaffold can fail with
// "bind source path does not exist" even though the path is on disk — and it
// stays stuck (observed >90s) until the VM *touches* the path through a parent
// mount. So on this error (and nothing else) we run a one-shot "nudge" that
// mounts the workspace root and stats `home/` (forcing VirtioFS to expose the
// nested bind sources), then retry the `up`. A non-bind failure returns
// immediately — we never mask or retry a real error.
const BIND_SOURCE_MISSING_RE = /bind source path does not exist/i;
const BIND_RETRY_ATTEMPTS = 3;
const BIND_RETRY_DELAY_MS = 500;

interface BindRetryOptions {
  /** Delay after the nudge before retrying (ms). Test seam. */
  delayMs?: number;
  /** Nudge VirtioFS to expose the freshly-created bind sources. */
  onBindRetry?: () => Promise<void>;
}

/**
 * Run a single `up` attempt (via `attempt`), capturing its output to detect
 * the VirtioFS "bind source path does not exist" race; on that error run the
 * nudge and retry, a few times. `attempt` receives a sink to use as the up's
 * logSink; we tee it to `baseSink` (the real apply log) so the transcript is
 * unaffected.
 */
async function runUpWithBindRetry(
  attempt: (logSink: NodeJS.WritableStream) => Promise<number>,
  baseSink: NodeJS.WritableStream | undefined,
  logger: { info: (m: string) => void },
  opts: BindRetryOptions = {},
): Promise<number> {
  const delayMs = opts.delayMs ?? BIND_RETRY_DELAY_MS;
  let code = 0;
  for (let i = 1; i <= BIND_RETRY_ATTEMPTS; i += 1) {
    let captured = '';
    const sink = new Writable({
      write(chunk, _enc, cb) {
        captured += chunk.toString();
        if (baseSink) baseSink.write(chunk);
        cb();
      },
    });
    code = await attempt(sink);
    if (code === 0) return 0;
    if (i < BIND_RETRY_ATTEMPTS && BIND_SOURCE_MISSING_RE.test(captured)) {
      logger.info(
        `Bind source not visible yet (Docker Desktop file sync); nudging + retrying… (${i}/${BIND_RETRY_ATTEMPTS - 1})`,
      );
      if (opts.onBindRetry) {
        try {
          await opts.onBindRetry();
        } catch {
          // nudge is best-effort
        }
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    return code;
  }
  return code;
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
  const exec = opts.dockerExec ?? spawnDocker;

  // VirtioFS nudge: mount the workspace root and stat `home/` so the VM
  // exposes the nested home bind sources (see runUpWithBindRetry). `sh`
  // entrypoint to bypass the runtime image's own entrypoint; best-effort.
  const onBindRetry = opts.prewarmImage
    ? async (): Promise<void> => {
        await exec([
          'run',
          '--rm',
          '--entrypoint',
          'sh',
          '--mount',
          `source=${root},target=/w,type=bind`,
          opts.prewarmImage as string,
          '-lc',
          'ls -laR /w/home >/dev/null 2>&1 || true',
        ]);
      }
    : undefined;
  const bindRetry: BindRetryOptions = {
    ...(opts.bindRetryDelayMs !== undefined
      ? { delayMs: opts.bindRetryDelayMs }
      : {}),
    ...(onBindRetry ? { onBindRetry } : {}),
  };

  if (hasCompose) {
    const projectName = composeProjectName(root);
    logger.info(
      `Force-removing existing ${projectName} containers (volumes preserved)…`,
    );
    // Removal filters so a container with stale/missing labels still
    // gets caught:
    //   - by docker-compose project label
    //   - by container-name prefix `<project>-*`
    //   - by the fixed `container_name: monoceros-<name>` the scaffold
    //     pins. This last one is the mode-independent identity: image
    //     mode creates the workspace via `docker run --name=monoceros-<name>`
    //     (no compose project label), compose mode via `container_name:
    //     monoceros-<name>` (which docker does NOT prefix with the
    //     project). So when a container is re-applied AFTER its first
    //     service is added — flipping image-mode → compose-mode — the old
    //     image-mode container carries neither the project label nor the
    //     `<project>-` prefix, survives the first two filters, and then
    //     collides with the new one on the unique fixed name. Anchored so
    //     `monoceros-acme` doesn't also sweep `monoceros-acme2`.
    // After removal we re-query: if anything remains, VS Code's Remote
    // Containers extension is the likely culprit (auto-recreates on
    // container loss); we abort with a clear hint rather than letting
    // `devcontainer up` collide.
    const filters = [
      `label=com.docker.compose.project=${projectName}`,
      `name=^${projectName}-`,
      `name=^monoceros-${path.basename(root)}$`,
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

    return runUpWithBindRetry(
      (logSink) =>
        runStart({
          root,
          ...(opts.devcontainerSpawn ? { spawn: opts.devcontainerSpawn } : {}),
          logSink,
          ...(opts.progressSink ? { progressSink: opts.progressSink } : {}),
          ...(opts.silent ? { silent: true } : {}),
          ...(opts.noCache ? { noCache: true } : {}),
          logger,
        }),
      opts.logSink,
      logger,
      bindRetry,
    );
  }

  logger.info(`Recreating image-mode devcontainer at ${root}…`);
  const spawnFn = opts.devcontainerSpawn ?? spawnDevcontainer;
  return runUpWithBindRetry(
    (logSink) =>
      spawnFn(
        [
          'up',
          '--workspace-folder',
          root,
          '--mount-workspace-git-root=false',
          '--remove-existing-container',
          ...(opts.noCache ? ['--build-no-cache'] : []),
        ],
        root,
        {
          logSink,
          ...(opts.progressSink ? { progressSink: opts.progressSink } : {}),
          ...(opts.silent ? { silent: true } : {}),
        },
      ),
    opts.logSink,
    logger,
    bindRetry,
  );
}

export function runStop(opts: ComposeActionOptions): Promise<number> {
  assertDevcontainer(opts.root);
  if (isComposeMode(opts.root)) {
    return runComposeAction(
      (service) => ['stop', ...(service ? [service] : [])],
      opts,
    );
  }
  return stopImageContainer(opts);
}

export function runStatus(opts: ComposeActionOptions): Promise<number> {
  assertDevcontainer(opts.root);
  if (isComposeMode(opts.root)) {
    return runComposeAction(
      (service) => ['ps', ...(service ? [service] : [])],
      opts,
    );
  }
  return statusImageContainer(opts);
}

// ─── Image-mode lifecycle (no compose.yaml) ──────────────────────────
// The single dev container is found by the `devcontainer.local_folder`
// label devcontainer-cli stamps at `up` time (the same handle `shell`
// and `remove` use). `stop` halts it; `status` reports its state.

function imageContainerFilter(root: string): string {
  return `label=devcontainer.local_folder=${root}`;
}

async function stopImageContainer(opts: ComposeActionOptions): Promise<number> {
  const exec = opts.dockerExec ?? spawnDocker;
  const logger = opts.logger ?? { info: (msg) => consola.info(msg) };
  const name = path.basename(opts.root);
  const ps = await exec([
    'ps',
    '-q',
    '--filter',
    imageContainerFilter(opts.root),
    '--filter',
    'status=running',
  ]);
  const id = ps.stdout
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!id) {
    logger.info(`Container '${name}' is not running.`);
    return 0;
  }
  const res = await exec(['stop', id]);
  if (res.exitCode === 0) logger.info(`Stopped '${name}'.`);
  return res.exitCode;
}

async function statusImageContainer(
  opts: ComposeActionOptions,
): Promise<number> {
  const exec = opts.dockerExec ?? spawnDocker;
  const logger = opts.logger ?? { info: (msg) => consola.info(msg) };
  const name = path.basename(opts.root);
  // Plain `docker ps -a` (no --format) renders docker's default table with
  // a header (CONTAINER ID / IMAGE / STATUS / PORTS / NAMES), comparable to
  // `docker compose ps`. The NAMES column shows `monoceros-<name>`.
  const res = await exec([
    'ps',
    '-a',
    '--filter',
    imageContainerFilter(opts.root),
  ]);
  // The default table always emits a header row; a single line (or none)
  // means no matching container.
  const rows = res.stdout.split('\n').filter((l) => l.trim().length > 0);
  if (rows.length <= 1) {
    logger.info(
      `Container '${name}' does not exist. Run \`monoceros apply ${name}\`.`,
    );
    return 0;
  }
  process.stdout.write(
    res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`,
  );
  return res.exitCode;
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
