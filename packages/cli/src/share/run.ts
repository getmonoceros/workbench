import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { consola } from 'consola';
import { readLaunchConfig } from '../config/launch-config.js';
import {
  resolveTunnelTarget,
  type ResolveOptions,
  type ResolvedTarget,
} from '../tunnel/resolve.js';
import { preflightLocalPort } from '../tunnel/port-check.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  defaultDockerSpawn,
  installSigintDefault,
  type DockerSpawn,
  type DockerSpawnHandle,
} from '../tunnel/run.js';
import { provisionShareTls, type ProvisionShareTls } from '../tls/ca.js';
import {
  buildCaddyDockerArgs,
  renderCaddyfile,
  type CaddySite,
} from './caddy.js';
import { monocerosHome as defaultMonocerosHome } from '../config/paths.js';
import { cyan, dim } from '../util/format.js';

/**
 * `monoceros share <name> <app>` — expose an app's configured ports to the
 * local network (phone, tablet, any device on the LAN) over HTTPS, reachable
 * by the host's LAN IP / `.local` name. It loops over **every target in the
 * app's launch config that declares a `port`** - not filtered by `default` or
 * by run-state; the launch config is the source of truth. Unlike `tunnel`
 * (raw-TCP socat), the share terminator is a single Caddy sidecar bound to
 * `0.0.0.0`: it terminates TLS with a machine-local CA leaf (ADR 0033) and
 * injects `X-Forwarded-Proto/Host` so scheme-sensitive backends stamp https
 * URLs. Foreground: Ctrl+C tears the forward down, so the LAN exposure lives
 * exactly as long as the command runs. See ADR 0030 and 0033.
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
  /** Injected in tests; defaults to the real CA-backed TLS provisioning. */
  provisionTls?: ProvisionShareTls;
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
  return { ...(ip ? { ip } : {}), mdnsName: mdnsHostName() };
}

/**
 * The host's advertised mDNS name. On macOS `os.hostname()` returns the
 * `HostName` setting, which can diverge from the Bonjour name a phone
 * actually resolves - a name collision on the LAN bumps the advertised name
 * to `<name>-2` while `HostName` stays put. `scutil --get LocalHostName` is
 * the authoritative source there; fall back to `os.hostname()` on other
 * platforms or when scutil is unavailable.
 */
function mdnsHostName(): string {
  if (process.platform === 'darwin') {
    const res = spawnSync('scutil', ['--get', 'LocalHostName'], {
      encoding: 'utf8',
    });
    const name = res.status === 0 ? res.stdout.trim() : '';
    if (name) return `${name}.local`;
  }
  const hn = os.hostname();
  return hn.endsWith('.local') ? hn : `${hn}.local`;
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

  // Issue a leaf cert covering every name/address a device might use, so socat
  // can terminate TLS - HTTP over a LAN IP / `.local` name is an insecure
  // context and kills PKCE + Service Workers (ADR 0033).
  const { ip, mdnsName } = (opts.hostAddresses ?? realHostAddresses)();
  const sans = [mdnsName, ip, 'localhost', '127.0.0.1'].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const provisionTls = opts.provisionTls ?? provisionShareTls;
  const tls = await provisionTls({
    sans,
    ...(opts.monocerosHome !== undefined
      ? { monocerosHome: opts.monocerosHome }
      : {}),
  });

  // One Caddy sidecar terminates TLS for every shared port and injects
  // X-Forwarded-Proto/Host, so scheme-sensitive backends (Keycloak, ...) stamp
  // https URLs matching the browser's origin (ADR 0033).
  const sites: CaddySite[] = ports.map((port) => ({
    port,
    targetHost: base.targetHost,
  }));
  const home = opts.monocerosHome ?? defaultMonocerosHome();
  const shareDir = path.join(home, 'share');
  await fs.mkdir(shareDir, { recursive: true });
  const caddyfilePath = path.join(
    shareDir,
    `${opts.name}__${opts.app}.Caddyfile`,
  );
  // Unlink before writing so each run gets a fresh inode. Docker Desktop
  // caches single-file bind mounts by inode; an in-place overwrite (same
  // inode) can serve the container a stale copy from a previous run, so a
  // changed Caddyfile would silently not take effect.
  await fs.rm(caddyfilePath, { force: true });
  await fs.writeFile(
    caddyfilePath,
    renderCaddyfile(sites, tls.certFile, tls.keyFile),
  );

  const dockerSpawn = opts.dockerSpawn ?? defaultDockerSpawn;
  const handles: DockerSpawnHandle[] = [
    dockerSpawn(
      buildCaddyDockerArgs({
        localAddress: SHARE_ADDRESS,
        ports,
        network: base.network,
        certDir: tls.certDir,
        caddyfilePath,
      }),
    ),
  ];

  const host = mdnsName ?? ip ?? '<host-ip>';
  log.info(
    `Sharing ${opts.name}/${opts.app} on the local network (Ctrl+C to stop):`,
  );
  for (const t of ported) {
    log.info(`  ${cyan(t.name)}  https://${host}:${t.port}`);
  }
  if (mdnsName && ip) {
    log.info(
      dim(
        `  also reachable as https://${ip}:<port> if .local does not resolve`,
      ),
    );
  }
  log.info(
    dim(
      `  First device? Trust the local CA once so HTTPS is warning-free: ${tls.caCertPath}`,
    ),
  );

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
