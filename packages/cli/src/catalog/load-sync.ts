import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { componentsRootDir, userTemplatesDir } from '../config/paths.js';
import {
  CATEGORY_DIRS,
  addUnique,
  applyOverlay,
  parseDescriptorFile,
  parseOwnService,
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
  rootDir?: string,
  userDir?: string,
): Map<string, CatalogComponent> {
  const out = walkTreeSync(rootDir ?? componentsRootDir());
  const overlayDir = rootDir === undefined ? userTemplatesDir() : userDir;
  if (overlayDir) applyOverlay(out, walkOwnServicesSync(overlayDir));
  return out;
}

function walkTreeSync(rootDir: string): Map<string, CatalogComponent> {
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
      addUnique(
        out,
        parseDescriptorFile(
          readFileSync(sourcePath, 'utf8'),
          sourcePath,
          id,
          category,
        ),
      );
    }
  }
  return out;
}

/** Sync twin of `walkOwnServices`: `<templatesDir>/services/<id>.yml`. */
function walkOwnServicesSync(
  templatesDir: string,
): Map<string, CatalogComponent> {
  const out = new Map<string, CatalogComponent>();
  const dir = path.join(templatesDir, 'services');
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yml')) continue;
    const sourcePath = path.join(dir, entry.name);
    addUnique(
      out,
      parseOwnService(readFileSync(sourcePath, 'utf8'), sourcePath, entry.name),
    );
  }
  return out;
}
