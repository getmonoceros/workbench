import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { componentsRootDir } from '../config/paths.js';
import {
  CATEGORY_DIRS,
  parseDescriptorFile,
  type CatalogComponent,
} from './load.js';

/**
 * Synchronous twin of `loadDescriptorCatalog`. Needed by `catalog.ts`, which
 * derives the eagerly-exported LANGUAGE_CATALOG / SERVICE_CATALOG consts from
 * the descriptors at import time and therefore cannot await. Shares the same
 * parse + validation via `parseDescriptorFile`, and the same category→dir map
 * so a new category cannot land in one loader and be missing from the other.
 */

export function loadDescriptorCatalogSync(
  rootDir: string = componentsRootDir(),
): Map<string, CatalogComponent> {
  const out = new Map<string, CatalogComponent>();
  if (!existsSync(rootDir)) return out;
  for (const [dirName, category] of Object.entries(CATEGORY_DIRS)) {
    const categoryDir = path.join(rootDir, dirName);
    if (!existsSync(categoryDir)) continue;
    for (const entry of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const sourcePath = path.join(categoryDir, id, 'component.yml');
      if (!existsSync(sourcePath)) continue;
      const component = parseDescriptorFile(
        readFileSync(sourcePath, 'utf8'),
        sourcePath,
        id,
        category,
      );
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
