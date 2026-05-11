import type { FindingsStore, TriageStatus } from '@monoceros/core';

const VALID_STATUSES: readonly TriageStatus[] = [
  'jetzt',
  'später',
  'verworfen',
];

export function parseTriageStatus(value: string): TriageStatus {
  if ((VALID_STATUSES as readonly string[]).includes(value)) {
    return value as TriageStatus;
  }
  throw new Error(
    `Invalid triage status "${value}". Use one of: ${VALID_STATUSES.join(', ')}.`,
  );
}

export async function triageItem(
  store: FindingsStore,
  id: string,
  status: TriageStatus,
): Promise<string> {
  const before = await store.get(id);
  if (before === null) {
    throw new Error(`Item not found: ${id}`);
  }
  await store.markStatus(id, status);
  return `${id} marked as ${status} (was ${before.status}).`;
}
