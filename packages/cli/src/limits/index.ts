import path from 'node:path';
import { curatedServiceResources } from '../create/catalog.js';
import type { CreateOptions, ResourceLimits } from '../create/types.js';
import {
  realDockerLookup,
  type DockerLookupExec,
} from '../devcontainer/locate-running.js';
import { ENFORCE_DEFAULT_LIMITS_VAR } from '../config/global.js';
import { prettyPath, userTemplatesDir } from '../config/paths.js';
import { formatBytes, memoryBytes } from '../util/memory.js';

/**
 * Memory and CPU limits per workbench container (ADR 0062).
 *
 * A figure in the yml is always enforced. The catalog defaults (each service
 * descriptor's `resources:`, and the workspace's below) are enforced only on a
 * machine with `MONOCEROS_ENFORCE_DEFAULT_LIMITS=true`. The yml overrides a
 * default field by field, so a yml that sets only `memory` keeps the default
 * `cpus`.
 */

/**
 * The workspace has no descriptor, so its default lives here. It runs the
 * builds, the language servers and the agents, which is why it is the largest.
 */
export const WORKSPACE_DEFAULT_RESOURCES: Readonly<{
  memory: string;
  cpus: number;
}> = { memory: '4g', cpus: 2 };

/** The compose service name of the workspace, and its name in every message. */
export const WORKSPACE = 'workspace';

export interface ContainerLimit {
  /** `workspace`, or the service's name. */
  name: string;
  memory?: string;
  cpus?: number;
}

/**
 * The limit each container runs with: workspace first, then the services in
 * yml order. A container with neither field set runs without a limit.
 */
export function effectiveLimits(
  opts: Pick<CreateOptions, 'resources' | 'services'>,
  enforceDefaults: boolean,
): ContainerLimit[] {
  const merge = (
    declared: ResourceLimits | undefined,
    fallback: ResourceLimits | undefined,
  ): ResourceLimits => ({
    ...(enforceDefaults ? fallback : {}),
    ...declared,
  });
  return [
    { name: WORKSPACE, ...merge(opts.resources, WORKSPACE_DEFAULT_RESOURCES) },
    ...opts.services.map((svc) => ({
      name: svc.name,
      ...merge(svc.resources, curatedServiceResources(svc)),
    })),
  ];
}

/**
 * Write the effective limits onto the create options, where the scaffold reads
 * them, and return them. With the defaults enforced, a service that ends up
 * without a memory figure is an error: the machine promised a limit on every
 * container, and memory is the one it plans with.
 */
export function applyEffectiveLimits(
  opts: CreateOptions,
  enforceDefaults: boolean,
  ctx: { ymlPath: string; globalEnvPath: string; home: string },
): ContainerLimit[] {
  const limits = effectiveLimits(opts, enforceDefaults);
  if (enforceDefaults) {
    const unlimited = limits.filter((l) => l.memory === undefined);
    if (unlimited.length > 0) {
      throw new Error(formatMissingLimitError(unlimited, ctx));
    }
  }
  const byName = new Map(limits.map((l) => [l.name, l]));
  const toResources = (l: ContainerLimit | undefined): ResourceLimits =>
    l === undefined
      ? {}
      : {
          ...(l.memory !== undefined ? { memory: l.memory } : {}),
          ...(l.cpus !== undefined ? { cpus: l.cpus } : {}),
        };
  const workspace = toResources(byName.get(WORKSPACE));
  if (Object.keys(workspace).length > 0) opts.resources = workspace;
  else delete opts.resources;
  for (const svc of opts.services) {
    const r = toResources(byName.get(svc.name));
    if (Object.keys(r).length > 0) svc.resources = r;
    else delete svc.resources;
  }
  return limits;
}

function formatMissingLimitError(
  unlimited: readonly ContainerLimit[],
  ctx: { ymlPath: string; globalEnvPath: string; home: string },
): string {
  const names = unlimited.map((l) => l.name);
  const first = names[0]!;
  const descriptor = path.join(
    userTemplatesDir(ctx.home),
    'services',
    `${first}.yml`,
  );
  return [
    `${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} no memory limit, and this machine enforces one on every container (${ENFORCE_DEFAULT_LIMITS_VAR} in ${prettyPath(ctx.globalEnvPath)}).`,
    `Give ${names.length === 1 ? 'it' : 'each'} one in ${prettyPath(ctx.ymlPath)}:`,
    '',
    '  services:',
    `    - name: ${first}`,
    '      resources:',
    '        memory: 512m',
    '',
    `or in the service's own descriptor, ${prettyPath(descriptor)}. Then apply again.`,
  ].join('\n');
}

/** Whether any container runs with a limit. */
export function anyLimit(limits: readonly ContainerLimit[]): boolean {
  return limits.some((l) => l.memory !== undefined || l.cpus !== undefined);
}

/** `workspace 4g, 2 CPUs · postgres 512m, 1 CPU` for the containers with a limit. */
export function formatLimits(limits: readonly ContainerLimit[]): string {
  return limits
    .filter((l) => l.memory !== undefined || l.cpus !== undefined)
    .map((l) => {
      const parts = [
        ...(l.memory !== undefined ? [l.memory] : []),
        ...(l.cpus !== undefined
          ? [`${l.cpus} ${l.cpus === 1 ? 'CPU' : 'CPUs'}`]
          : []),
      ];
      return `${l.name} ${parts.join(', ')}`;
    })
    .join(' · ');
}

/** Sum of the memory limits, in bytes. Containers without one count 0. */
export function totalMemoryBytes(limits: readonly ContainerLimit[]): number {
  return limits.reduce(
    (sum, l) => sum + (l.memory !== undefined ? memoryBytes(l.memory) : 0),
    0,
  );
}

/** The memory Docker has in total (the VM's on macOS and Windows), or undefined. */
export async function dockerMemoryBytes(
  docker: DockerLookupExec = realDockerLookup,
): Promise<number | undefined> {
  try {
    const res = await docker(['info', '--format', '{{.MemTotal}}']);
    const bytes = Number(res.stdout.trim());
    return res.exitCode === 0 && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The warning when the memory limits of one workbench add up to more than
 * Docker has. Undefined when they fit, or when Docker's total is unknown.
 * Other workbenches are not counted: a limit is a ceiling, not a reservation.
 */
export function formatFitWarning(
  limits: readonly ContainerLimit[],
  dockerBytes: number | undefined,
  ymlPath: string,
): string | undefined {
  const total = totalMemoryBytes(limits);
  if (dockerBytes === undefined || total <= dockerBytes) return undefined;
  return (
    `The memory limits of this workbench add up to ${formatBytes(total)}, but Docker has ${formatBytes(dockerBytes)} in total. ` +
    `Under load Docker runs out before the containers reach their limits. ` +
    `Give Docker more memory, or lower \`resources.memory\` in ${prettyPath(ymlPath)}.`
  );
}

export interface OomKill {
  /** `workspace`, or the service's name. */
  container: string;
  /** The container's memory limit in bytes; 0 when it has none. */
  limitBytes: number;
  /** Docker is restarting it, which after an OOM kill means a crash loop. */
  restarting: boolean;
  restarts: number;
}

/**
 * Containers of the workbench at `root` that the kernel killed for memory
 * since they started. Docker sets `State.OOMKilled` for a killed child process
 * too, while the container itself keeps running (verified on Docker 29.6), so
 * this also catches a build that blew up in the workspace. A restart clears
 * the flag, which is why a crash loop is reported from the `restarting` state.
 *
 * Best effort: no Docker, no containers, or an unreadable answer is an empty
 * list, never an error.
 */
export async function findOomKills(
  root: string,
  docker: DockerLookupExec = realDockerLookup,
): Promise<OomKill[]> {
  try {
    const ws = await docker([
      'ps',
      '-aq',
      '--filter',
      `label=devcontainer.local_folder=${root}`,
    ]);
    const wsId = lines(ws.stdout)[0];
    if (!wsId) return [];
    const proj = await docker([
      'inspect',
      '--format',
      '{{index .Config.Labels "com.docker.compose.project"}}',
      wsId,
    ]);
    const project = proj.stdout.trim();
    const ids = new Set([wsId]);
    if (project) {
      const svc = await docker([
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ]);
      for (const id of lines(svc.stdout)) ids.add(id);
    }
    const res = await docker([
      'inspect',
      '--format',
      '{{.Id}}\t{{index .Config.Labels "com.docker.compose.service"}}\t{{.State.OOMKilled}}\t{{.State.Status}}\t{{.RestartCount}}\t{{.HostConfig.Memory}}',
      ...ids,
    ]);
    const kills: OomKill[] = [];
    for (const line of lines(res.stdout)) {
      const [id, service, oom, status, restarts, memory] = line.split('\t');
      if (oom !== 'true') continue;
      const isWorkspace = id !== undefined && id.startsWith(wsId);
      kills.push({
        container: isWorkspace || !service ? WORKSPACE : service,
        limitBytes: Number(memory) || 0,
        restarting: status === 'restarting',
        restarts: Number(restarts) || 0,
      });
    }
    return kills;
  } catch {
    return [];
  }
}

/** One OOM kill, with its cause and the way out. */
export function formatOomKill(
  kill: OomKill,
  ctx: { name: string; ymlPath: string },
): string {
  const limit =
    kill.limitBytes > 0
      ? `its ${formatBytes(kill.limitBytes)} memory limit`
      : 'the memory Docker has';
  const what =
    kill.container === WORKSPACE
      ? `A process in the workspace ran out of memory at ${limit} and was killed.`
      : kill.restarting
        ? `${kill.container} keeps running out of memory at ${limit} and is restarting (${kill.restarts} ${kill.restarts === 1 ? 'restart' : 'restarts'} so far).`
        : `${kill.container} ran out of memory at ${limit} and was killed.`;
  if (kill.limitBytes === 0) {
    return `${what} Give Docker more memory, or stop workbenches you do not need.`;
  }
  const key =
    kill.container === WORKSPACE
      ? 'the top-level `resources.memory`'
      : `\`resources.memory\` of ${kill.container}`;
  return `${what} Raise ${key} in ${prettyPath(ctx.ymlPath)}, then run \`monoceros apply ${ctx.name}\`.`;
}

/**
 * Why a command in the workspace ended with exit 137, when the reason is an
 * OOM kill. Undefined for any other SIGKILL: then the exit code is all we know.
 */
export async function explainExit137(
  root: string,
  ctx: { name: string; ymlPath: string },
  docker: DockerLookupExec = realDockerLookup,
): Promise<string | undefined> {
  const kill = (await findOomKills(root, docker)).find(
    (k) => k.container === WORKSPACE,
  );
  return kill ? formatOomKill(kill, ctx) : undefined;
}

function lines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
