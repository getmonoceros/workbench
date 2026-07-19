import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { consola } from 'consola';
import { readLaunchConfig } from '../config/launch-config.js';
import {
  resolveTunnelTarget,
  type ResolveOptions,
  type ResolvedTarget,
} from '../tunnel/resolve.js';
import { realPortProbe, type PortProbe } from '../tunnel/port-check.js';
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
  CADDY_IMAGE,
  type CaddySite,
} from './caddy.js';
import { monocerosHome as defaultMonocerosHome } from '../config/paths.js';
import {
  isWsl,
  resolveWindowsLanIp,
  resolveWindowsProfile,
} from '../devcontainer/ssh-attach.js';
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

/**
 * A `--forward-ports` remap: publish the container port under a different host
 * port. Docker `-p` order (`host:container`) is preserved in the CLI surface;
 * this struct is the parsed form.
 */
export interface ForwardPortMapping {
  host: number;
  container: number;
}

/**
 * Parse the `--forward-ports` value: a comma-separated list of `host:container`
 * pairs (Docker `-p` order), e.g. `15173:5173,18000:8000`. Mirrors the
 * project's `--with-*` convention (comma-separated). Throws with an actionable
 * message on a malformed entry or an out-of-range port.
 */
export function parseForwardPorts(raw: string): ForwardPortMapping[] {
  const out: ForwardPortMapping[] = [];
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^(\d+):(\d+)$/.exec(entry);
    if (!m) {
      throw new Error(
        `Invalid --forward-ports entry '${entry}': expected host:container (e.g. 15173:5173).`,
      );
    }
    const host = Number(m[1]);
    const container = Number(m[2]);
    for (const [label, port] of [
      ['host', host],
      ['container', container],
    ] as const) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(
          `Invalid --forward-ports ${label} port '${port}': must be between 1 and 65535.`,
        );
      }
    }
    out.push({ host, container });
  }
  return out;
}

export interface RunShareOptions {
  name: string;
  app: string;
  monocerosHome?: string;
  /**
   * Host-port remaps for busy ports (`--forward-ports`). Each publishes the
   * container port under a different host port; unlisted ports keep parity.
   */
  forwardPorts?: ForwardPortMapping[];
  /** Injected in tests. */
  dockerSpawn?: DockerSpawn;
  resolve?: (opts: ResolveOptions) => Promise<ResolvedTarget>;
  /** TCP-connect probe for the host ports share will bind. Injected in tests. */
  probe?: PortProbe;
  installSignalHandler?: (handler: () => void) => () => void;
  hostAddresses?: () => HostAddresses;
  /**
   * Injected in tests; resolves the Windows host's LAN IP when running in WSL,
   * null elsewhere. Defaults to the real PowerShell-backed lookup.
   */
  resolveWindowsLanIp?: () => Promise<string | null>;
  /** Injected in tests; defaults to the real CA-backed TLS provisioning. */
  provisionTls?: ProvisionShareTls;
  /** Injected in tests; defaults to a quiet `docker pull` of the terminator image. */
  ensureImage?: (image: string) => Promise<void>;
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

/**
 * Pull the terminator image once, quietly, before the banner - so `docker run`
 * doesn't dump layer-by-layer progress into a user-facing foreground command.
 * A single line explains the one-time first-run delay; nothing on cache hit.
 */
async function defaultEnsureImage(
  image: string,
  log: ShareLogger,
): Promise<void> {
  const present = await new Promise<boolean>((resolve) => {
    const c = spawn('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    c.on('error', () => resolve(false));
    c.on('exit', (code) => resolve(code === 0));
  });
  if (present) return;
  log.info(dim(`Pulling ${image} (first run, one-time)…`));
  await new Promise<void>((resolve, reject) => {
    const c = spawn('docker', ['pull', '-q', image], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    c.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    c.on('error', reject);
    c.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `docker pull ${image} failed: ${err.trim() || `exit ${code}`}`,
            ),
          ),
    );
  });
}

/**
 * The CA path to print for the "trust me once" hint. On Windows the CLI runs
 * inside WSL; printing the WSL-internal path (`/home/<user>/.monoceros/...`)
 * would force the user into the distro. The onboarding symlinks
 * `%USERPROFILE%\.monoceros` to that home, so present the Windows path instead.
 * Falls back to the raw path off WSL or if the Windows home can't be resolved.
 */
async function caTrustDisplayPath(
  caCertPath: string,
  home: string,
): Promise<string> {
  if (!isWsl()) return caCertPath;
  const prof = await resolveWindowsProfile();
  if (!prof) return caCertPath;
  const rel = path.relative(home, caCertPath).split(path.sep).join('\\');
  return `${prof.homeWin}\\.monoceros\\${rel}`;
}

/**
 * First free host port at or after `start`, skipping anything already `taken`
 * (other shared ports + earlier suggestions). Probed on 0.0.0.0 like the real
 * bind. Bounded scan; falls back to `start` if nothing free is found (the value
 * is only a suggestion in an error message, not a live bind).
 */
async function findFreeHostPort(
  start: number,
  probe: PortProbe,
  taken: Set<number>,
): Promise<number> {
  let port = start > 65535 ? 20000 : start;
  for (let i = 0; i < 200 && port <= 65535; i++, port++) {
    if (taken.has(port)) continue;
    const result = await probe(port, SHARE_ADDRESS);
    if (result.ok) return port;
  }
  return start;
}

/**
 * The `share`-specific "host port already in use" error. Names the real cause
 * (the attached IDE's port auto-forward on 127.0.0.1, which cannot be reliably
 * disabled) and the two real remedies: free the exact port in the IDE, or
 * re-run with `--forward-ports` using the suggested free host ports. Unlike the
 * tunnel error, it never mentions `--local-port` (which `share` does not have).
 */
function formatShareCollision(input: {
  name: string;
  app: string;
  busyHostPorts: number[];
  suggestions: string[];
}): string {
  const plural = input.busyHostPorts.length > 1;
  const cmd = `monoceros share ${input.name} ${input.app} --forward-ports ${input.suggestions.join(',')}`;
  return [
    `Cannot share ${input.name}/${input.app}: host port${plural ? 's' : ''} ${input.busyHostPorts.join(', ')} already in use.`,
    '',
    "Your IDE forwards the container's ports to 127.0.0.1 (VS Code, Codium",
    'and JetBrains auto-forward over Remote-SSH, and it cannot be reliably',
    'turned off). That collides with share, which binds these ports on',
    '0.0.0.0 to reach other devices.',
    '',
    'Resolve it one of two ways:',
    '',
    '  1. In the IDE\'s PORTS panel, right-click each port -> "Stop Forwarding',
    '     Port" (stays gone across reconnects), then re-run share unchanged.',
    '',
    '  2. Re-run share and publish the busy ports under different host ports',
    '     (Docker order, host:container):',
    '',
    `       ${cmd}`,
  ].join('\n');
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

  // `--forward-ports` remaps the host side of busy container ports. Validate
  // each names a container port we actually share, then build the effective
  // host port per container port (parity unless remapped).
  const overrides = new Map<number, number>();
  for (const fp of opts.forwardPorts ?? []) {
    if (!ports.includes(fp.container)) {
      throw new Error(
        `--forward-ports maps container port ${fp.container}, but no shared target uses it. Shared ports: ${ports.join(', ')}.`,
      );
    }
    overrides.set(fp.container, fp.host);
  }
  const hostPortFor = (container: number): number =>
    overrides.get(container) ?? container;
  const pairs = ports.map((container) => ({
    host: hostPortFor(container),
    container,
  }));

  // Probe every effective host port on 0.0.0.0 (loopback is the real conflict
  // surface) BEFORE touching Docker, so a busy port fails fast without spinning
  // up target resolution or a cert. Collect ALL busy ports rather than dying on
  // the first, so the message can list them together with a copy-pasteable
  // remap command. The common holder is the attached IDE's port auto-forward,
  // which binds 127.0.0.1:<port> and cannot be reliably turned off (issue #57).
  const probe = opts.probe ?? realPortProbe;
  const busy: ForwardPortMapping[] = [];
  for (const pair of pairs) {
    const result = await probe(pair.host, SHARE_ADDRESS);
    if (!result.ok) busy.push(pair);
  }
  if (busy.length > 0) {
    const taken = new Set<number>(pairs.map((p) => p.host));
    const suggestions: string[] = [];
    for (const b of busy) {
      const free = await findFreeHostPort(b.container + 10000, probe, taken);
      taken.add(free);
      suggestions.push(`${free}:${b.container}`);
    }
    throw new Error(
      formatShareCollision({
        name: opts.name,
        app: opts.app,
        busyHostPorts: busy.map((b) => b.host),
        suggestions,
      }),
    );
  }

  const resolve = opts.resolve ?? resolveTunnelTarget;
  const base = await resolve({
    name: opts.name,
    target: String(ports[0]),
    ...(opts.monocerosHome !== undefined
      ? { monocerosHome: opts.monocerosHome }
      : {}),
  });

  // Issue a leaf cert covering every name/address a device might use, so socat
  // can terminate TLS - HTTP over a LAN IP / `.local` name is an insecure
  // context and kills PKCE + Service Workers (ADR 0033).
  const { ip: localIp, mdnsName } = (opts.hostAddresses ?? realHostAddresses)();
  // On WSL the enumerated IPv4 is the WSL-NAT address (172.x), unreachable from
  // the LAN. The address other devices can actually reach is the Windows host's
  // own LAN IP, so prefer it - both in the cert SANs and as the advertised
  // address. `.local` stays a best-effort extra (Windows advertises mDNS
  // inconsistently, so it must not be the only anchor). Off WSL this is null
  // and the enumerated IP stands.
  const winLanIp = await (opts.resolveWindowsLanIp ?? resolveWindowsLanIp)();
  const ip = winLanIp ?? localIp;
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

  // Pull the terminator image before the banner so a first-run `docker pull`
  // doesn't stream layer progress after we've already said "Sharing …".
  const ensureImage =
    opts.ensureImage ?? ((image: string) => defaultEnsureImage(image, log));
  await ensureImage(CADDY_IMAGE);

  // Print the whole banner first - including the awaited Windows path - so it
  // all renders while stdout is still a clean TTY. Starting the terminator's
  // interactive `docker run` mid-banner would let it grab the TTY and split
  // the output formatting (consola's fancy vs basic reporter).
  //
  // Per target, list every address a device can use - the reachable IP and,
  // when present, the `.local` name. Neither is "primary": some devices
  // resolve mDNS, others need the IP, so both are offered plainly. Group them
  // under the target name and emit the whole banner as one log call, so the
  // reporter prints a single leading glyph instead of one per line.
  const addresses = [ip, mdnsName].filter(
    (a): a is string => typeof a === 'string' && a.length > 0,
  );
  if (addresses.length === 0) addresses.push('<host-ip>');
  const caPath = await caTrustDisplayPath(tls.caCertPath, home);
  const banner: string[] = [
    `Sharing ${opts.name}/${opts.app} on the local network:`,
  ];
  for (const t of ported) {
    banner.push('', `    ${cyan(t.name)}`);
    for (const addr of addresses) {
      banner.push(`      https://${addr}:${hostPortFor(t.port)}`);
    }
  }
  banner.push(
    '',
    dim('    Trust the local CA once (first device) for warning-free HTTPS:'),
    dim(`      ${caPath}`),
    '',
    'Press Ctrl+C to stop sharing.',
  );
  log.info(banner.join('\n'));

  const dockerSpawn = opts.dockerSpawn ?? defaultDockerSpawn;
  const handles: DockerSpawnHandle[] = [
    dockerSpawn(
      buildCaddyDockerArgs({
        localAddress: SHARE_ADDRESS,
        ports: pairs,
        network: base.network,
        certDir: tls.certDir,
        caddyfilePath,
      }),
    ),
  ];

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
