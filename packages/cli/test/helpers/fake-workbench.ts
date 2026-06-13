import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Test helper: write a unified component descriptor (ADR 0020) under a fake
 * workbench root at `<workbench>/components/<category>/<id>/component.yml`.
 * Mirrors the real layout the CLI reads from.
 */
export async function writeDescriptor(
  workbench: string,
  category: 'languages' | 'services' | 'features',
  id: string,
  body: string,
): Promise<void> {
  const dir = path.join(workbench, 'components', category, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'component.yml'), body, 'utf8');
}

/** Write a feature manifest under `<workbench>/images/features/<id>/`. */
export async function writeFeatureManifest(
  workbench: string,
  id: string,
  manifest: unknown,
): Promise<void> {
  const dir = path.join(workbench, 'images', 'features', id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'devcontainer-feature.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
}

/** A minimal node-language descriptor body. */
export function nodeLanguageDescriptor(): string {
  return [
    'id: node',
    'category: language',
    'displayName: Node.js',
    'description: Node runtime.',
    'language:',
    '  feature: ghcr.io/devcontainers/features/node:1',
    '  builtin: true',
    '',
  ].join('\n');
}
