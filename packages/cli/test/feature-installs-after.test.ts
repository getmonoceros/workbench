import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { descriptorToFeatureManifest } from '../src/catalog/generate-manifest.js';

// test/ -> packages/cli -> packages -> <checkout root>
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const featuresRoot = path.join(repoRoot, 'components', 'features');

const NODE_FEATURE = 'ghcr.io/devcontainers/features/node';

/**
 * A feature that installs a global npm package must not run before the node
 * feature. Without the ordering, npm resolves the package against the Node
 * baked into the runtime image while the yml pins a different one: a workbench
 * on `node:26` got `@forge/cli` 13.0.0, the newest release the base image's
 * 22.23.1 satisfies, and then ran it on 26.
 *
 * Checked against the install scripts rather than a hand-kept list, so the
 * next feature that reaches for `npm install -g` cannot forget it.
 */
describe('features that install npm globals', () => {
  it('declare installsAfter the node feature, in the descriptor and the manifest', async () => {
    const catalog = await loadDescriptorCatalog(
      path.join(repoRoot, 'components'),
    );
    const ids = await readdir(featuresRoot, { withFileTypes: true });
    const offenders: string[] = [];
    let checked = 0;

    for (const entry of ids) {
      if (!entry.isDirectory()) continue;
      const script = path.join(featuresRoot, entry.name, 'install.sh');
      let source: string;
      try {
        source = await readFile(script, 'utf8');
      } catch {
        continue;
      }
      if (!/npm\s+(install|i)\s+-g\b/.test(source)) continue;
      checked += 1;

      const component = [...catalog.values()].find(
        (c) => c.descriptor.id === entry.name,
      );
      expect(component, `descriptor for ${entry.name}`).toBeDefined();
      const declared = component!.descriptor.feature?.installsAfter ?? [];
      if (!declared.includes(NODE_FEATURE)) {
        offenders.push(entry.name);
        continue;
      }
      // And it has to survive into the json the build actually reads.
      const manifest = descriptorToFeatureManifest(component!.descriptor);
      expect(manifest.installsAfter, entry.name).toContain(NODE_FEATURE);
    }

    expect(offenders).toEqual([]);
    // Guard against the check quietly matching nothing.
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});
