import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { componentsRootDir } from '../config/paths.js';
import {
  DescriptorSchema,
  type Descriptor,
  type DescriptorCategory,
} from './descriptor.js';

/**
 * Loader for the unified component descriptors (ADR 0020). Reads the
 * `components/` tree into one in-memory model. Phase 1: additive only —
 * no consumer reads from here yet.
 *
 * Layout (category is dictated by the parent directory, then
 * cross-checked against the descriptor's own `category`):
 *
 *   components/
 *     languages/<id>/component.yml
 *     services/<id>/component.yml
 *     features/<id>/component.yml   (+ install.sh, generated json)
 */

const CATEGORY_DIRS: Readonly<Record<string, DescriptorCategory>> = {
  languages: 'language',
  services: 'service',
  features: 'feature',
};

export interface CatalogComponent {
  id: string;
  category: DescriptorCategory;
  /** Absolute path of the source `component.yml` — used in errors. */
  sourcePath: string;
  descriptor: Descriptor;
}

/**
 * Walk the `components/` tree, parse + validate every `component.yml`,
 * return an id-keyed map. Throws on the first invalid descriptor with a
 * path-anchored message — refuse rather than load an inconsistent catalog.
 *
 * Defaults to the resolved components root (checkout in dev, bundled copy
 * in prod — see `config/paths.ts#componentsRootDir`). Tests pass an
 * explicit root.
 */
export async function loadDescriptorCatalog(
  rootDir: string = componentsRootDir(),
): Promise<Map<string, CatalogComponent>> {
  const out = new Map<string, CatalogComponent>();
  if (!existsSync(rootDir)) {
    return out;
  }
  for (const [dirName, category] of Object.entries(CATEGORY_DIRS)) {
    const categoryDir = path.join(rootDir, dirName);
    if (!existsSync(categoryDir)) continue;
    const entries = await fs.readdir(categoryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const sourcePath = path.join(categoryDir, id, 'component.yml');
      if (!existsSync(sourcePath)) continue;
      const component = await loadOne(sourcePath, id, category);
      if (out.has(component.id)) {
        const first = out.get(component.id)!;
        throw new Error(
          `Duplicate component id '${component.id}': ${first.sourcePath} and ${sourcePath}.`,
        );
      }
      out.set(component.id, component);
    }
  }
  return out;
}

async function loadOne(
  sourcePath: string,
  folderId: string,
  expectedCategory: DescriptorCategory,
): Promise<CatalogComponent> {
  const text = await fs.readFile(sourcePath, 'utf8');
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(
      `Failed to parse descriptor (${sourcePath}): ${(err as Error).message}`,
    );
  }
  const parsed = DescriptorSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${where}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid descriptor (${sourcePath}):\n${issues}`);
  }
  const descriptor = parsed.data;
  if (descriptor.id !== folderId) {
    throw new Error(
      `Descriptor id '${descriptor.id}' must match its folder name '${folderId}' (${sourcePath}).`,
    );
  }
  if (descriptor.category !== expectedCategory) {
    throw new Error(
      `Descriptor '${descriptor.id}' has category '${descriptor.category}' but sits under '${expectedCategory}s/' (${sourcePath}).`,
    );
  }
  return {
    id: descriptor.id,
    category: descriptor.category,
    sourcePath,
    descriptor,
  };
}
