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
const WORKBENCH_MARKER = path.join('templates', 'monoceros-config.sample.yml');
const CHECKOUT_MARKER = 'pnpm-workspace.yaml';

let cachedWorkbenchRoot: string | null = null;
let cachedMonocerosHome: string | null = null;
let cachedCheckoutRoot: string | null | undefined = undefined;

/**
 * Walk upwards from this module until we find the CLI-bundle marker
 * (`templates/monoceros-config.sample.yml`, shipped in the npm tarball and
 * present in the dev `packages/cli`). In dev that hits the package root
 * reliably; in production it's the installed package dir.
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

/**
 * Walk upwards from this module to find the workbench checkout root,
 * marked by `pnpm-workspace.yaml`. Distinct from `workbenchRoot()`:
 *
 *   - `workbenchRoot()` returns where the **CLI bundle** lives —
 *     `packages/cli/` in dev, the installed package directory in prod.
 *   - `workbenchCheckoutRoot()` returns where the **full workbench
 *     checkout** lives. Only meaningful in dev; returns `null` in
 *     prod (the marker doesn't ship with the npm package).
 *
 * Used by features like the dev-only local-source-fallback in
 * `resolveFeatures`, where we want to look at `images/features/<name>/`
 * at the checkout root — not inside the CLI package, where that
 * directory deliberately doesn't exist.
 */
export function workbenchCheckoutRoot(): string | null {
  if (cachedCheckoutRoot !== undefined) return cachedCheckoutRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(path.join(dir, CHECKOUT_MARKER))) {
      cachedCheckoutRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      cachedCheckoutRoot = null;
      return null;
    }
    dir = parent;
  }
}

/** Reset cached lookups. Test-only. */
export function _resetPathCachesForTests(): void {
  cachedWorkbenchRoot = null;
  cachedMonocerosHome = null;
  cachedCheckoutRoot = undefined;
}

// ─── CLI-bundle paths ─────────────────────────────────────────────

/**
 * `components/` — the unified component-descriptor tree (ADR 0020), one
 * `component.yml` per language/service/feature, the single source for the
 * catalog, the generated feature manifests, and the briefing. Prefers the
 * checkout-root copy (dev, so edits are picked up immediately) and falls back
 * to the package-local bundled copy (prod) under `bundled-components/`,
 * produced by `pnpm components:sync`.
 */
export function componentsRootDir(): string {
  const checkout = workbenchCheckoutRoot();
  if (checkout) {
    const inCheckout = path.join(checkout, 'components');
    if (existsSync(inCheckout)) return inCheckout;
  }
  return path.join(workbenchRoot(), 'bundled-components');
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

/**
 * Per-container env file holding values for `${VAR}` references in the
 * yml (service secrets etc.). Lives beside `<name>.yml`, gitignored.
 */
export function containerEnvPath(
  name: string,
  home: string = monocerosHome(),
): string {
  return path.join(containerConfigsDir(home), `${name}.env`);
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

/**
 * Per-container log directory — receives `apply-<name>-<ISO>.log` and
 * (future) audit logs for other lifecycle commands. Goes away with
 * `monoceros remove`. See ADR 0013.
 */
export function containerLogsDir(
  name: string,
  home: string = monocerosHome(),
): string {
  return path.join(containerDir(name, home), 'logs');
}

export function monocerosConfigPath(home: string = monocerosHome()): string {
  return path.join(home, 'monoceros-config.yml');
}

// ─── User-facing path formatting ─────────────────────────────────

/**
 * Format an absolute path for printing in CLI output: collapses a
 * `$HOME` prefix to `~` so messages stay short without losing
 * information. Non-home paths pass through verbatim.
 *
 *   prettyPath('/Users/x/.monoceros/container-configs/hello.yml')
 *     → '~/.monoceros/container-configs/hello.yml'
 *
 * Use this whenever a log line tells the user where something
 * landed on disk — `monoceros init`, `apply`, `remove`, `restore`
 * all rely on it so users see one consistent format.
 */
export function prettyPath(p: string): string {
  const home = os.homedir();
  if (!home) return p;
  if (p === home) return '~';
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (p.startsWith(prefix)) {
    return '~' + path.sep + p.slice(prefix.length);
  }
  return p;
}
