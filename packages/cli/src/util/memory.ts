/**
 * Memory figures in Docker's notation (`512m`, `2g`, `1.5g`), as the yml, the
 * catalog descriptors and `docker run --memory` all spell them (ADR 0062).
 *
 * The unit is required. Docker reads a bare number as bytes, so `memory: 512`
 * would be a 512-byte limit, and a container could not even start under it.
 */
export const MEMORY_RE = /^\d+(\.\d+)?[kmg]$/i;

/** Docker refuses a memory limit below 6 MiB. */
export const MIN_MEMORY_BYTES = 6 * 1024 * 1024;

const UNIT: Record<string, number> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};

/** Bytes of a figure that matches `MEMORY_RE`; `NaN` for anything else. */
export function memoryBytes(figure: string): number {
  if (!MEMORY_RE.test(figure)) return NaN;
  const unit = figure.slice(-1).toLowerCase();
  return Math.floor(Number(figure.slice(0, -1)) * UNIT[unit]!);
}

/** Bytes as a short human figure: `512 MiB`, `4 GiB`, `11.2 GiB`. */
export function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${trimNumber(gib)} GiB`;
  return `${trimNumber(bytes / 1024 ** 2)} MiB`;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
