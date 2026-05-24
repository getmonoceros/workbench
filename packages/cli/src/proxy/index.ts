import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { monocerosHome as defaultMonocerosHome } from '../config/paths.js';

/**
 * Lifecycle of the shared Traefik singleton that fronts every dev-
 * container declaring `ports:` in its yml. See ADR 0007.
 *
 * Two functions externally:
 *
 *   - `ensureProxy()` — idempotent; ensures the `monoceros-proxy`
 *     docker network exists, the `<MONOCEROS_HOME>/traefik/dynamic/`
 *     directory exists (and is user-owned, so subsequent file writes
 *     don't fight a root-mkdir from docker), and a running container
 *     named `monoceros-proxy` is up. Called from `apply`/`start` when
 *     the container's yml declares at least one port.
 *
 *   - `maybeStopProxy()` — counts the non-proxy containers attached to
 *     the `monoceros-proxy` network. Zero ⇒ stop the singleton and
 *     drop the network. Anything else ⇒ no-op. Called from
 *     `stop`/`remove`.
 *
 * Test extension point: every docker invocation runs through the
 * `DockerExec` shape, which `ensureProxy`/`maybeStopProxy` accept as
 * an optional override. Tests inject a fake that records args and
 * returns canned stdout / exit codes.
 */

/** Container name AND network name. Docker namespaces them separately. */
export const PROXY_CONTAINER_NAME = 'monoceros-proxy';
export const PROXY_NETWORK_NAME = 'monoceros-proxy';

/** Traefik release we pin against. Bump deliberately, not floating. */
export const TRAEFIK_IMAGE = 'traefik:v3.3';

export interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DockerExec = (args: string[]) => Promise<DockerResult>;

const realDocker: DockerExec = (args) => {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 0 }),
    );
  });
};

export interface ProxyLogger {
  info: (message: string) => void;
  warn?: (message: string) => void;
}

export interface ProxyOptions {
  /** Override the docker spawn shape (tests inject a fake). */
  docker?: DockerExec;
  /** Override the resolved MONOCEROS_HOME (tests inject a tmpdir). */
  monocerosHome?: string;
  /**
   * Host port Traefik binds. Read from `monoceros-config.yml`'s
   * `routing.hostPort` by callers; the proxy module itself just gets
   * a number and uses it for the `-p` mapping. Defaults to 80 (see
   * `config/global.ts → DEFAULT_PROXY_HOST_PORT`) when omitted.
   */
  hostPort?: number;
  logger?: ProxyLogger;
}

/** `<MONOCEROS_HOME>/traefik/dynamic/` — Traefik file-provider directory. */
export function proxyDynamicDir(home?: string): string {
  return path.join(home ?? defaultMonocerosHome(), 'traefik', 'dynamic');
}

/**
 * Bring the singleton + network up if they aren't already.
 *
 * Steps (all idempotent):
 *   1. mkdir -p on the dynamic-config dir (user-owned).
 *   2. `docker network create monoceros-proxy` if missing.
 *   3. If the container exists but is stopped → `docker start`.
 *      If it doesn't exist → `docker run -d` with the canonical args.
 *      If it's already running → no-op.
 *
 * Throws with a docker-cli-flavored error message on the first
 * failure. Callers that want to soft-fail (e.g. apply continuing
 * without proxy) must catch.
 */
export async function ensureProxy(opts: ProxyOptions = {}): Promise<void> {
  const docker = opts.docker ?? realDocker;
  const dyn = proxyDynamicDir(opts.monocerosHome);
  await fs.mkdir(dyn, { recursive: true });

  // Network. `inspect` exits 1 when missing (no JSON parse needed).
  const netInspect = await docker(['network', 'inspect', PROXY_NETWORK_NAME]);
  if (netInspect.exitCode !== 0) {
    const create = await docker(['network', 'create', PROXY_NETWORK_NAME]);
    if (create.exitCode !== 0) {
      throw new Error(
        `Could not create docker network ${PROXY_NETWORK_NAME}: ${create.stderr.trim() || `exit ${create.exitCode}`}`,
      );
    }
  }

  // Container. The Go-template format is `true`/`false` for the
  // boolean Running flag — easier to compare than parsing JSON.
  const state = await docker([
    'inspect',
    '--format',
    '{{.State.Running}}',
    PROXY_CONTAINER_NAME,
  ]);
  if (state.exitCode === 0) {
    if (state.stdout.trim() === 'true') return; // already up
    const start = await docker(['start', PROXY_CONTAINER_NAME]);
    if (start.exitCode !== 0) {
      throw new Error(
        `Could not start existing ${PROXY_CONTAINER_NAME} container: ${start.stderr.trim() || `exit ${start.exitCode}`}`,
      );
    }
    return;
  }

  // Fresh container. The Traefik args declare a single HTTP entrypoint
  // `web` on :80 and turn on the file provider with watch=true so
  // dynamic-config writes propagate without a Traefik restart. The
  // docker provider is explicitly off — we route via file-provider
  // only, so container labels can't accidentally publish a route.
  // Default 80 — kept as a literal here to avoid a back-reference into
  // config/global.ts. The authoritative value (and the merge logic
  // with `monoceros-config.yml`) lives in config/global.ts.
  const hostPort = opts.hostPort ?? 80;
  const run = await docker([
    'run',
    '-d',
    '--name',
    PROXY_CONTAINER_NAME,
    '--network',
    PROXY_NETWORK_NAME,
    '-p',
    `${hostPort}:80`,
    '-v',
    `${dyn}:/etc/traefik/dynamic:ro`,
    '--label',
    'monoceros.role=proxy',
    TRAEFIK_IMAGE,
    '--entrypoints.web.address=:80',
    '--providers.file.directory=/etc/traefik/dynamic',
    '--providers.file.watch=true',
    '--providers.docker=false',
    '--api.dashboard=false',
    '--log.level=INFO',
  ]);
  if (run.exitCode !== 0) {
    throw new Error(
      `Could not start ${PROXY_CONTAINER_NAME}: ${run.stderr.trim() || `exit ${run.exitCode}`}`,
    );
  }
  opts.logger?.info(
    `Started ${PROXY_CONTAINER_NAME} (Traefik on :${hostPort}).`,
  );
}

/**
 * Stop and drop the singleton + network IFF no other container is
 * still attached. Safe to call from any lifecycle exit (`stop`,
 * `remove`, last `remove-port`). No-ops gracefully when:
 *
 *   - the network doesn't exist (nothing to do)
 *   - another devcontainer is still attached
 *   - the container is already gone
 */
export async function maybeStopProxy(opts: ProxyOptions = {}): Promise<void> {
  const docker = opts.docker ?? realDocker;
  const logger = opts.logger;

  // Names of every container attached to the network. The Go-template
  // is one name per line. Empty stdout (or just newlines) means no
  // container at all is in the network.
  const inspect = await docker([
    'network',
    'inspect',
    PROXY_NETWORK_NAME,
    '--format',
    '{{range $k, $v := .Containers}}{{$v.Name}}\n{{end}}',
  ]);
  if (inspect.exitCode !== 0) {
    // Network is gone or daemon unreachable — nothing to clean up.
    return;
  }
  const others = inspect.stdout
    .split('\n')
    .map((n) => n.trim())
    .filter((n) => n.length > 0 && n !== PROXY_CONTAINER_NAME);
  if (others.length > 0) return; // other consumers still depend on it

  // Stop+rm the singleton. `rm -f` does both even if it's still up,
  // and shrugs at a missing container, which makes the call resilient
  // to manual `docker rm` from outside Monoceros.
  await docker(['rm', '-f', PROXY_CONTAINER_NAME]);

  // Drop the network. `network rm` errors when other containers are
  // still attached — we already filtered for that, so a non-zero exit
  // here is genuinely something else (e.g. permission denied). We log
  // the warn but don't throw; the next ensureProxy() recreates anyway.
  const netRm = await docker(['network', 'rm', PROXY_NETWORK_NAME]);
  if (netRm.exitCode !== 0) {
    logger?.warn?.(
      `Could not remove docker network ${PROXY_NETWORK_NAME}: ${netRm.stderr.trim() || `exit ${netRm.exitCode}`}`,
    );
    return;
  }
  logger?.info(
    `Stopped ${PROXY_CONTAINER_NAME} (no dev-containers with ports left).`,
  );
}
