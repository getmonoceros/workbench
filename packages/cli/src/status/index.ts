import { readConfig } from '../config/io.js';
import { containerConfigPath, containerDir } from '../config/paths.js';
import { proxyHostPort, readMonocerosConfig } from '../config/global.js';
import { solutionConfigToCreateOptions } from '../config/transform.js';
import { listApps, readLaunchConfig } from '../config/launch-config.js';
import { runtimeSupportsAppStatus } from '../create/catalog.js';
import {
  findUnmountedServiceConfigs,
  type UnmountedServiceConfig,
} from '../check/index.js';
import type { ResolvedService } from '../create/types.js';
import {
  realDockerLookup,
  type DockerLookupExec,
} from '../devcontainer/locate-running.js';
import {
  proxyUrlsFor,
  serviceProxyUrl,
  type ProxyUrl,
} from '../proxy/dynamic.js';
import { httpServices } from '../config/http-services.js';
import { type Palette } from '../util/format.js';

/**
 * `monoceros status <name>` model + renderer.
 *
 * The redesigned status is a Monoceros-styled overview of the whole stack, not
 * a raw `docker ps` dump: the running state of the container, its compose
 * services and its long-running apps (`✓` up / `·` down), plus the static
 * "what was built in" from the yml (languages, features) and the proxy URLs.
 *
 * Two registers, deliberately kept apart:
 *   - runtime state (container / services / apps): has `✓`/`·` liveness.
 *   - declared composition (built-in, ports): from the yml, no liveness glyph -
 *     a feature is never "stopped", it is baked into the image or it isn't.
 *
 * Data sources: docker (`ps` for container + services, `exec monoceros-ctl list
 * --json` for app run-state), and the yml (services/ports/languages/features +
 * the host-side launch-config inventory, which works with the container down).
 */

export interface ContainerState {
  exists: boolean;
  running: boolean;
  /** docker's STATUS column (e.g. "Up 2 hours", "Exited (0) 3 minutes ago"). */
  status: string;
  /** docker NAMES (e.g. `monoceros-acme`). */
  dockerName: string;
}

export interface ServiceState {
  name: string;
  running: boolean;
  /** docker STATUS, or "not created" when the service container is absent. */
  status: string;
  /** In-container listen port, when the catalog declares one. */
  port?: number;
  /**
   * Host name the proxy routes to this service, when it declares an `httpPort`.
   * It belongs on the service row and not in the Ports section: that section is
   * the workspace's own ports, while this is an address of a sibling container.
   */
  route?: string;
  /**
   * Config files written for this service at the standard location that
   * no volume in the yml mounts, so the service runs without ever reading
   * them. Same detector `monoceros check` uses, so the two cannot
   * disagree. Empty for a service with nothing pending.
   */
  unmountedConfigs: UnmountedServiceConfig[];
}

export interface AppTargetState {
  app: string;
  target: string;
  port: number | null;
  /**
   * Whether the target's port is exposed in the yml, i.e. whether the
   * proxy has a route for it. `null` when the target declares no port.
   * A target with `false` here can run and still be unreachable from the
   * outside - the mismatch `monoceros check` reports as a finding, shown
   * here because this is where a builder looks when the app does not
   * answer.
   */
  portRouted: boolean | null;
  default: boolean;
  /**
   * `true`/`false` when live state is known (container up + runtime supports
   * `list --json`); `undefined` when only the host-side inventory is available
   * (container down / old runtime) - rendered without a liveness glyph.
   */
  running: boolean | undefined;
  pid: number | null;
}

export interface StatusModel {
  name: string;
  /** False when no yml exists for this name. */
  configured: boolean;
  container: ContainerState;
  services: ServiceState[];
  apps: AppTargetState[];
  /** True when app rows carry live state (container up + runtime >= 1.6.0). */
  appStateKnown: boolean;
  /** Why app state is unknown, for the note under the Apps section. */
  appStateNote?: string;
  ports: ProxyUrl[];
  builtIn: { languages: string[]; features: string[] };
}

export interface GatherOptions {
  home?: string;
  /** Injected in tests. */
  docker?: DockerLookupExec;
}

/** Last path/ref segment with any `:tag` stripped (e.g. `…/claude-code:1` → `claude-code`). */
function shortFeatureName(ref: string): string {
  const withoutTag = ref.replace(/:[^:/@]+$/, '');
  const idx = withoutTag.lastIndexOf('/');
  return idx >= 0 ? withoutTag.slice(idx + 1) : withoutTag;
}

/** Split a tab-separated docker `--format` line; trailing empty fields kept. */
function cols(line: string): string[] {
  return line.split('\t');
}

function nonEmptyLines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export async function gatherStatus(
  name: string,
  opts: GatherOptions = {},
): Promise<StatusModel> {
  const docker = opts.docker ?? realDockerLookup;
  const root = containerDir(name, opts.home);

  // ── yml (declared composition) ──────────────────────────────────────
  let runtimeVersion: string | undefined;
  let languages: string[] = [];
  let features: string[] = [];
  let declaredServices: { name: string; port?: number }[] = [];
  let resolvedServices: ResolvedService[] = [];
  let declaredPorts: number[] = [];
  let configured = false;
  try {
    const parsed = await readConfig(containerConfigPath(name, opts.home));
    const createOpts = solutionConfigToCreateOptions(parsed.config);
    configured = true;
    runtimeVersion = createOpts.runtimeVersion;
    languages = createOpts.languages;
    features = Object.keys(createOpts.features ?? {}).map(shortFeatureName);
    declaredServices = createOpts.services.map((s) => ({
      name: s.name,
      ...(typeof s.port === 'number' ? { port: s.port } : {}),
    }));
    resolvedServices = [...createOpts.services];
    declaredPorts = createOpts.ports ?? [];
  } catch {
    // No yml (or unreadable) — render what we can; `configured` stays false.
  }

  // ── container (one row, by the devcontainer.local_folder label) ─────
  let container: ContainerState = {
    exists: false,
    running: false,
    status: '',
    dockerName: '',
  };
  let containerId = '';
  let composeProject = '';
  const cps = await docker([
    'ps',
    '-a',
    '--no-trunc',
    '--filter',
    `label=devcontainer.local_folder=${root}`,
    '--format',
    '{{.ID}}\t{{.State}}\t{{.Status}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}',
  ]);
  const row = nonEmptyLines(cps.stdout)[0];
  if (row) {
    const [id, state, status, names, project] = cols(row);
    containerId = id ?? '';
    composeProject = project ?? '';
    container = {
      exists: true,
      running: state === 'running',
      status: status ?? '',
      dockerName: names ?? '',
    };
  }

  // Effective Traefik host port, read once: both the service routes below and
  // the Ports section further down spell it out when it is not the default 80.
  let hostPort = 80;
  try {
    hostPort = proxyHostPort(
      await readMonocerosConfig({
        ...(opts.home ? { monocerosHome: opts.home } : {}),
      }),
    );
  } catch {
    // default host port
  }

  // ── services (by compose project label; works stopped via `ps -a`) ──
  const services: ServiceState[] = [];
  if (declaredServices.length > 0) {
    const live = new Map<string, { running: boolean; status: string }>();
    if (composeProject) {
      const sps = await docker([
        'ps',
        '-a',
        '--filter',
        `label=com.docker.compose.project=${composeProject}`,
        '--format',
        '{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}',
      ]);
      for (const l of nonEmptyLines(sps.stdout)) {
        const [svc, state, status] = cols(l);
        if (svc)
          live.set(svc, { running: state === 'running', status: status ?? '' });
      }
    }
    // Config files written for a service that no volume feeds to it. Host-
    // side read of the workspace, so it works with the container down.
    const unmounted = await findUnmountedServiceConfigs(root, resolvedServices);
    // Which services the proxy has a route for, by name.
    const routed = new Map(
      httpServices(resolvedServices).map((svc) => [
        svc.name,
        serviceProxyUrl(name, svc.name, hostPort).replace(/^https?:\/\//, ''),
      ]),
    );
    for (const s of declaredServices) {
      const m = live.get(s.name);
      const route = routed.get(s.name);
      services.push({
        name: s.name,
        running: m?.running ?? false,
        status: m?.status ?? 'not created',
        ...(typeof s.port === 'number' ? { port: s.port } : {}),
        ...(route ? { route } : {}),
        unmountedConfigs: unmounted.filter((u) => u.service === s.name),
      });
    }
  }

  // ── apps: host-side inventory, overlaid with live state when possible ─
  const apps: AppTargetState[] = [];
  for (const app of await listApps(name, opts.home)) {
    const cfg = await readLaunchConfig(name, app, opts.home);
    if (!cfg) continue;
    for (const t of cfg.configurations) {
      const port = typeof t.port === 'number' ? t.port : null;
      apps.push({
        app,
        target: t.name,
        port,
        // A target's port only reaches a browser when the yml exposes it.
        // Without this, status printed the `.localhost` URL for a target
        // the proxy has no route for at all.
        portRouted: port === null ? null : declaredPorts.includes(port),
        default: t.default === true,
        running: undefined,
        pid: null,
      });
    }
  }
  const appsSupported = runtimeSupportsAppStatus(runtimeVersion);
  let appStateKnown = container.running && appsSupported && containerId !== '';
  let appStateNote: string | undefined;
  if (appStateKnown) {
    const res = await docker([
      'exec',
      containerId,
      'monoceros-ctl',
      'list',
      '--json',
    ]);
    if (res.exitCode === 0) {
      const byKey = new Map<string, { running: boolean; pid: number | null }>();
      for (const l of nonEmptyLines(res.stdout)) {
        try {
          const o = JSON.parse(l) as {
            app: string;
            target: string;
            running: boolean;
            pid: number | null;
          };
          byKey.set(`${o.app} ${o.target}`, {
            running: !!o.running,
            pid: o.pid ?? null,
          });
        } catch {
          // skip a malformed line rather than fail the whole status
        }
      }
      for (const a of apps) {
        const o = byKey.get(`${a.app} ${a.target}`);
        if (o) {
          a.running = o.running;
          a.pid = o.pid;
        } else {
          a.running = false; // declared but the runner doesn't track it → down
        }
      }
    } else {
      // The yml pins a runtime that should have `list --json`, but the running
      // image's runner rejected it - almost always an image that predates the
      // NDJSON surface (yml bumped to 1.6.0 but the container not yet rebuilt /
      // upgraded). Don't fake state; explain how to fix it.
      appStateKnown = false;
      appStateNote = `could not read run state from the runner - rebuild the runtime image, then \`monoceros upgrade ${name}\``;
    }
  }
  if (apps.length > 0 && !appStateKnown && !appStateNote) {
    appStateNote = !container.running
      ? `start the container to see run state (\`monoceros start ${name}\`)`
      : `run state needs runtime 1.6.0+ (this one: ${runtimeVersion ?? 'unpinned'})`;
  }

  // ── ports (proxy URLs, static from the yml) ─────────────────────────
  const ports = proxyUrlsFor(name, declaredPorts, hostPort);
  return {
    name,
    configured,
    container,
    services,
    apps,
    appStateKnown,
    ...(appStateNote ? { appStateNote } : {}),
    ports,
    builtIn: { languages, features },
  };
}

// ── rendering ─────────────────────────────────────────────────────────

/** `  <marker> <cyan name padded to col> <detail>` — the shared row shape. */
function row(
  p: Palette,
  marker: string,
  name: string,
  detail: string,
  pad: number,
  indent = 2,
): string {
  const gap = Math.max(2, pad - name.length + 2);
  return `${' '.repeat(indent)}${marker} ${p.cyan(name)}${' '.repeat(gap)}${detail}`;
}

function liveMarker(p: Palette, running: boolean | undefined): string {
  if (running === undefined) return ' '; // unknown state → no glyph
  return running ? p.green('✓') : p.dim('·');
}

function renderContainer(p: Palette, m: StatusModel): string[] {
  const out = [p.sectionLine(m.name)];
  if (!m.container.exists) {
    out.push(
      row(
        p,
        p.dim('·'),
        '(not created)',
        p.dim(`run \`monoceros apply ${m.name}\``),
        14,
      ),
    );
    return out;
  }
  const detail = m.container.running
    ? p.dim(m.container.status || 'running')
    : p.dim(m.container.status || 'stopped');
  out.push(
    row(
      p,
      liveMarker(p, m.container.running),
      m.container.dockerName,
      detail,
      14,
    ),
  );
  return out;
}

function renderServices(p: Palette, m: StatusModel): string[] {
  if (m.services.length === 0) return [];
  const pad = Math.max(...m.services.map((s) => s.name.length));
  const out = ['', p.sectionLine('Services')];
  for (const s of m.services) {
    const state = s.running
      ? typeof s.port === 'number'
        ? `running    :${s.port}`
        : 'running'
      : s.status || 'stopped';
    // The proxy route is declared, not live: it exists as long as the yml says
    // so, whether the service answers or not. So it rides along on the row
    // rather than gating on `running`.
    const detail = p.dim(s.route ? `${state}    ${s.route}` : state);
    const marked =
      s.unmountedConfigs.length > 0
        ? `${detail}    ${p.yellow(`⚠ ${s.unmountedConfigs.map((u) => baseName(u.file)).join(', ')} not mounted`)}`
        : detail;
    out.push(row(p, liveMarker(p, s.running), s.name, marked, pad));
  }
  out.push(
    ...unmountedConfigLines(
      p,
      m.name,
      m.services.flatMap((s) => s.unmountedConfigs),
    ),
  );
  return out;
}

/** Last path segment, for the short marker on a service row. */
function baseName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/**
 * The service runs, and runs without the config the project wrote for it.
 * The way out is a yml edit, not a command, so the spec is printed ready
 * to paste — and the apply is real here, unlike with `add-port`: a volume
 * needs the container recreated.
 */
function unmountedConfigLines(
  p: Palette,
  name: string,
  pending: readonly UnmountedServiceConfig[],
): string[] {
  if (pending.length === 0) return [];
  const out: string[] = [];
  for (const u of pending) {
    out.push(
      `  ${p.dim(`${u.file} is never read. Add it to the \`${u.service}\` service's \`volumes:\` in the yml:`)}`,
    );
    out.push(`    - ${u.mountSpec}`);
  }
  out.push(`  ${p.dim('Then:')} monoceros apply ${name}`);
  return out;
}

/**
 * Ports an app's targets declare that the yml does not expose, with the
 * one command that exposes them. Shared by the full view and the
 * per-app view so a narrowed `status` says the same thing.
 */
function unexposedPortLines(
  p: Palette,
  m: StatusModel,
  targets: readonly AppTargetState[],
): string[] {
  const unexposed = [
    ...new Set(
      targets
        .filter((a) => a.portRouted === false && a.port !== null)
        .map((a) => a.port as number),
    ),
  ].sort((a, b) => a - b);
  if (unexposed.length === 0) return [];
  // One call takes every port, and `add-port` pushes the routes to the
  // proxy itself — no apply needed.
  //
  // The note about the first port is only true while the yml exposes
  // none: `routing.ports[0]` is what answers on `http://<name>.localhost`,
  // and add-port appends. With ports already there, the existing first one
  // keeps that URL and we say nothing about it.
  return [
    `  ${p.dim(
      m.ports.length === 0
        ? `Expose them so the proxy can route them (the first port answers on http://${m.name}.localhost):`
        : 'Expose them so the proxy can route them:',
    )}`,
    `    monoceros add-port ${m.name} ${unexposed.join(' ')}`,
  ];
}

function appTargetDetail(p: Palette, name: string, t: AppTargetState): string {
  const bits: string[] = [];
  const routed = t.portRouted !== false;
  if (t.running === true) {
    // No URL for an unrouted port: the proxy has no route, so printing
    // `http://<name>-<port>.localhost` would promise a 404.
    bits.push(
      t.port !== null && routed
        ? p.dim(`http://${name}-${t.port}.localhost`)
        : p.dim('running'),
    );
    if (t.pid !== null) bits.push(p.dim(`pid ${t.pid}`));
  } else if (t.running === false) {
    bits.push(p.dim('stopped'));
  }
  if (t.default) bits.push(p.dim('(default)'));
  if (!routed) bits.push(p.yellow(`⚠ :${t.port} not exposed`));
  return bits.join('    ');
}

function renderApps(p: Palette, m: StatusModel): string[] {
  if (m.apps.length === 0) return [];
  const out = ['', p.sectionLine('Apps')];
  if (m.appStateNote) out.push(`  ${p.dim(m.appStateNote)}`);
  const byApp = new Map<string, AppTargetState[]>();
  for (const a of m.apps) {
    const list = byApp.get(a.app) ?? [];
    list.push(a);
    byApp.set(a.app, list);
  }
  for (const [app, targets] of byApp) {
    out.push(`  ${p.cyan(app)}`);
    const pad = Math.max(...targets.map((t) => t.target.length));
    for (const t of targets) {
      out.push(
        row(
          p,
          liveMarker(p, t.running),
          t.target,
          appTargetDetail(p, m.name, t),
          pad,
          4,
        ),
      );
    }
  }
  // The marker states the problem; this states the way out. Pointing at
  // another command that only prints another report would leave the
  // builder exactly where they were.
  out.push(...unexposedPortLines(p, m, m.apps));
  return out;
}

function renderPorts(p: Palette, m: StatusModel): string[] {
  if (m.ports.length === 0) return [];
  const pad = Math.max(...m.ports.map((r) => String(r.port).length));
  const out = ['', p.sectionLine('Ports')];
  for (const r of m.ports) {
    const hosts = r.isDefault
      ? `${m.name}.localhost · ${m.name}-${r.port}.localhost`
      : `${m.name}-${r.port}.localhost`;
    out.push(row(p, ' ', String(r.port), p.dim(hosts), pad));
  }
  return out;
}

function renderBuiltIn(p: Palette, m: StatusModel): string[] {
  const lines: { label: string; values: string[] }[] = [];
  if (m.builtIn.languages.length > 0)
    lines.push({ label: 'Languages', values: m.builtIn.languages });
  if (m.builtIn.features.length > 0)
    lines.push({ label: 'Features', values: m.builtIn.features });
  if (lines.length === 0) return [];
  const labelWidth = Math.max(...lines.map((l) => l.label.length));
  const out = ['', `${p.sectionLine('Built in')}  ${p.dim('from the yml')}`];
  for (const l of lines) {
    out.push(`  ${l.label.padEnd(labelWidth)}  ${p.cyan(l.values.join(', '))}`);
  }
  return out;
}

/** Full-stack status block. The caller adds framing newlines. */
export function renderStatus(m: StatusModel, p: Palette): string {
  return [
    ...renderContainer(p, m),
    ...renderServices(p, m),
    ...renderApps(p, m),
    ...renderPorts(p, m),
    ...renderBuiltIn(p, m),
  ].join('\n');
}

/** Focused view: one app's targets (the Apps section scoped to `<app>`). */
export function renderApp(m: StatusModel, app: string, p: Palette): string {
  const targets = m.apps.filter((a) => a.app === app);
  if (targets.length === 0) {
    const known = [...new Set(m.apps.map((a) => a.app))];
    throw new Error(
      `No app "${app}" in ${m.name} (have: ${known.join(', ') || 'none'}).`,
    );
  }
  const out = [p.sectionLine(app)];
  if (m.appStateNote) out.push(`  ${p.dim(m.appStateNote)}`);
  const pad = Math.max(...targets.map((t) => t.target.length));
  for (const t of targets) {
    out.push(
      row(
        p,
        liveMarker(p, t.running),
        t.target,
        appTargetDetail(p, m.name, t),
        pad,
        2,
      ),
    );
  }
  // Narrowing to one app must not drop the reason it cannot answer.
  out.push(...unexposedPortLines(p, m, targets));
  return out.join('\n');
}

/** Focused view: one compose service. */
export function renderService(
  m: StatusModel,
  name: string,
  p: Palette,
): string {
  const s = m.services.find((svc) => svc.name === name);
  if (!s) {
    throw new Error(
      `No service "${name}" in ${m.name} (have: ${m.services.map((x) => x.name).join(', ') || 'none'}).`,
    );
  }
  const detail = s.running
    ? p.dim(typeof s.port === 'number' ? `running    :${s.port}` : 'running')
    : p.dim(s.status || 'stopped');
  const marked =
    s.unmountedConfigs.length > 0
      ? `${detail}    ${p.yellow(`⚠ ${s.unmountedConfigs.map((u) => baseName(u.file)).join(', ')} not mounted`)}`
      : detail;
  return [
    p.sectionLine('Services'),
    row(p, liveMarker(p, s.running), s.name, marked, s.name.length),
    // Narrowing to one service must not drop the config it never reads.
    ...unmountedConfigLines(p, m.name, s.unmountedConfigs),
  ].join('\n');
}
