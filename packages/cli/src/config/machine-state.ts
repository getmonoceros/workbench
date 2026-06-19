import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';
import { monocerosHome } from './paths.js';

/**
 * Machine-global Monoceros state, distinct from per-container
 * `.monoceros/state.json`. Lives at `<MONOCEROS_HOME>/.machine-state.json`.
 * Holds:
 *   - `lastUpgradeAt`: when `monoceros upgrade` last completed successfully —
 *     read by `apply` to nudge when tooling has gone stale (ADR 0018).
 *   - `builtImages`: the registry of images Monoceros has built. Only images
 *     recorded here are ever candidates for the `upgrade` prune, so a prune
 *     can never touch a foreign (non-Monoceros) `vsc-*` image. Images built
 *     before this registry existed are simply absent → never pruned ("let the
 *     past be the past").
 *
 * Machine-local and auto-managed; not meant to be hand-edited.
 */
export interface BuiltImageRecord {
  /** Docker image id (sha256:…) Monoceros built for a container. */
  imageId: string;
  /** Container name the image was built for. */
  container: string;
  /** ISO-8601 timestamp the build was recorded. */
  builtAt: string;
}

export interface MachineState {
  lastUpgradeAt?: string;
  builtImages?: BuiltImageRecord[];
  /**
   * The latest `@getmonoceros/workbench` version seen on npm, cached by the
   * background update check so commands can show an update notice without a
   * network call on the hot path. See update/notifier.ts.
   */
  latestVersion?: string;
  /** ISO-8601 instant the update check last ran (success OR failure). */
  lastVersionCheckAt?: string;
}

/** Default staleness threshold (days) for the `apply` upgrade nudge. */
export const DEFAULT_UPGRADE_STALE_DAYS = 30;

export function machineStatePath(home: string = monocerosHome()): string {
  return path.join(home, '.machine-state.json');
}

/** Read machine state. Missing or malformed file → empty state (never throws). */
export async function readMachineState(
  home: string = monocerosHome(),
): Promise<MachineState> {
  try {
    const raw = await fsp.readFile(machineStatePath(home), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as MachineState;
    }
  } catch {
    // ENOENT or malformed — treat as empty.
  }
  return {};
}

/**
 * Synchronous read for the hot path (the update notice is decided at CLI
 * startup, before any await, and printed in a sync `process.on('exit')`
 * handler). Missing or malformed file → empty state (never throws).
 */
export function readMachineStateSync(
  home: string = monocerosHome(),
): MachineState {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(machineStatePath(home), 'utf8'),
    );
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as MachineState;
    }
  } catch {
    // ENOENT or malformed — treat as empty.
  }
  return {};
}

export async function writeMachineState(
  state: MachineState,
  home: string = monocerosHome(),
): Promise<void> {
  await fsp.writeFile(
    machineStatePath(home),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/** Record an image Monoceros just built (dedup by imageId, keep newest). */
export async function recordBuiltImage(
  record: BuiltImageRecord,
  home: string = monocerosHome(),
): Promise<void> {
  const state = await readMachineState(home);
  const rest = (state.builtImages ?? []).filter(
    (r) => r.imageId !== record.imageId,
  );
  state.builtImages = [...rest, record];
  await writeMachineState(state, home);
}

/**
 * Record an update check. Always stamps `lastVersionCheckAt` (so a failed
 * fetch still backs off the interval instead of re-spawning every command);
 * updates `latestVersion` only when a version was actually fetched. Merges
 * into existing state, never clobbering builtImages / lastUpgradeAt.
 */
export async function recordVersionCheck(
  opts: { latestVersion?: string; nowIso: string },
  home: string = monocerosHome(),
): Promise<void> {
  const state = await readMachineState(home);
  state.lastVersionCheckAt = opts.nowIso;
  if (opts.latestVersion) state.latestVersion = opts.latestVersion;
  await writeMachineState(state, home);
}

/** Mark a successful `upgrade` at the given ISO instant. */
export async function markUpgraded(
  nowIso: string,
  home: string = monocerosHome(),
): Promise<void> {
  const state = await readMachineState(home);
  state.lastUpgradeAt = nowIso;
  await writeMachineState(state, home);
}

/** Whole days between two ISO instants (floored, never negative). */
export function daysBetween(fromIso: string, now: Date): number {
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return 0;
  const ms = now.getTime() - from;
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * The staleness nudge `apply` should print, or null when none is due.
 * Returns null when an upgrade ran within `thresholdDays`. When no upgrade has
 * ever run, we do NOT nag (a freshly-built container is current by definition);
 * the nudge is only for tooling that has demonstrably gone stale since the last
 * refresh.
 */
export function upgradeNudge(
  state: MachineState,
  now: Date,
  thresholdDays: number = DEFAULT_UPGRADE_STALE_DAYS,
): string | null {
  if (!state.lastUpgradeAt) return null;
  const days = daysBetween(state.lastUpgradeAt, now);
  if (days < thresholdDays) return null;
  return `Tools last refreshed ${days} days ago. Run \`monoceros upgrade\` to update them.`;
}
