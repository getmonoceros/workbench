import { spawn, type ChildProcess } from 'node:child_process';
import { consola } from 'consola';
import {
  resolveTunnelTarget,
  type ResolveOptions,
  type ResolvedTarget,
} from './resolve.js';
import { preflightLocalPort } from './port-check.js';

export const SOCAT_IMAGE = 'alpine/socat:1.8.0.3';

export interface RunTunnelOptions {
  name: string;
  target: string;
  localPort?: number;
  localAddress?: string;
  monocerosHome?: string;
  /** Override the docker spawn (tests inject a fake). */
  dockerSpawn?: DockerSpawn;
  /** Override target resolution (tests inject a fake). */
  resolve?: (opts: ResolveOptions) => Promise<ResolvedTarget>;
  /** Override local-port pre-flight (tests inject a fake). */
  preflight?: typeof preflightLocalPort;
  /** Override the SIGINT install — tests skip it so the suite isn't muted. */
  installSignalHandler?: (handler: () => void) => () => void;
  logger?: TunnelLogger;
}

export interface TunnelLogger {
  info: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Spawn `docker run alpine/socat …` in the foreground. Returns the
 * child's exit code (0 on Ctrl+C/clean shutdown, non-zero on error).
 *
 * Why a custom DockerSpawn instead of the proxy/DockerExec used
 * elsewhere: tunnel is a long-running foreground process, not a one-
 * shot inspect. We need stdio: 'inherit' so the user sees socat's
 * own log lines and Ctrl+C reaches docker via the terminal's process
 * group. The DockerExec shape buffers stdout/stderr — wrong shape
 * for this use.
 */
export type DockerSpawn = (args: string[]) => DockerSpawnHandle;

export interface DockerSpawnHandle {
  /** Resolves with the child's exit code after the process exits. */
  exited: Promise<number>;
  /** Forward a signal to the child. No-op if already exited. */
  kill: (signal: NodeJS.Signals) => void;
}

export const defaultDockerSpawn: DockerSpawn = (args) => {
  const child: ChildProcess = spawn('docker', args, {
    stdio: 'inherit',
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (typeof code === 'number') resolve(code);
      else if (signal) resolve(128 + signalNumber(signal));
      else resolve(0);
    });
  });
  return {
    exited,
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        /* already exited */
      }
    },
  };
};

function signalNumber(signal: NodeJS.Signals): number {
  // Sufficient subset — anything else collapses to "1".
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    default:
      return 1;
  }
}

/**
 * Default SIGINT install: swallow the first SIGINT so Node doesn't
 * tear down ahead of the docker child. The terminal's process-group
 * SIGINT still reaches docker run, which catches it and triggers
 * container teardown. We just wait for `exited`.
 */
export const installSigintDefault = (handler: () => void): (() => void) => {
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
};

const DEFAULT_LOCAL_ADDRESS = '127.0.0.1';

export async function runTunnel(opts: RunTunnelOptions): Promise<number> {
  const log: TunnelLogger = opts.logger ?? {
    info: (m) => consola.info(m),
    warn: (m) => consola.warn(m),
  };

  const resolve = opts.resolve ?? resolveTunnelTarget;
  const resolveArgs: ResolveOptions = {
    name: opts.name,
    target: opts.target,
    ...(opts.monocerosHome !== undefined
      ? { monocerosHome: opts.monocerosHome }
      : {}),
  };
  const resolved = await resolve(resolveArgs);

  const localPort = opts.localPort ?? resolved.internalPort;
  const localAddress = opts.localAddress ?? DEFAULT_LOCAL_ADDRESS;
  validateLocalAddress(localAddress);

  const preflight = opts.preflight ?? preflightLocalPort;
  await preflight({ port: localPort, address: localAddress });

  const dockerSpawn = opts.dockerSpawn ?? defaultDockerSpawn;
  const installSignalHandler =
    opts.installSignalHandler ?? installSigintDefault;

  const dockerArgs = buildDockerArgs({
    localAddress,
    localPort,
    internalPort: resolved.internalPort,
    network: resolved.network,
    targetHost: resolved.targetHost,
  });

  log.info(
    `Tunnel: ${localAddress}:${localPort} → ${resolved.display}:${resolved.internalPort} (Ctrl+C to stop)`,
  );

  const handle = dockerSpawn(dockerArgs);
  const uninstall = installSignalHandler(() => {
    // Swallow — let docker run handle the signal via the terminal's
    // process group. We just wait for `exited`.
  });
  try {
    const exitCode = await handle.exited;
    // docker run reports 130 on SIGINT (128 + 2). Treat that as a
    // clean user-initiated stop, not an error.
    if (exitCode === 130) return 0;
    return exitCode;
  } finally {
    uninstall();
  }
}

export interface BuildDockerArgsInput {
  localAddress: string;
  localPort: number;
  internalPort: number;
  network: string;
  targetHost: string;
}

export function buildDockerArgs(input: BuildDockerArgsInput): string[] {
  return [
    'run',
    '--rm',
    '-i',
    `--network=${input.network}`,
    '-p',
    `${input.localAddress}:${input.localPort}:${input.internalPort}`,
    SOCAT_IMAGE,
    `TCP-LISTEN:${input.internalPort},fork,reuseaddr`,
    `TCP:${input.targetHost}:${input.internalPort}`,
  ];
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function validateLocalAddress(addr: string): void {
  // Two common forms we want to accept verbatim: dotted-quad IPv4
  // (including 127.0.0.1 and 0.0.0.0) and the docker-recognised
  // localhost alias. Anything else is rejected — IPv6 isn't supported
  // by the `-p` flag form we emit, and arbitrary hostnames here are
  // a foot-gun (docker won't resolve them for `-p` mappings).
  if (addr === 'localhost') return;
  if (IPV4_RE.test(addr)) {
    for (const part of addr.split('.')) {
      const n = Number(part);
      if (n < 0 || n > 255) {
        throw new Error(
          `Invalid --local-address '${addr}': each dotted-quad octet must be 0-255.`,
        );
      }
    }
    return;
  }
  throw new Error(
    `Invalid --local-address '${addr}'. Use 127.0.0.1 (default), 0.0.0.0, or a specific IPv4 address.`,
  );
}
