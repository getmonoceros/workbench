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
import { shareableServices, type ShareableService } from './services.js';
import { DEFAULT_PROXY_HOST_PORT } from '../config/global.js';
import { defaultDockerExec, type DockerExec } from '../proxy/index.js';
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
  /**
   * Set by the qualified form `host:service:port`. Only needed when the same
   * container port is claimed by more than one upstream (an app target and a
   * service, or two services), where the bare port no longer says which one
   * to move.
   */
  service?: string;
}

/**
 * Parse the `--forward-ports` value: a comma-separated list of `host:container`
 * pairs (Docker `-p` order), e.g. `15173:5173,18000:8000`. A service's port can
 * be named explicitly as `host:service:container` (e.g. `18080:keycloak:8080`),
 * which is what an ambiguous bare port asks for. Mirrors the project's
 * `--with-*` convention (comma-separated). Throws with an actionable message on
 * a malformed entry or an out-of-range port.
 */
export function parseForwardPorts(raw: string): ForwardPortMapping[] {
  const out: ForwardPortMapping[] = [];
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^(\d+):(?:([a-z0-9][a-z0-9_-]*):)?(\d+)$/.exec(entry);
    if (!m) {
      throw new Error(
        `Invalid --forward-ports entry '${entry}': expected host:container (e.g. 15173:5173) or host:service:container (e.g. 18080:keycloak:8080).`,
      );
    }
    const host = Number(m[1]);
    const container = Number(m[3]);
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
    out.push({ host, container, ...(m[2] ? { service: m[2] } : {}) });
  }
  return out;
}

export interface RunShareOptions {
  name: string;
  /**
   * App under `projects/` whose launch-config ports get shared, alongside every
   * service that declares an `httpPort`. A missing launch config only warns:
   * the services are then shared on their own.
   */
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
  /**
   * Injected in tests; defaults to reading the workbench yml for services that
   * declare an `httpPort`.
   */
  shareableServices?: (
    name: string,
    opts: { monocerosHome?: string },
  ) => Promise<ShareableService[]>;
  /** TCP-connect probe for the host ports share will bind. Injected in tests. */
  probe?: PortProbe;
  /**
   * Docker invocation used only to name what holds a busy port. Injected in
   * tests; defaults to the real `docker`.
   */
  docker?: DockerExec;
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
 * The `share`-specific "host port already in use" error. It names the holder
 * whenever docker can be asked - a container publishing that port, most often a
 * share of this very workbench still running in another terminal - and only
 * falls back to the IDE story when nothing published it, because a
 * Remote-SSH auto-forward binds 127.0.0.1 from the host and is invisible to
 * docker. Guessing "your IDE" while a container of ours holds the port sends
 * the builder hunting through a PORTS panel that has nothing in it. The
 * remedies stay the same: free the port, or re-run with `--forward-ports` and
 * the suggested free host ports. Unlike the tunnel error it never mentions
 * `--local-port`, which `share` does not have.
 */
function formatShareCollision(input: {
  name: string;
  app: string;
  busyHostPorts: number[];
  suggestions: string[];
  /** Port → `<container> (<image>)` for every busy port docker could explain. */
  holders?: ReadonlyMap<number, string>;
}): string {
  const plural = input.busyHostPorts.length > 1;
  const cmd = `monoceros share ${input.name} ${input.app} --forward-ports ${input.suggestions.join(',')}`;
  const named = input.busyHostPorts.filter((p) => input.holders?.has(p));
  const lines = [
    `Cannot share ${input.name}/${input.app}: host port${plural ? 's' : ''} ${input.busyHostPorts.join(', ')} already in use.`,
  ];
  if (named.length > 0) {
    lines.push('', 'Published by a running container:');
    for (const port of named) {
      lines.push(`  ${port}  ${input.holders!.get(port)!}`);
    }
    lines.push(
      '',
      'A share of this workbench in another terminal looks exactly like this;',
      'stop it there with Ctrl+C, or remove the container by name.',
    );
  }
  if (named.length < input.busyHostPorts.length) {
    lines.push(
      '',
      "Ports with no container behind them are usually your IDE's, which",
      'forwards the container ports to 127.0.0.1 (VS Code, Codium and',
      'JetBrains auto-forward over Remote-SSH, and it cannot be reliably',
      'turned off). That collides with share, which binds on 0.0.0.0 to',
      'reach other devices.',
    );
  }
  // A shared service can want a port the machine itself already serves, and
  // there the IDE story is the wrong lead: 80 is the Traefik singleton that
  // fronts every workbench with `routing.ports`, and freeing it would take the
  // proxy down for all of them. A reverse proxy shared on 80 hits this on its
  // first run, and its own config file is where the fix belongs - so point at
  // the yml rather than at a flag the builder would retype forever.
  if (input.busyHostPorts.includes(DEFAULT_PROXY_HOST_PORT)) {
    lines.push(
      '',
      `Port ${DEFAULT_PROXY_HOST_PORT} is the exception: that is monoceros-proxy, the machine-wide`,
      'Traefik that serves every workbench with ports, and it stays. Give the',
      'service a port of its own instead: set another `httpPort` in the yml and',
      "the same port in the service's own config (a Caddyfile's `:8080`), then",
      're-run share unchanged.',
    );
  }
  lines.push(
    '',
    'Either free the port, or re-run share and publish the busy ports under',
    'different host ports (Docker order, host:container, a service named',
    'explicitly):',
    '',
    `  ${cmd}`,
  );
  return lines.join('\n');
}

/**
 * Which container publishes each of these host ports, as `<name> (<image>)`.
 * Best effort: a docker that is unreachable or a port nothing published simply
 * leaves the entry out, and the caller then says what it can.
 */
async function findPortHolders(
  ports: readonly number[],
  docker: DockerExec,
): Promise<Map<number, string>> {
  const holders = new Map<number, string>();
  for (const port of ports) {
    try {
      const res = await docker([
        'ps',
        '--filter',
        `publish=${port}`,
        '--format',
        '{{.Names}} ({{.Image}})',
      ]);
      const first = res.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)[0];
      if (first) holders.set(port, first);
    } catch {
      // docker not reachable: the message falls back to the IDE explanation.
    }
  }
  return holders;
}

/**
 * One HTTPS listener the share terminator puts on the LAN. `hostPort` is what a
 * device dials and what Caddy listens on; `targetHost`/`targetPort` are the
 * upstream inside the workbench network, which is the workspace container for
 * an app target and the service itself for a service.
 */
interface ShareSite {
  /** Banner + error label: `<app>:<port>` for an app port, the service name otherwise. */
  label: string;
  kind: 'app' | 'service';
  hostPort: number;
  targetHost: string;
  targetPort: number;
}

/**
 * Name of the terminator container: `monoceros-share-<workbench>-<app>`. Docker
 * allows `[a-zA-Z0-9][a-zA-Z0-9_.-]*`, and an app is a path under `projects/`
 * that may nest, so slashes become hyphens. A named container is what lets the
 * next share say "your own share holds this port" instead of quoting a random
 * docker nickname.
 */
function shareContainerName(name: string, app: string): string {
  return `monoceros-share-${name}-${app.replace(/[^A-Za-z0-9_.-]+/g, '-')}`;
}

/** The `--forward-ports` spec that would move this site to `hostPort`. */
function forwardPortSpec(site: ShareSite, hostPort: number): string {
  return site.kind === 'service'
    ? `${hostPort}:${site.label}:${site.targetPort}`
    : `${hostPort}:${site.targetPort}`;
}

/**
 * Move the host side of the sites `--forward-ports` names. A bare `host:port`
 * addresses whichever site listens on that port; once two upstreams share the
 * number it stops being an address, so that case demands the qualified
 * `host:service:port` form instead of picking one silently.
 */
function applyForwardPorts(
  sites: ShareSite[],
  forwardPorts: readonly ForwardPortMapping[],
): void {
  for (const fp of forwardPorts) {
    const matches = sites.filter((s) =>
      fp.service !== undefined
        ? s.kind === 'service' && s.label === fp.service
        : s.targetPort === fp.container,
    );
    if (fp.service !== undefined) {
      const byPort = matches.filter((s) => s.targetPort === fp.container);
      if (matches.length === 0) {
        throw new Error(
          `--forward-ports names service '${fp.service}', but it is not shared. Shared services: ${
            sites
              .filter((s) => s.kind === 'service')
              .map((s) => s.label)
              .join(', ') || '(none)'
          }.`,
        );
      }
      if (byPort.length === 0) {
        throw new Error(
          `--forward-ports maps ${fp.service}:${fp.container}, but ${fp.service} is shared on port ${matches[0]!.targetPort}.`,
        );
      }
      byPort[0]!.hostPort = fp.host;
      continue;
    }
    if (matches.length === 0) {
      throw new Error(
        `--forward-ports maps container port ${fp.container}, but no shared target uses it. Shared ports: ${sites.map((s) => s.targetPort).join(', ')}.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `--forward-ports maps container port ${fp.container}, but ${matches.map((s) => s.label).join(' and ')} both use it. Name the one to move: --forward-ports ${fp.host}:<service>:${fp.container}.`,
      );
    }
    matches[0]!.hostPort = fp.host;
  }
}

/** The first host port two sites both claim, with both claimants. */
function findHostPortCollision(
  sites: readonly ShareSite[],
): { port: number; sites: ShareSite[] } | undefined {
  const seen = new Map<number, ShareSite>();
  for (const site of sites) {
    const first = seen.get(site.hostPort);
    if (first) return { port: site.hostPort, sites: [first, site] };
    seen.set(site.hostPort, site);
  }
  return undefined;
}

export async function runShare(opts: RunShareOptions): Promise<number> {
  const log: ShareLogger = opts.logger ?? {
    info: (m) => consola.info(m),
    warn: (m) => consola.warn(m),
  };

  // A missing launch config is a warning, not the end: the workbench's services
  // may well be the thing worth sharing (a reverse proxy that fronts them, a
  // mail inbox), and refusing over the app would hide them. Only when neither
  // side yields a port does share stop, further down.
  const ported: Array<{ name: string; port: number }> = [];
  const cfg = await readLaunchConfig(opts.name, opts.app, opts.monocerosHome);
  if (!cfg) {
    log.warn?.(
      `No launch config for '${opts.app}' (expected projects/${opts.app}/.monoceros/launch.json) - sharing this workbench's services only.`,
    );
  } else {
    const withPort = cfg.configurations.filter(
      (t): t is typeof t & { port: number } => typeof t.port === 'number',
    );
    if (withPort.length === 0) {
      log.warn?.(
        `No target in '${opts.app}' declares a port - sharing this workbench's services only. Add a \`port\` to a target in its launch.json to share the app itself.`,
      );
    }
    ported.push(...withPort.map((t) => ({ name: t.name, port: t.port })));
  }
  // One forward per distinct port; the network + target host are identical for
  // every workspace port, so resolve once and reuse.
  const ports = [...new Set(ported.map((t) => t.port))];

  const resolve = opts.resolve ?? resolveTunnelTarget;
  const homeOpt =
    opts.monocerosHome !== undefined
      ? { monocerosHome: opts.monocerosHome }
      : {};
  // Every app port goes to the workspace container; a service is its own
  // upstream under its own hostname, so it gets resolved on its own. Which
  // services those are is the catalog's call via `httpPort` - a database never
  // shows up here (see share/services.ts).
  const sites: ShareSite[] = [];
  // The terminator joins one network, and in compose mode every upstream lives
  // on it - the workspace and each service alike - so whichever resolution runs
  // first settles it.
  let network: string | undefined;
  if (ports.length > 0) {
    const base = await resolve({
      name: opts.name,
      target: String(ports[0]),
      ...homeOpt,
    });
    network = base.network;
    sites.push(
      ...ports.map((port) => ({
        label: `${opts.app}:${port}`,
        kind: 'app' as const,
        hostPort: port,
        targetHost: base.targetHost,
        targetPort: port,
      })),
    );
  }
  const services = await (opts.shareableServices ?? shareableServices)(
    opts.name,
    homeOpt,
  );
  for (const svc of services) {
    const target = await resolve({
      name: opts.name,
      target: `${svc.name}:${svc.port}`,
      ...homeOpt,
    });
    network ??= target.network;
    sites.push({
      label: svc.name,
      kind: 'service',
      hostPort: svc.port,
      targetHost: target.targetHost,
      targetPort: svc.port,
    });
  }

  if (sites.length === 0) {
    throw new Error(
      [
        `Nothing to share in '${opts.name}': '${opts.app}' declares no port, and no service declares an \`httpPort\`.`,
        '',
        'Give the app a target with a `port` in',
        `projects/${opts.app}/.monoceros/launch.json, or give a service an`,
        '`httpPort` in the yml, which is what lets it out of the container.',
        'Curated HTTP services bring one along; a database deliberately has',
        'none, and raw TCP goes through `monoceros tunnel` instead.',
      ].join('\n'),
    );
  }

  applyForwardPorts(sites, opts.forwardPorts ?? []);

  // Two upstreams can want the same number - an app target on 8080 and Keycloak
  // on 8080 - and one Caddy cannot listen twice on one port. Say so with both
  // claimants named instead of silently serving one of them.
  const collision = findHostPortCollision(sites);
  if (collision) {
    const free = await findFreeHostPort(
      collision.sites[1]!.hostPort + 10000,
      opts.probe ?? realPortProbe,
      new Set(sites.map((s) => s.hostPort)),
    );
    throw new Error(
      [
        `Cannot share ${opts.name}/${opts.app}: ${collision.sites
          .map((s) => s.label)
          .join(' and ')} both want host port ${collision.port}.`,
        '',
        'Publish one of them under a different host port (Docker order,',
        'host:container, a service named explicitly):',
        '',
        `  monoceros share ${opts.name} ${opts.app} --forward-ports ${forwardPortSpec(collision.sites[1]!, free)}`,
      ].join('\n'),
    );
  }

  // Probe every effective host port on 0.0.0.0 (loopback is the real conflict
  // surface) BEFORE touching Docker, so a busy port fails fast without spinning
  // up a cert. Collect ALL busy ports rather than dying on the first, so the
  // message can list them together with a copy-pasteable remap command. The
  // common holder is the attached IDE's port auto-forward, which binds
  // 127.0.0.1:<port> and cannot be reliably turned off (issue #57).
  const probe = opts.probe ?? realPortProbe;
  const busy: ShareSite[] = [];
  for (const site of sites) {
    const result = await probe(site.hostPort, SHARE_ADDRESS);
    if (!result.ok) busy.push(site);
  }
  if (busy.length > 0) {
    const taken = new Set<number>(sites.map((s) => s.hostPort));
    const suggestions: string[] = [];
    for (const b of busy) {
      const free = await findFreeHostPort(b.targetPort + 10000, probe, taken);
      taken.add(free);
      suggestions.push(forwardPortSpec(b, free));
    }
    const holders = await findPortHolders(
      busy.map((b) => b.hostPort),
      opts.docker ?? defaultDockerExec,
    );
    throw new Error(
      formatShareCollision({
        name: opts.name,
        app: opts.app,
        busyHostPorts: busy.map((b) => b.hostPort),
        suggestions,
        holders,
      }),
    );
  }

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
  const caddySites: CaddySite[] = sites.map((s) => ({
    listenPort: s.hostPort,
    targetHost: s.targetHost,
    targetPort: s.targetPort,
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
    renderCaddyfile(caddySites, tls.certFile, tls.keyFile),
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
  const hostPortForApp = (port: number): number =>
    sites.find((s) => s.kind === 'app' && s.targetPort === port)?.hostPort ??
    port;
  for (const t of ported) {
    banner.push('', `    ${cyan(t.name)}`);
    for (const addr of addresses) {
      banner.push(`      https://${addr}:${hostPortForApp(t.port)}`);
    }
  }
  // Services come after the app's own targets, under their service name, so it
  // is obvious which of the addresses is the login server or the mail inbox.
  for (const s of sites.filter((x) => x.kind === 'service')) {
    banner.push('', `    ${cyan(s.label)} ${dim('(service)')}`);
    for (const addr of addresses) {
      banner.push(`      https://${addr}:${s.hostPort}`);
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
        containerName: shareContainerName(opts.name, opts.app),
        ports: sites.map((s) => ({ host: s.hostPort })),
        // Set by the resolution above; `sites` is non-empty by this point, so
        // at least one target was resolved.
        network: network!,
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
