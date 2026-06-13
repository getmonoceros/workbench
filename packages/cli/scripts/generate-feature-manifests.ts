// Generate each feature's devcontainer-feature.json from its component.yml
// descriptor (ADR 0020), written beside it under components/features/<id>/.
//
// The manifest is a build artifact, never hand-written and not committed: the
// CLI derives all manifest data from the descriptor at runtime, and the
// devcontainer build generates it on the fly. This script materializes the
// files only where a real devcontainer-feature.json is required on disk —
// the GHCR publish in release-features.yml (which packages each feature dir).
//
// Run with tsx: `pnpm --filter @getmonoceros/workbench manifests:generate`.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { descriptorToFeatureManifest } from '../src/catalog/generate-manifest.js';

// scripts/ -> packages/cli -> packages -> <checkout root>
const checkoutRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const componentsRoot = path.join(checkoutRoot, 'components');

const catalog = await loadDescriptorCatalog(componentsRoot);
let count = 0;
for (const component of catalog.values()) {
  if (component.category !== 'feature') continue;
  const manifest = descriptorToFeatureManifest(component.descriptor);
  // component.sourcePath = components/features/<id>/component.yml
  const dest = path.join(
    path.dirname(component.sourcePath),
    'devcontainer-feature.json',
  );
  await writeFile(dest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  count++;
  console.log(
    `[generate-feature-manifests] ${component.id} -> ${path.relative(checkoutRoot, dest)}`,
  );
}
console.log(`[generate-feature-manifests] generated ${count} manifest(s)`);
