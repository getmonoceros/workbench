import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CONFIG_SCHEMA_VERSION } from './schema.js';

/**
 * `.monoceros/state.json` — the Phase-3 replacement for `stack.json`.
 *
 * The yml at `.local/container-configs/<origin>.yml` is the source
 * of truth. `state.json` is a back-reference: it tells `monoceros
 * apply` (no args) which yml to read and re-apply for this dev-
 * container. Other fields (appliedAt, cliVersion) are pure diagnostics
 * for `monoceros status` and ad-hoc debugging.
 *
 * `materializedAt` is the timestamp of the most recent apply, NOT
 * the create. There is no `createdAt` because the yml is the
 * lifecycle anchor now — multiple dev-containers can share one yml,
 * and each has its own state.json timeline.
 */
export interface StateFile {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** Config name the yml is stored under (`<origin>.yml`). */
  origin: string;
  /** Monoceros CLI version that wrote this state.json. */
  monocerosCliVersion: string;
  /** ISO-8601 timestamp of the most recent apply. */
  materializedAt: string;
  /**
   * Resolved runtime image this container was last materialized against
   * (e.g. `ghcr.io/getmonoceros/monoceros-runtime:1.1.0`) — audit for
   * the pinned-image model (ADR 0017). Optional: pre-pinning state.json
   * files won't carry it.
   */
  runtimeImage?: string;
}

export function buildStateFile(opts: {
  origin: string;
  cliVersion: string;
  runtimeImage?: string;
  now?: Date;
}): StateFile {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    origin: opts.origin,
    monocerosCliVersion: opts.cliVersion,
    materializedAt: (opts.now ?? new Date()).toISOString(),
    ...(opts.runtimeImage ? { runtimeImage: opts.runtimeImage } : {}),
  };
}

export function stateFilePath(targetDir: string): string {
  return path.join(targetDir, '.monoceros', 'state.json');
}

export async function readStateFile(
  targetDir: string,
): Promise<StateFile | undefined> {
  try {
    const content = await fs.readFile(stateFilePath(targetDir), 'utf8');
    return JSON.parse(content) as StateFile;
  } catch {
    return undefined;
  }
}

export async function writeStateFile(
  targetDir: string,
  state: StateFile,
): Promise<void> {
  const monocerosDir = path.join(targetDir, '.monoceros');
  await fs.mkdir(monocerosDir, { recursive: true });
  await fs.writeFile(
    stateFilePath(targetDir),
    JSON.stringify(state, null, 2) + '\n',
  );
}
