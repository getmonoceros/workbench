import type { FindingsStore } from '@monoceros/core';

export const MANUAL_ITERATION_ID = 'manual';

export async function deferConcern(
  store: FindingsStore,
  text: string,
): Promise<string> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('Concern text must not be empty.');
  }
  return store.appendConcern({
    sourceIteration: MANUAL_ITERATION_ID,
    text: trimmed,
  });
}
