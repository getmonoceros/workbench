import os from 'node:os';
import { consola } from 'consola';
import { readLaunchConfig } from '../config/launch-config.js';
import {
  resolveTunnelTarget,
  type ResolveOptions,
  type ResolvedTarget,
} from '../tunnel/resolve.js';
import { preflightLocalPort } from '../tunnel/port-check.js';
import {
  buildDockerArgs,
  defaultDockerSpawn,
  installSigintDefault,
  type DockerSpawn,
  type DockerSpawnHandle,
} from '../tunnel/run.js';
import { cyan, dim } from '../util/format.js';

/**
 * `monoceros share <name> <app>` — expose an app's configured ports to the
 * local network (phone, tablet, any device on the LAN), so they are reachable
 * by the host's LAN IP / `.local` name. Sibling of `tunnel`: same socat-sidecar
 * mechanism, but bound to `0.0.0.0` and looped over **every target in the app's
 * launch config that declares a `port`** - not filtered by `default` or by
 * run-state. The launch config is the source of truth; a forward to a not-yet-
 * started target simply refuses connections until it comes up. Foreground:
 * Ctrl+C tears every forward down, so the LAN exposure lives exactly as long as
 * the command runs. See ADR 0030.
 */

const SHARE_ADDRESS = '0.0.0.0';

export interface RunShareOptions {
  name: string;
  app: string;
  monocerosHome?: string;
  /** Injected in tests. */
  dockerSpawn?: DockerSpawn;
  resolve?: (opts: ResolveOptions) => Promise<ResolvedTarget>;
  preflight?: typeof preflightLocalPort;
  installSignalHandler?: (handler: () => void) => () => void;
  hostAddresses?: () => HostAddresses;
  logger?: ShareLogger;
}

export interface ShareLogger {
  info: (message: string) => void;
  warn?: (message: string) => void;
}

export interface HostAddresses {
  /** First non-internal IPv4, or undefined when offline. */
  ip?: string;
  /** Best-effort mDNS name (`<hostname>.local`). May differ from the real one. */
  mdnsName?: string;
}

/** First non-internal IPv4 + a best-effort `<hostname>.local` for the banner. */
function realHostAddresses(): HostAddresses {
  let ip: string | undefined;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ip = addr.address;
        break;
      }
    }
    if (ip) break;
  }
  const hn = os.hostname();
  const mdnsName = hn.endsWith('.local') ? hn : `${hn}.local`;
  return { ...(ip ? { ip } : {}), mdnsName };
}

export async function runShare(opts: RunShareOptions): Promise<number> {
  const log: ShareLogger = opts.logger ?? {
    info: (m) => consola.info(m),
    warn: (m) => consola.warn(m),
  };

  const cfg = await readLaunchConfig(opts.name, opts.app, opts.monocerosHome);
  if (!cfg) {
    throw new Error(
      `No launch config for '${opts.app}' (expected projects/${opts.app}/.monoceros/launch.json). Nothing to share.`,
    );
  }
  const ported = cfg.configurations.filter(
    (t): t is typeof t & { port: number } => typeof t.port === 'number',
  );
  if (ported.length === 0) {
    throw new Error(
      `No target in '${opts.app}' declares a port, so there is nothing to share. Add a \`port\` to a target in its launch.json.`,
    );
  }
  // One forward per distinct port; the network + target host are identical for
  // every workspace port, so resolve once and reuse.
  const ports = [...new Set(ported.map((t) => t.port))];

  const resolve = opts.resolve ?? resolveTunnelTarget;
  const base = await resolve({
    name: opts.name,
    target: String(ports[0]),
    ...(opts.monocerosHome !== undefined
      ? { monocerosHome: opts.monocerosHome }
      : {}),
  });

  const preflight = opts.preflight ?? preflightLocalPort;
  for (const port of ports) {
    await preflight({ port, address: SHARE_ADDRESS });
  }

  const dockerSpawn = opts.dockerSpawn ?? defaultDockerSpawn;
  const handles: DockerSpawnHandle[] = ports.map((port) =>
    dockerSpawn(
      buildDockerArgs({
        localAddress: SHARE_ADDRESS,
        localPort: port,
        internalPort: port,
        network: base.network,
        targetHost: base.targetHost,
      }),
    ),
  );

  const { ip, mdnsName } = (opts.hostAddresses ?? realHostAddresses)();
  const host = ip ?? mdnsName ?? '<host-ip>';
  log.info(
    `Sharing ${opts.name}/${opts.app} on the local network (Ctrl+C to stop):`,
  );
  for (const t of ported) {
    log.info(`  ${cyan(t.name)}  http://${host}:${t.port}`);
  }
  if (mdnsName && ip) {
    log.info(
      dim(`  also reachable as http://${mdnsName}:<port> where mDNS resolves`),
    );
  }

  const installSignalHandler =
    opts.installSignalHandler ?? installSigintDefault;
  let stopping = false;
  const uninstall = installSignalHandler(() => {
    if (stopping) return;
    stopping = true;
    for (const h of handles) h.kill('SIGTERM');
  });
  try {
    const codes = await Promise.all(handles.map((h) => h.exited));
    // docker run reports 130 on SIGINT (128 + 2); treat that and a clean 0 as
    // a user-initiated stop. Surface any other non-zero as the share's exit.
    const bad = codes.find((c) => c !== 0 && c !== 130);
    return bad ?? 0;
  } finally {
    uninstall();
  }
}
