#!/usr/bin/env node
//
// Copy every `images/features/<name>/devcontainer-feature.json` from
// the workbench checkout into `packages/cli/features/<name>/` so the
// init generator can read the manifest after a global npm install.
//
// Why this exists:
//   - Feature manifests are the source of truth for option lists,
//     option descriptions, and Monoceros' x-monoceros hints (e.g.
//     `optionHints`, `usageNotes` — the bits `monoceros init`
//     renders as commented suggestions in the produced yml).
//   - They live at the workbench root under `images/features/<name>/`
//     because that's where the release-features workflow expects
//     them. The npm package only sees `packages/cli/`, so without
//     this copy the production CLI has no manifest data at all and
//     init's hint-rendering silently degrades to "nothing".
//
// When this runs:
//   - As `pnpm manifests:sync` (manual / dev).
//   - As the `prebuild` step of `pnpm build` so a CI publish
//     (release-cli.yml → `npm publish` → `prepublishOnly` →
//     typecheck + test + build) always ships a fresh copy.
//
// What ends up in the package:
//   packages/cli/features/<name>/devcontainer-feature.json   (one per feature)
//
// The directory is gitignored — the source of truth stays at
// `images/features/`.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const checkoutRoot = path.resolve(pkgRoot, '..', '..');
const srcFeaturesDir = path.join(checkoutRoot, 'images', 'features');
const destFeaturesDir = path.join(pkgRoot, 'features');

if (!existsSync(srcFeaturesDir)) {
  console.error(
    `[sync-feature-manifests] source dir not found: ${srcFeaturesDir}`,
  );
  console.error(
    `[sync-feature-manifests] expected to run from inside the workbench checkout`,
  );
  process.exit(1);
}

// Wipe the bundle dir first so removals at the source propagate
// instead of leaving stale orphans behind.
if (existsSync(destFeaturesDir)) {
  await rm(destFeaturesDir, { recursive: true });
}

const entries = await readdir(srcFeaturesDir, { withFileTypes: true });
const synced = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const name = entry.name;
  const srcManifest = path.join(
    srcFeaturesDir,
    name,
    'devcontainer-feature.json',
  );
  if (!existsSync(srcManifest)) continue;

  const destDir = path.join(destFeaturesDir, name);
  await mkdir(destDir, { recursive: true });
  await copyFile(srcManifest, path.join(destDir, 'devcontainer-feature.json'));
  synced.push(name);
}

if (synced.length === 0) {
  console.warn(
    `[sync-feature-manifests] no feature manifests found under ${srcFeaturesDir}`,
  );
} else {
  console.log(
    `[sync-feature-manifests] synced ${synced.length} feature(s): ${synced.join(', ')}`,
  );
}
