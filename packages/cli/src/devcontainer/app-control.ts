import { promises as fs } from 'node:fs';
import path from 'node:path';
import { containerDir } from '../config/paths.js';
import {
  findRunningContainerByLocalFolder,
  realContainerExec,
  type ContainerExec,
  type DockerLookupExec,
} from './locate-running.js';

/**
 * Host-side bridge to the in-container `monoceros-ctl` runner. `monoceros
 * start/stop/logs <name> <app>` is just a `docker exec` onto that script —
 * the start/stop mechanics live in one place (the runner), not duplicated
 * here. See images/runtime/monoceros-ctl.sh.
 */

export interface AppCtlOptions {
  /** Injected in tests. */
  docker?: DockerLookupExec;
  exec?: ContainerExec;
}

/**
 * Resolve the running container for `name`, returning its id or `null` when
 * it isn't up. `null` is the normal "not running yet" signal.
 */
export function findRunningContainer(
  name: string,
  opts: AppCtlOptions = {},
): Promise<string | null> {
  return findRunningContainerByLocalFolder(containerDir(name), {
    ...(opts.docker ? { docker: opts.docker } : {}),
  });
}

/**
 * Exec `monoceros-ctl <ctlArgs>` inside the running container and return its
 * exit code. Throws (with an actionable hint) when the container isn't up —
 * callers that want to auto-start it should bring it up first.
 */
export async function runAppCtl(
  name: string,
  ctlArgs: readonly string[],
  opts: AppCtlOptions = {},
): Promise<number> {
  const id = await findRunningContainer(name, opts);
  if (!id) {
    throw new Error(
      `Container "${name}" is not running. Run \`monoceros start ${name}\` first.`,
    );
  }
  const exec = opts.exec ?? realContainerExec;
  const result = await exec(id, ['monoceros-ctl', ...ctlArgs]);
  return result.exitCode;
}

/**
 * Whether any app target is "wanted" - i.e. was started and not cleanly
 * stopped. The presence of a `.monoceros/run/<app>/<target>.pid` file is that
 * marker (written by `start`, removed only by an explicit `stop`); see
 * monoceros-ctl + ADR 0028. Read host-side off the bind mount so `apply` can
 * skip the in-container `reconcile` (and its header) entirely when there is
 * nothing to restore - the common case. The pid contents are irrelevant here;
 * after a recreate they are stale anyway, the file's presence is the signal.
 */
export async function hasWantedApps(
  name: string,
  home?: string,
): Promise<boolean> {
  const runRoot = path.join(containerDir(name, home), '.monoceros', 'run');

  async function anyPid(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (await anyPid(path.join(dir, e.name))) return true;
      } else if (e.isFile() && e.name.endsWith('.pid')) {
        return true;
      }
    }
    return false;
  }

  return anyPid(runRoot);
}

/** Build the `monoceros-ctl` argv for an app subcommand, appending `--target` when set. */
export function ctlArgs(
  sub: string,
  app: string,
  target: string | undefined,
  extra: readonly string[] = [],
): string[] {
  return [sub, app, ...(target ? ['--target', target] : []), ...extra];
}
