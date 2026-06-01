import { existsSync } from 'node:fs';
import path from 'node:path';
import { containerConfigPath, containerDir } from '../config/paths.js';
import { readConfig } from '../config/io.js';
import {
  composeProjectName,
  dockerLocalFolderLabel,
} from '../devcontainer/compose.js';
import { SERVICE_CATALOG, knownServices } from '../create/catalog.js';
import {
  defaultDockerExec,
  PROXY_NETWORK_NAME,
  type DockerExec,
} from '../proxy/index.js';
import type { SolutionConfig } from '../config/schema.js';

/**
 * Resolved tunnel target — exactly what `docker run --network=… …
 * TCP:<host>:<port>` needs. The caller (run.ts) doesn't have to know
 * about compose-vs-image-mode or how IP lookups work; that's all
 * compressed into these three fields.
 */
export interface ResolvedTarget {
  /** Docker network the socat sidecar will join. */
  network: string;
  /** DNS name or IP address the socat sidecar forwards to. */
  targetHost: string;
  /** In-container port the target service listens on. */
  internalPort: number;
  /** Pretty label for the startup banner ("hello/postgres" or "hello:8080"). */
  display: string;
}

export interface ResolveOptions {
  /** Container name (yml in $MONOCEROS_HOME/container-configs/). */
  name: string;
  /** The raw second positional from the CLI — service name or port string. */
  target: string;
  /** Override the resolved MONOCEROS_HOME (tests inject a tmpdir). */
  monocerosHome?: string;
  /** Docker exec (tests inject a fake). */
  docker?: DockerExec;
}

/**
 * Resolve `monoceros tunnel <name> <target>` to a concrete docker
 * network + target host + internal port. Throws Error with an
 * actionable message on any unresolvable case (unknown service,
 * non-numeric port, container not running, …) — the caller surfaces
 * the message and exits 1.
 *
 * See ADR 0009 for the full topology table.
 */
export async function resolveTunnelTarget(
  opts: ResolveOptions,
): Promise<ResolvedTarget> {
  const ymlPath = containerConfigPath(opts.name, opts.monocerosHome);
  if (!existsSync(ymlPath)) {
    throw new Error(
      `No yml profile for '${opts.name}' at ${ymlPath}. Run \`monoceros init ${opts.name}\` first.`,
    );
  }
  const parsed = await readConfig(ymlPath);
  const config = parsed.config;

  const containerRoot = containerDir(opts.name, opts.monocerosHome);
  if (!existsSync(containerRoot)) {
    throw new Error(
      `Container '${opts.name}' is not materialised at ${containerRoot}. Run \`monoceros apply ${opts.name}\` first.`,
    );
  }

  const composePath = path.join(containerRoot, '.devcontainer', 'compose.yaml');
  const isCompose = existsSync(composePath);

  const parsedTarget = parseTargetArg(opts.target, config);
  const docker = opts.docker ?? defaultDockerExec;

  if (isCompose) {
    return resolveCompose({
      name: opts.name,
      containerRoot,
      parsedTarget,
    });
  }
  return resolveImageMode({
    name: opts.name,
    containerRoot,
    parsedTarget,
    config,
    docker,
  });
}

interface ParsedService {
  kind: 'service';
  service: string;
  port: number;
}

interface ParsedPort {
  kind: 'port';
  port: number;
}

type ParsedTarget = ParsedService | ParsedPort;

function parseTargetArg(raw: string, config: SolutionConfig): ParsedTarget {
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber > 0 && asNumber < 65536) {
    return { kind: 'port', port: asNumber };
  }
  // Treat as service name. Must be both in the catalog (so we know its
  // default port) AND in the container's services[] (so we know it's
  // actually running alongside the workspace).
  const entry = SERVICE_CATALOG[raw];
  if (!entry) {
    const candidates = knownServices().join(', ');
    throw new Error(
      `Unknown service '${raw}'. Known services: ${candidates}. Or pass a port number (e.g. \`monoceros tunnel <name> 8080\`).`,
    );
  }
  if (!config.services.includes(raw)) {
    throw new Error(
      `Service '${raw}' is not declared in this container's yml. Add it with \`monoceros add-service ${config.services.length === 0 ? '<name>' : '…'} ${raw}\` and re-apply.`,
    );
  }
  return { kind: 'service', service: raw, port: entry.defaultPort };
}

function resolveCompose(args: {
  name: string;
  containerRoot: string;
  parsedTarget: ParsedTarget;
}): ResolvedTarget {
  const network = `${composeProjectName(args.containerRoot)}_default`;
  if (args.parsedTarget.kind === 'service') {
    return {
      network,
      targetHost: args.parsedTarget.service,
      internalPort: args.parsedTarget.port,
      display: `${args.name}/${args.parsedTarget.service}`,
    };
  }
  return {
    network,
    targetHost: 'workspace',
    internalPort: args.parsedTarget.port,
    display: `${args.name}:${args.parsedTarget.port}`,
  };
}

async function resolveImageMode(args: {
  name: string;
  containerRoot: string;
  parsedTarget: ParsedTarget;
  config: SolutionConfig;
  docker: DockerExec;
}): Promise<ResolvedTarget> {
  if (args.parsedTarget.kind === 'service') {
    // Services live in compose; if the container is image-mode, the
    // declared service is nonsense — refuse early instead of letting
    // socat hang on a name that nowhere resolves.
    throw new Error(
      `Service '${args.parsedTarget.service}' is declared in the yml but '${args.name}' is image-mode (no compose.yaml). Services need compose mode — re-apply with at least one \`services:\` entry to get a compose setup.`,
    );
  }

  // Image-mode + port: prefer monoceros-proxy network when the yml
  // declares routing.ports (the container then has a stable alias on
  // it). Fall back to the container's bridge IP otherwise.
  const ports = args.config.routing?.ports ?? [];
  if (ports.length > 0) {
    return {
      network: PROXY_NETWORK_NAME,
      targetHost: args.name,
      internalPort: args.parsedTarget.port,
      display: `${args.name}:${args.parsedTarget.port}`,
    };
  }

  const { network, ip } = await lookupContainerNetwork({
    containerRoot: args.containerRoot,
    docker: args.docker,
  });
  return {
    network,
    targetHost: ip,
    internalPort: args.parsedTarget.port,
    display: `${args.name}:${args.parsedTarget.port}`,
  };
}

interface NetworkLookup {
  network: string;
  ip: string;
}

/**
 * For image-mode containers without `routing.ports`: find the
 * container's running ID by its `devcontainer.local_folder` label
 * (the same anchor `monoceros remove` uses), then pick the first
 * network with a usable IP and return both. Socat joins that network
 * and dials the IP directly — no DNS available on the default bridge.
 *
 * Restarts of the target invalidate the IP and break the tunnel; the
 * builder reruns `monoceros tunnel`. Acceptable for the ad-hoc use
 * case this resolver covers (see ADR 0009 — image-mode-without-ports
 * is the "notlösung" path).
 */
async function lookupContainerNetwork(args: {
  containerRoot: string;
  docker: DockerExec;
}): Promise<NetworkLookup> {
  const psResult = await args.docker([
    'ps',
    '-q',
    '--filter',
    // Windows-normalize: devcontainer-cli lowercases the drive letter
    // when stamping the label, docker filter is byte-exact. No-op
    // off Windows.
    `label=devcontainer.local_folder=${dockerLocalFolderLabel(args.containerRoot)}`,
  ]);
  if (psResult.exitCode !== 0) {
    throw new Error(
      `docker ps failed: ${psResult.stderr.trim() || `exit ${psResult.exitCode}`}`,
    );
  }
  const containerId = psResult.stdout.trim().split('\n')[0]?.trim();
  if (!containerId) {
    throw new Error(
      `No running container for '${args.containerRoot}'. Start it with \`monoceros start <name>\` (or open a shell with \`monoceros shell <name>\`) and retry.`,
    );
  }
  const inspect = await args.docker([
    'inspect',
    '--format',
    '{{json .NetworkSettings.Networks}}',
    containerId,
  ]);
  if (inspect.exitCode !== 0) {
    throw new Error(
      `docker inspect failed: ${inspect.stderr.trim() || `exit ${inspect.exitCode}`}`,
    );
  }
  let networks: Record<string, { IPAddress?: string }> | null = null;
  try {
    networks = JSON.parse(inspect.stdout) as Record<
      string,
      { IPAddress?: string }
    >;
  } catch {
    throw new Error(
      `Unexpected docker inspect output: ${inspect.stdout.slice(0, 200)}`,
    );
  }
  if (!networks) {
    throw new Error(
      `Container ${containerId} reports no networks. Restart it and retry.`,
    );
  }
  for (const [name, settings] of Object.entries(networks)) {
    if (settings.IPAddress && settings.IPAddress.length > 0) {
      return { network: name, ip: settings.IPAddress };
    }
  }
  throw new Error(
    `Container ${containerId} has no network with a reachable IP. Restart it and retry.`,
  );
}
