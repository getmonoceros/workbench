import { promises as fs } from 'node:fs';
import path from 'node:path';
import { containerDir } from './paths.js';

/**
 * `projects/<app>/.monoceros/launch.json` — the per-app launch config that
 * declares how an app's long-running server(s) are started. It travels with
 * the app (lives in the app's own repo), is hand-editable, and is maintained
 * by the build agent: when the agent starts a long-running server it
 * adds/updates the matching entry here.
 *
 * Monoceros never guesses the start command (it isn't always `npm run dev` —
 * `mvn spring-boot:run`, `python manage.py runserver`, `cargo run`, …).
 * Whoever knows the command is the agent at build time, or the human; the
 * file is read at `start` time, after the app exists. There is no language
 * detection and no apply-time declaration.
 *
 * The same file is read on both sides: host-side here (for `list-apps`,
 * completion, and resolving the default target) and in-container by the
 * `monoceros-ctl` runner (which actually launches the process).
 */
export interface LaunchTarget {
  /** Target name, unique within the app. The value passed to `--target`. */
  name: string;
  /**
   * The start command, a single string run through `setsid sh -c "<command>"`
   * inside the container. A single string (not executable + args[]) on
   * purpose: it is exactly what the agent/human already types, and it goes
   * through a shell anyway.
   */
  command: string;
  /** Working directory, relative to the app dir (`projects/<app>/`). Default `.`. */
  cwd?: string;
  /**
   * The port the server listens on. Drives the readiness probe (`start`
   * waits until something listens) and the reachable-URL hint
   * (`http://<name>-<port>.localhost`). Must reference a port already
   * declared at the container level — the launch config cannot add ports.
   */
  port?: number;
  /** Extra environment variables for the process. */
  env?: Record<string, string>;
  /** When true, this target is used if `--target` is omitted. At most one. */
  default?: boolean;
}

export interface LaunchConfig {
  /** Schema version. Currently always 1. */
  version: number;
  configurations: LaunchTarget[];
}

export const LAUNCH_DIRNAME = '.monoceros';
export const LAUNCH_FILENAME = 'launch.json';

/** How deep under `projects/` an app (a dir with `.monoceros/launch.json`) may sit. */
const APP_SEARCH_MAX_DEPTH = 4;

/**
 * Host-side path to an app's launch config. The container workspace root
 * `/workspaces/<name>` is the host dir `<home>/container/<name>` (bind mount),
 * so a host-side read sees exactly what the in-container runner writes.
 */
export function launchConfigPath(
  name: string,
  appRel: string,
  home?: string,
): string {
  return path.join(
    containerDir(name, home),
    'projects',
    appRel,
    LAUNCH_DIRNAME,
    LAUNCH_FILENAME,
  );
}

function validate(parsed: unknown, where: string): LaunchConfig {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${where}: expected a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.configurations)) {
    throw new Error(`${where}: missing "configurations" array`);
  }
  const seen = new Set<string>();
  const configurations: LaunchTarget[] = obj.configurations.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`${where}: configuration #${i} is not an object`);
    }
    const t = raw as Record<string, unknown>;
    if (typeof t.name !== 'string' || t.name.length === 0) {
      throw new Error(`${where}: configuration #${i} is missing "name"`);
    }
    if (seen.has(t.name)) {
      throw new Error(`${where}: duplicate target name "${t.name}"`);
    }
    seen.add(t.name);
    if (typeof t.command !== 'string' || t.command.length === 0) {
      throw new Error(`${where}: target "${t.name}" is missing "command"`);
    }
    return {
      name: t.name,
      command: t.command,
      ...(typeof t.cwd === 'string' ? { cwd: t.cwd } : {}),
      ...(typeof t.port === 'number' ? { port: t.port } : {}),
      ...(t.env && typeof t.env === 'object'
        ? { env: t.env as Record<string, string> }
        : {}),
      ...(t.default === true ? { default: true } : {}),
    };
  });
  return {
    version: typeof obj.version === 'number' ? obj.version : 1,
    configurations,
  };
}

/**
 * Read and validate an app's launch config. Returns `undefined` when the file
 * doesn't exist (the app simply has no declared launch config); throws with a
 * descriptive message when the file is present but malformed.
 */
export async function readLaunchConfig(
  name: string,
  appRel: string,
  home?: string,
): Promise<LaunchConfig | undefined> {
  const file = launchConfigPath(name, appRel, home);
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `${file}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return validate(parsed, file);
}

/** The targets started when `--target` is omitted, in declared order. */
export function defaultTargets(config: LaunchConfig): LaunchTarget[] {
  const marked = config.configurations.filter((t) => t.default);
  if (marked.length > 0) return marked;
  // No explicit default: the sole target is the implicit one.
  return config.configurations.length === 1 ? config.configurations : [];
}

/**
 * Pick a SINGLE target - for callers that act on exactly one (e.g. `logs`).
 * With a name, returns that target (or throws if it doesn't exist). Without a
 * name, resolves the default only when it is unambiguous (one default, or a
 * sole target); a multi-target default set throws asking for `--target`.
 */
export function resolveTarget(
  config: LaunchConfig,
  targetName: string | undefined,
  appRel: string,
): LaunchTarget {
  if (targetName) {
    const found = config.configurations.find((t) => t.name === targetName);
    if (!found) {
      throw new Error(
        `No target "${targetName}" in ${appRel} (have: ${config.configurations.map((t) => t.name).join(', ') || 'none'})`,
      );
    }
    return found;
  }
  const defaults = defaultTargets(config);
  if (defaults.length === 1) return defaults[0]!;
  const names = config.configurations.map((t) => t.name).join(', ');
  throw new Error(
    defaults.length === 0
      ? `${appRel} has ${config.configurations.length} targets and no default: pass --target (${names})`
      : `${appRel} has multiple default targets: pass --target to pick one (${defaults.map((t) => t.name).join(', ')})`,
  );
}

/**
 * App-relative paths under `projects/` that carry a `.monoceros/launch.json`.
 * Pure host-side filesystem walk (works with the container stopped), mirroring
 * how completion already reads `container/<name>/projects/`.
 */
export async function listApps(name: string, home?: string): Promise<string[]> {
  const projectsRoot = path.join(containerDir(name, home), 'projects');
  const out: string[] = [];

  async function walk(at: string, rel: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    // An app is a dir that contains .monoceros/launch.json.
    const hasLaunch = entries.some(
      (e) => e.isDirectory() && e.name === LAUNCH_DIRNAME,
    );
    if (hasLaunch) {
      try {
        await fs.access(path.join(at, LAUNCH_DIRNAME, LAUNCH_FILENAME));
        if (rel) out.push(rel);
      } catch {
        // .monoceros without a launch.json — not an app for our purposes.
      }
    }
    if (depth >= APP_SEARCH_MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      await walk(
        path.join(at, e.name),
        rel ? `${rel}/${e.name}` : e.name,
        depth + 1,
      );
    }
  }

  await walk(projectsRoot, '', 0);
  return out.sort();
}
