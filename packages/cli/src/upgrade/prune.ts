import {
  type BuiltImageRecord,
  readMachineState,
  writeMachineState,
} from '../config/machine-state.js';
import { type DockerExec } from '../proxy/index.js';
import { spawnDocker } from '../devcontainer/compose.js';
import { removeImage } from '../devcontainer/images.js';

/**
 * Split the built-image registry into images to keep vs. prune. Pure — no
 * docker, no IO — so the policy is testable in isolation.
 *
 * Rules (ADR 0018):
 *   - A container that still exists keeps its NEWEST image (the one a fresh
 *     apply/up would use); older builds of it are stale.
 *   - A container that no longer exists (removed since it was recorded) has
 *     ALL its images stale.
 *
 * Only registry entries are ever considered — a foreign `vsc-*` image
 * Monoceros never recorded is never a candidate.
 */
export function selectStaleImages(
  registry: readonly BuiltImageRecord[],
  currentContainerNames: ReadonlySet<string>,
): { stale: BuiltImageRecord[]; keep: BuiltImageRecord[] } {
  const byContainer = new Map<string, BuiltImageRecord[]>();
  for (const rec of registry) {
    const list = byContainer.get(rec.container) ?? [];
    list.push(rec);
    byContainer.set(rec.container, list);
  }

  const stale: BuiltImageRecord[] = [];
  const keep: BuiltImageRecord[] = [];
  for (const [container, records] of byContainer) {
    if (!currentContainerNames.has(container)) {
      stale.push(...records);
      continue;
    }
    // Newest builtAt wins (ISO-8601 sorts lexicographically).
    const sorted = [...records].sort((a, b) =>
      a.builtAt < b.builtAt ? 1 : a.builtAt > b.builtAt ? -1 : 0,
    );
    keep.push(sorted[0]!);
    stale.push(...sorted.slice(1));
  }
  return { stale, keep };
}

export interface PruneResult {
  removed: number;
  attempted: number;
}

/**
 * Remove stale Monoceros-built images and update the registry. Each removal is
 * best-effort: an image still in use (or an unreachable docker) is left
 * tracked and retried next time; images that are gone (removed or already
 * absent) drop out of the registry.
 */
export async function pruneStaleImages(opts: {
  home: string;
  currentContainerNames: ReadonlySet<string>;
  exec?: DockerExec;
  logger?: { info: (m: string) => void };
}): Promise<PruneResult> {
  const exec = opts.exec ?? spawnDocker;
  const state = await readMachineState(opts.home);
  const registry = state.builtImages ?? [];
  const { stale, keep } = selectStaleImages(
    registry,
    opts.currentContainerNames,
  );

  const survivors = [...keep];
  let removed = 0;
  for (const rec of stale) {
    const outcome = await removeImage(rec.imageId, exec);
    if (outcome === 'removed') {
      removed += 1;
    } else if (outcome === 'absent') {
      // gone already — just forget it
    } else {
      // in-use or error → keep tracking, retry next prune
      survivors.push(rec);
    }
  }

  state.builtImages = survivors;
  await writeMachineState(state, opts.home);

  if (removed > 0) {
    opts.logger?.info(
      `Pruned ${removed} stale Monoceros image${removed === 1 ? '' : 's'}.`,
    );
  }
  return { removed, attempted: stale.length };
}
