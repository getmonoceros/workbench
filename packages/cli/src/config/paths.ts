import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Path helpers for the M2.5 Phase 3 yml-profile model.
 *
 * Two distinct roots:
 *
 *   - `workbenchRoot()` — where the **CLI bundle** lives. In dev that's
 *     the monoceros-workbench checkout (so `templates/yml/` is reachable
 *     and the workbench can be bind-mounted into generated containers
 *     as `/opt/monoceros-workbench`). In prod (post-M4) this is the
 *     installed package directory.
 *
 *   - `monocerosHome()` — where **user data** lives: container-configs,
 *     materialized containers, the global `monoceros-config.yml`.
 *
 * The two used to be conflated under one `workbenchRoot()`; splitting
 * them is what lets `monoceros apply <name>` resolve a fixed
 * `<MONOCEROS_HOME>/container/<name>/` location without any cwd
 * magic, while the CLI itself still knows where its bundled templates
 * live.
 *
 * Layout under `<MONOCEROS_HOME>/`:
 *   container-configs/<name>.yml          ← yml-Profile (`monoceros init`)
 *   container/<name>/                     ← materialized dev-containers
 *   monoceros-config.yml                  ← optional, user-edited defaults
 *   monoceros-config.sample.yml           ← marker (in dev) + template (in prod)
 */

const MONOCEROS_HOME_MARKER = 'monoceros-config.sample.yml';
const WORKBENCH_MARKER = path.join('templates', 'components', 'README.md');

let cachedWorkbenchRoot: string | null = null;
let cachedMonocerosHome: string | null = null;

/**
 * Walk upwards from this module until we find the workbench checkout's
 * marker (`templates/components/README.md`). In dev that hits the
 * workbench root reliably; in production the file does not exist
 * outside the shipped CLI package, so callers that need a workbench
 * root for dev-only purposes (bind-mounting `/opt/monoceros-workbench`)
 * get a clear error.
 */
export function workbenchRoot(): string {
  if (cachedWorkbenchRoot) return cachedWorkbenchRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(path.join(dir, WORKBENCH_MARKER))) {
      cachedWorkbenchRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate the monoceros workbench checkout (no ${WORKBENCH_MARKER} found by walking up). Run the CLI from a workbench checkout.`,
      );
    }
    dir = parent;
  }
}

/**
 * Resolve `MONOCEROS_HOME` (where user data lives):
 *
 *   1. Honor the `MONOCEROS_HOME` env-var if set.
 *   2. Walk upwards from this module and accept the first
 *      `<dir>/.local/monoceros-config.sample.yml` we find; the
 *      containing `<dir>/.local` is treated as the home. This is the
 *      dev-workbench detection path.
 *   3. Fall back to `~/.monoceros`.
 *
 * Caches the result for the lifetime of the process — flip `force` to
 * recompute (tests do this between cases).
 */
export function monocerosHome(opts: { force?: boolean } = {}): string {
  if (!opts.force && cachedMonocerosHome) return cachedMonocerosHome;

  const fromEnv = process.env.MONOCEROS_HOME;
  if (fromEnv && fromEnv.length > 0) {
    cachedMonocerosHome = path.resolve(fromEnv);
    return cachedMonocerosHome;
  }

  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(dir, '.local');
    if (existsSync(path.join(candidate, MONOCEROS_HOME_MARKER))) {
      cachedMonocerosHome = candidate;
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedMonocerosHome = path.join(os.homedir(), '.monoceros');
  return cachedMonocerosHome;
}

/** Reset cached lookups. Test-only. */
export function _resetPathCachesForTests(): void {
  cachedWorkbenchRoot = null;
  cachedMonocerosHome = null;
}

// ─── CLI-bundle paths (templates) ─────────────────────────────────

/**
 * `templates/components/` — the components catalog used by
 * `monoceros init`. Each file under this directory is a small yml
 * snippet describing one composable component (a language, a
 * service, or a feature). See `templates/components/README.md`.
 */
export function componentsDir(root: string = workbenchRoot()): string {
  return path.join(root, 'templates', 'components');
}

// ─── User-home paths (configs, containers, global config) ────────

export function containerConfigsDir(home: string = monocerosHome()): string {
  return path.join(home, 'container-configs');
}

export function containerConfigPath(
  name: string,
  home: string = monocerosHome(),
): string {
  return path.join(containerConfigsDir(home), `${name}.yml`);
}

export function containersDir(home: string = monocerosHome()): string {
  return path.join(home, 'container');
}

export function containerDir(
  name: string,
  home: string = monocerosHome(),
): string {
  return path.join(containersDir(home), name);
}

export function monocerosConfigPath(home: string = monocerosHome()): string {
  return path.join(home, 'monoceros-config.yml');
}
