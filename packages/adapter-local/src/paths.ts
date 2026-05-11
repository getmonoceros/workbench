import path from 'node:path';

import type { ItemKind } from '@monoceros/core';

const ROOT = '.monoceros';

const KIND_DIRS: Record<ItemKind, string> = {
  finding: 'findings',
  concern: 'concerns',
  risk: 'risks',
};

export const ITERATIONS_DIR = 'iterations';

export function kindDir(solutionRoot: string, kind: ItemKind): string {
  return path.join(solutionRoot, ROOT, KIND_DIRS[kind]);
}

export function iterationsDir(solutionRoot: string): string {
  return path.join(solutionRoot, ROOT, ITERATIONS_DIR);
}

export function itemFilePath(
  solutionRoot: string,
  kind: ItemKind,
  id: string,
): string {
  return path.join(kindDir(solutionRoot, kind), `${id}.md`);
}

export function iterationFilePath(solutionRoot: string, id: string): string {
  return path.join(iterationsDir(solutionRoot), `${id}.json`);
}
