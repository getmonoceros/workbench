import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import type {
  AppendConcernInput,
  AppendFindingInput,
  AppendIterationInput,
  AppendRiskInput,
  FindingStatus,
  FindingsStore,
  FindingsStoreItem,
  ItemKind,
  TriageStatus,
} from '@monoceros/core';

import { parseFile, stringifyFile } from './frontmatter.js';
import {
  iterationFilePath,
  iterationsDir,
  itemFilePath,
  kindDir,
} from './paths.js';
import { makeItemId, slugify } from './slug.js';

export interface LocalFindingsStoreOptions {
  solutionRoot: string;
  /** Injectable clock for deterministic tests. */
  clock?: () => Date;
  /** Injectable random suffix for deterministic ids in tests. */
  randomSuffix?: () => string;
}

function defaultRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

export function createLocalFindingsStore(
  options: LocalFindingsStoreOptions,
): FindingsStore {
  const clock = options.clock ?? (() => new Date());
  const randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
  const root = options.solutionRoot;

  async function writeItem(
    kind: ItemKind,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<string> {
    const id = frontmatter.id as string;
    const dir = kindDir(root, kind);
    await mkdir(dir, { recursive: true });
    await writeFile(
      itemFilePath(root, kind, id),
      stringifyFile(frontmatter, body),
      'utf8',
    );
    return id;
  }

  async function loadItemsForKind(
    kind: ItemKind,
  ): Promise<FindingsStoreItem[]> {
    const dir = kindDir(root, kind);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const mdNames = names.filter((n) => n.endsWith('.md'));
    const items: FindingsStoreItem[] = [];
    for (const name of mdNames) {
      const id = name.replace(/\.md$/, '');
      const item = await loadItem(kind, id);
      if (item !== null) items.push(item);
    }
    return items.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function loadItem(
    kind: ItemKind,
    id: string,
  ): Promise<FindingsStoreItem | null> {
    let content: string;
    try {
      content = await readFile(itemFilePath(root, kind, id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const { frontmatter, body } = parseFile(content);
    return {
      id,
      kind,
      status: (frontmatter.status as FindingStatus) ?? 'open',
      sourceIteration: String(frontmatter.sourceIteration ?? ''),
      createdAt: String(frontmatter.createdAt ?? ''),
      frontmatter,
      body,
    };
  }

  return {
    async appendIteration(input: AppendIterationInput): Promise<string> {
      const now = clock();
      const id = `${makeItemId(now, randomSuffix(), 'iter')}`;
      const dir = iterationsDir(root);
      await mkdir(dir, { recursive: true });
      const payload = {
        id,
        createdAt: now.toISOString(),
        userPrompt: input.userPrompt,
        plan: input.plan ?? null,
        generatorReport: input.generatorReport ?? null,
        reviewReport: input.reviewReport ?? null,
        sessions: input.sessions ?? null,
        rewound: input.rewound ?? false,
        failedPhase: input.failedPhase ?? null,
        errorSummary: input.errorSummary ?? null,
      };
      await writeFile(
        iterationFilePath(root, id),
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      );
      return id;
    },

    async appendFinding(input: AppendFindingInput): Promise<string> {
      const now = clock();
      const slug = slugify(input.finding.message);
      const id = makeItemId(now, randomSuffix(), slug);
      const frontmatter: Record<string, unknown> = {
        id,
        kind: 'finding',
        status: 'open',
        sourceIteration: input.sourceIteration,
        createdAt: now.toISOString(),
        category: input.finding.category,
        severity: input.finding.severity,
        blocking: input.finding.blocking,
      };
      if (input.finding.file !== undefined)
        frontmatter.file = input.finding.file;
      if (input.finding.line !== undefined)
        frontmatter.line = input.finding.line;
      if (input.finding.suggestion !== undefined) {
        frontmatter.suggestion = input.finding.suggestion;
      }
      return writeItem('finding', frontmatter, input.finding.message);
    },

    async appendConcern(input: AppendConcernInput): Promise<string> {
      const now = clock();
      const slug = slugify(input.text);
      const id = makeItemId(now, randomSuffix(), slug);
      const frontmatter: Record<string, unknown> = {
        id,
        kind: 'concern',
        status: 'open',
        sourceIteration: input.sourceIteration,
        createdAt: now.toISOString(),
      };
      if (input.confidence !== undefined) {
        frontmatter.confidence = input.confidence;
      }
      return writeItem('concern', frontmatter, input.text);
    },

    async appendRisk(input: AppendRiskInput): Promise<string> {
      const now = clock();
      const slug = slugify(input.description);
      const id = makeItemId(now, randomSuffix(), slug);
      const frontmatter: Record<string, unknown> = {
        id,
        kind: 'risk',
        status: 'open',
        sourceIteration: input.sourceIteration,
        createdAt: now.toISOString(),
        severity: input.severity,
      };
      return writeItem('risk', frontmatter, input.description);
    },

    async listOpen(): Promise<FindingsStoreItem[]> {
      const items = await this.listAll();
      return items.filter((i) => i.status === 'open');
    },

    async listAll(): Promise<FindingsStoreItem[]> {
      const kinds: ItemKind[] = ['finding', 'concern', 'risk'];
      const groups = await Promise.all(kinds.map(loadItemsForKind));
      return groups.flat();
    },

    async markStatus(id: string, status: TriageStatus): Promise<void> {
      const item = await this.get(id);
      if (item === null) {
        throw new Error(`item not found: ${id}`);
      }
      const updated = { ...item.frontmatter, status };
      const filepath = itemFilePath(root, item.kind, id);
      await writeFile(filepath, stringifyFile(updated, item.body), 'utf8');
    },

    async get(id: string): Promise<FindingsStoreItem | null> {
      const kinds: ItemKind[] = ['finding', 'concern', 'risk'];
      for (const kind of kinds) {
        const item = await loadItem(kind, id);
        if (item !== null) return item;
      }
      return null;
    },
  };
}
