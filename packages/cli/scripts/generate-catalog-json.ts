// Generate the public component catalog as JSON, written to the checkout
// root as `catalog.json`. This file is COMMITTED (unlike the feature
// manifests) so it is served straight from the repo via
// raw.githubusercontent.com — the URL the Monoceros onboarding skill fetches
// to learn the current languages/services/features without a memorized list.
//
// Source of truth is the same descriptor catalog the CLI uses; the projection
// lives in src/catalog/catalog-json.ts. The `cliVersion` stamp is read from
// packages/cli/package.json so a committed catalog.json always says which CLI
// release it reflects — keep regenerating it as part of a release so the
// published catalog never runs ahead of the CLI users actually have.
//
// Run with tsx: `pnpm --filter @getmonoceros/workbench catalog:json`.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { buildCatalogJson } from '../src/catalog/catalog-json.js';

// scripts/ -> packages/cli -> packages -> <checkout root>
const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const checkoutRoot = path.resolve(cliRoot, '..', '..');
const componentsRoot = path.join(checkoutRoot, 'components');

const pkg = JSON.parse(
  await readFile(path.join(cliRoot, 'package.json'), 'utf8'),
) as { version: string };

const catalog = await loadDescriptorCatalog(componentsRoot);
const doc = buildCatalogJson(catalog, pkg.version);

const dest = path.join(checkoutRoot, 'catalog.json');
await writeFile(dest, JSON.stringify(doc, null, 2) + '\n', 'utf8');

console.log(
  `[generate-catalog-json] ${path.relative(checkoutRoot, dest)} ` +
    `(cliVersion ${doc.cliVersion}; ${doc.languages.length} languages, ` +
    `${doc.services.length} services, ${doc.features.length} features)`,
);
