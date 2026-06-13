import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { descriptorToFeatureManifest } from '../src/catalog/generate-manifest.js';

// test/ -> packages/cli -> packages -> <checkout root>
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const componentsRoot = path.join(repoRoot, 'components');

/**
 * Transitional fidelity contract (ADR 0020, phase 2): the descriptors under
 * `components/features/*` must generate byte-equivalent devcontainer-feature
 * manifests to the hand-written ones still living under `images/features/*`.
 * This guarantees the source-of-truth flip (phase 2 wiring + phase 4) does not
 * change any published feature. Retire this test once `images/features/*` is
 * gone and generation is the only path.
 */
const FEATURES = ['claude-code', 'github-cli', 'atlassian'] as const;

describe('descriptorToFeatureManifest reproduces the hand-written manifests', () => {
  for (const id of FEATURES) {
    it(`${id}: generated manifest equals images/features/${id}/devcontainer-feature.json`, async () => {
      const catalog = await loadDescriptorCatalog(componentsRoot);
      const component = catalog.get(id);
      expect(component, `descriptor for ${id} should load`).toBeDefined();

      const generated = descriptorToFeatureManifest(component!.descriptor);

      const handWritten = JSON.parse(
        await readFile(
          path.join(
            repoRoot,
            'images',
            'features',
            id,
            'devcontainer-feature.json',
          ),
          'utf8',
        ),
      );

      expect(generated).toEqual(handWritten);
    });
  }

  it('refuses to generate a manifest for a non-feature descriptor', async () => {
    const fakeLanguage = {
      id: 'java',
      category: 'language' as const,
      displayName: 'Java',
      description: 'x',
      options: {},
      usageNotes: [],
      briefing: [],
      language: {
        feature: 'ghcr.io/devcontainers/features/java:1',
        builtin: false,
      },
    };
    expect(() => descriptorToFeatureManifest(fakeLanguage)).toThrow(
      /is a language, not a feature/,
    );
  });
});
