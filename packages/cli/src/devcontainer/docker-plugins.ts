import { spawn } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { type DockerExec, defaultDockerExec } from '../proxy/index.js';
import { prettyPath } from '../config/paths.js';
import { cyan } from '../util/format.js';
import { isWslHost } from '../util/wsl.js';

/**
 * Preflight for the two Docker CLI plugins a build leans on: Compose (every
 * workbench with services runs through it) and Buildx (BuildKit builds).
 *
 * "Not available" has several causes, and each needs a different fix, so the
 * probe finds out which one it is instead of assuming the plugin is missing.
 * The case that prompted this (#111): Compose installed with Homebrew next to
 * Colima, sitting in `/opt/homebrew/lib/docker/cli-plugins`, where the Docker
 * CLI does not look. `docker compose` said "unknown command" although the
 * binary was on disk, and devcontainer-cli died with `spawn docker-compose
 * ENOENT`, which names neither the plugin nor the fix.
 */
export type DockerPlugin = 'compose' | 'buildx';

export type PluginState =
  /** `docker <plugin> version` works (or, for Compose, a standalone binary does). */
  | { kind: 'ok' }
  /** `docker` itself could not be spawned; the daemon/CLI checks report that. */
  | { kind: 'unknown' }
  /** The Docker CLI finds the plugin but cannot run it. */
  | { kind: 'broken'; path: string; error: string }
  /** A plugin link in a directory the CLI searches points at nothing. */
  | { kind: 'dangling'; link: string; target: string; installed?: string }
  /** Installed, but somewhere the Docker CLI does not look for plugins. */
  | { kind: 'unregistered'; installed: string }
  | { kind: 'missing' };

export type CommandRun = (
  cmd: string,
  args: string[],
) => Promise<{ exitCode: number }>;

export interface PluginProbeOptions {
  exec?: DockerExec;
  /** Runs a non-docker command (the standalone `docker-compose`). */
  run?: CommandRun;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The CLI's built-in plugin directories. Tests override. */
  systemDirs?: string[];
  /** Where plugins get installed without being registered. Tests override. */
  installDirs?: string[];
}

// docker/cli: cli-plugins/manager (defaultSystemPluginDirs, unix).
const SYSTEM_PLUGIN_DIRS = [
  '/usr/local/lib/docker/cli-plugins',
  '/usr/local/libexec/docker/cli-plugins',
  '/usr/lib/docker/cli-plugins',
  '/usr/libexec/docker/cli-plugins',
];

// Homebrew (Apple silicon, Intel, Linux) links its plugin formulae here,
// and Docker Desktop ships them inside its app bundle.
const INSTALL_DIRS = [
  '/opt/homebrew/lib/docker/cli-plugins',
  '/usr/local/lib/docker/cli-plugins',
  '/home/linuxbrew/.linuxbrew/lib/docker/cli-plugins',
  '/Applications/Docker.app/Contents/Resources/cli-plugins',
];

const LABEL: Record<DockerPlugin, string> = {
  compose: 'Docker Compose',
  buildx: 'Docker Buildx',
};

const defaultRun: CommandRun = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exitCode: code ?? 1 }));
  });

export function dockerConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['DOCKER_CONFIG'] || path.join(env['HOME'] || homedir(), '.docker');
}

function extraPluginDirs(configDir: string): string[] {
  try {
    const cfg = JSON.parse(
      readFileSync(path.join(configDir, 'config.json'), 'utf8'),
    ) as { cliPluginsExtraDirs?: unknown };
    return Array.isArray(cfg.cliPluginsExtraDirs)
      ? cfg.cliPluginsExtraDirs.filter(
          (d): d is string => typeof d === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export async function probeDockerPlugin(
  plugin: DockerPlugin,
  options: PluginProbeOptions = {},
): Promise<PluginState> {
  const exec = options.exec ?? defaultDockerExec;
  const run = options.run ?? defaultRun;
  const env = options.env ?? process.env;
  const bin = `docker-${plugin}`;

  try {
    if ((await exec([plugin, 'version'])).exitCode === 0) return { kind: 'ok' };
  } catch {
    return { kind: 'unknown' };
  }

  // devcontainer-cli falls back to a standalone `docker-compose` on PATH,
  // so a working one is a working setup.
  if (plugin === 'compose') {
    try {
      if ((await run('docker-compose', ['version'])).exitCode === 0) {
        return { kind: 'ok' };
      }
    } catch {
      // not on PATH
    }
  }

  // The CLI lists every plugin it found, with the reason when it cannot
  // run one. Client-side only, so it answers without a daemon.
  try {
    const res = await exec([
      'info',
      '--format',
      '{{json .ClientInfo.Plugins}}',
    ]);
    const plugins = JSON.parse(res.stdout.trim() || '[]') as Array<{
      Name?: string;
      Path?: string;
      Err?: string;
    }>;
    const found = plugins.find((p) => p.Name === plugin && p.Err);
    if (found) {
      return {
        kind: 'broken',
        path: found.Path ?? bin,
        error: found.Err ?? '',
      };
    }
  } catch {
    // no usable listing; the filesystem checks below still apply
  }

  const configDir = dockerConfigDir(env);
  const searchDirs = [
    path.join(configDir, 'cli-plugins'),
    ...extraPluginDirs(configDir),
    ...(options.systemDirs ?? SYSTEM_PLUGIN_DIRS),
  ];
  const installed = (options.installDirs ?? INSTALL_DIRS)
    .map((d) => path.join(d, bin))
    .find(isFile);

  for (const dir of searchDirs) {
    const link = path.join(dir, bin);
    try {
      if (lstatSync(link).isSymbolicLink() && !isFile(link)) {
        return {
          kind: 'dangling',
          link,
          target: readlinkSync(link),
          ...(installed ? { installed } : {}),
        };
      }
    } catch {
      // nothing there
    }
  }

  if (installed) return { kind: 'unregistered', installed };
  return { kind: 'missing' };
}

interface RenderContext {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function brewPrefix(): string {
  return process.arch === 'arm64' ? '/opt/homebrew' : '/usr/local';
}

interface Diagnosis {
  cause: string;
  /** Commands to paste, in order. */
  commands: string[];
  /** A step that is not a command (a settings path, a reinstall). */
  note?: string;
}

/** The cause, in one sentence, plus what fixes it. */
function diagnose(
  plugin: DockerPlugin,
  state: Exclude<PluginState, { kind: 'ok' } | { kind: 'unknown' }>,
  ctx: RenderContext,
): Diagnosis {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const label = LABEL[plugin];
  const bin = `docker-${plugin}`;
  const pluginDir = prettyPath(path.join(dockerConfigDir(env), 'cli-plugins'));
  const linkInto = (target: string) => [
    `mkdir -p ${pluginDir}`,
    `ln -sfn ${target} ${pluginDir}/${bin}`,
  ];

  switch (state.kind) {
    case 'broken': {
      const cause = `The Docker CLI finds ${label} at ${prettyPath(state.path)} but cannot run it: ${state.error}`;
      let real = state.path;
      try {
        real = realpathSync(state.path);
      } catch {
        // keep the listed path
      }
      if (real.includes('/Docker.app/')) {
        return {
          cause,
          commands: [],
          note: 'Update or reinstall Docker Desktop.',
        };
      }
      if (real.includes('/Cellar/') || real.startsWith('/opt/homebrew/')) {
        return { cause, commands: [`brew reinstall ${bin}`] };
      }
      return {
        cause,
        commands: [],
        note: 'Reinstall it with the package manager you installed it with.',
      };
    }
    case 'dangling': {
      const cause = `${prettyPath(state.link)} points to ${state.target}, which does not exist anymore.`;
      if (state.installed) {
        return {
          cause,
          commands: [`ln -sfn ${state.installed} ${prettyPath(state.link)}`],
        };
      }
      const install = installHint(plugin, platform, env, linkInto);
      return {
        ...install,
        cause,
        commands: [`rm ${prettyPath(state.link)}`, ...install.commands],
      };
    }
    case 'unregistered':
      return {
        cause: `${label} is installed at ${state.installed}, but the Docker CLI does not look for plugins there.`,
        commands: linkInto(state.installed),
      };
    case 'missing':
      return {
        ...installHint(plugin, platform, env, linkInto),
        cause: `The Docker CLI here has no ${label}.`,
      };
  }
}

function installHint(
  plugin: DockerPlugin,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  linkInto: (target: string) => string[],
): Omit<Diagnosis, 'cause'> {
  const bin = `docker-${plugin}`;
  if (platform === 'darwin') {
    return {
      commands: [
        `brew install ${bin}`,
        ...linkInto(`${brewPrefix()}/lib/docker/cli-plugins/${bin}`),
      ],
    };
  }
  if (platform === 'linux' && isWslHost(platform, env)) {
    return {
      commands: [],
      note: 'Docker Desktop comes with it. Turn on Settings > Resources > WSL integration for this distro, then Apply & Restart.',
    };
  }
  if (platform === 'linux') {
    return {
      commands: [`sudo apt-get install ${bin}-plugin`],
      note: "The package comes from Docker's own repository, which get.docker.com sets up.",
    };
  }
  const docs = plugin === 'compose' ? 'compose/install/' : 'go/buildx/';
  return { commands: [], note: `See https://docs.docker.com/${docs}` };
}

function renderFix(d: Diagnosis): string[] {
  return [
    'To fix:',
    '',
    ...d.commands.map((c) => cyan(`  ${c}`)),
    ...(d.note && d.commands.length > 0 ? [''] : []),
    ...(d.note ? [`  ${d.note}`] : []),
  ];
}

/** Fatal: a workbench with services cannot come up without Compose. */
export function formatComposeUnavailableError(
  name: string,
  ymlPath: string,
  state: Exclude<PluginState, { kind: 'ok' } | { kind: 'unknown' }>,
  ctx: RenderContext = {},
): string {
  const d = diagnose('compose', state, ctx);
  return [
    'Docker Compose is not available, and this workbench needs it.',
    '',
    `The workbench ${name} has services in ${prettyPath(ymlPath)}, and services start through Docker Compose.`,
    d.cause,
    '',
    ...renderFix(d),
    '',
    `Check with ${cyan('docker compose version')}, then re-run ${cyan(`monoceros apply ${name}`)}.`,
  ].join('\n');
}

/** Not fatal: without Buildx Docker falls back to its legacy builder. */
export function formatBuildxUnavailableWarning(
  state: Exclude<PluginState, { kind: 'ok' } | { kind: 'unknown' }>,
  ctx: RenderContext = {},
): string {
  const d = diagnose('buildx', state, ctx);
  return [
    "Docker Buildx is not available, so images build with Docker's legacy builder, which Docker has deprecated.",
    d.cause,
    '',
    ...renderFix(d),
  ].join('\n');
}
