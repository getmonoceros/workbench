#!/usr/bin/env node
//
// Copy the workbench's `components/` tree (the unified component
// descriptors, ADR 0020) into `packages/cli/components/` so the CLI can
// read them after a global npm install.
//
// Why this exists:
//   - `components/<category>/<id>/component.yml` is the single source of
//     truth for every catalog component (languages, services, features).
//   - The tree lives at the workbench checkout root. The npm package only
//     ships `packages/cli/`, so without this copy the production CLI has
//     no descriptor data and the catalog is empty.
//
// When this runs:
//   - As `pnpm components:sync` (manual / dev).
//   - As part of the `prebuild` step of `pnpm build`, so a CI publish
//     always ships a fresh copy.
//
// The destination is gitignored — the source of truth stays at
// `<checkout>/components/`. Resolution at runtime prefers the checkout
// (dev) and falls back to this bundled copy (prod); see
// `config/paths.ts#componentsRootDir`.
import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const checkoutRoot = path.resolve(pkgRoot, '..', '..');
const srcDir = path.join(checkoutRoot, 'components');
const destDir = path.join(pkgRoot, 'components');

if (!existsSync(srcDir)) {
  console.error(`[sync-components] source dir not found: ${srcDir}`);
  console.error(
    `[sync-components] expected to run from inside the workbench checkout`,
  );
  process.exit(1);
}

// Wipe first so removals at the source propagate (no stale orphans).
if (existsSync(destDir)) {
  await rm(destDir, { recursive: true });
}
await cp(srcDir, destDir, { recursive: true });
console.log(`[sync-components] synced components/ -> ${path.relative(checkoutRoot, destDir)}`);
