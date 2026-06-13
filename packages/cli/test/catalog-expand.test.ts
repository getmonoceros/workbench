import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { expandSelectable } from '../src/catalog/expand.js';
import { buildComponentCatalog } from '../src/init/components.js';

// test/ -> packages/cli -> packages -> <checkout root>
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const componentsRoot = path.join(repoRoot, 'components');

/**
 * Surface contract (ADR 0020, phase 3): the two projections of the descriptor
 * catalog agree on the selectable surface — `expandSelectable` (what
 * list-components shows) and `buildComponentCatalog` (what init resolves
 * `--with-*` against) must offer the exact same set of (name, category) pairs,
 * base entries plus presets. (That this set also matched the retired component
 * templates was proven when the descriptors were first ported.)
 */
describe('expandSelectable preserves the selectable surface', () => {
  it('agrees with the init component catalog on (name, category)', async () => {
    const descriptors = await loadDescriptorCatalog(componentsRoot);
    const expanded = expandSelectable(descriptors);
    const initCatalog = buildComponentCatalog(descriptors);

    const expandedSet = new Set(
      [...expanded.values()].map((c) => `${c.category}:${c.name}`),
    );
    const initSet = new Set(
      [...initCatalog.values()].map((c) => `${c.file.category}:${c.name}`),
    );

    expect(expandedSet).toEqual(initSet);
  });

  it('exposes the atlassian presets as atlassian/twg and atlassian/rovodev', async () => {
    const expanded = expandSelectable(
      await loadDescriptorCatalog(componentsRoot),
    );

    const twg = expanded.get('atlassian/twg');
    expect(twg?.category).toBe('feature');
    expect(twg?.componentId).toBe('atlassian');
    expect(twg?.presetOptions).toEqual({ rovodev: false, twg: true });

    const rovodev = expanded.get('atlassian/rovodev');
    expect(rovodev?.presetOptions).toEqual({ rovodev: true, twg: false });

    // The bare feature keeps its short selector, not the manifest id.
    expect(expanded.has('claude')).toBe(true);
    expect(expanded.has('claude-code')).toBe(false);
    expect(expanded.get('claude')?.componentId).toBe('claude-code');
  });
});
