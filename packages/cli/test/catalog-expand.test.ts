import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { expandSelectable } from '../src/catalog/expand.js';
import { loadComponentCatalog } from '../src/init/components.js';

// test/ -> packages/cli -> packages -> <checkout root>
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const componentsRoot = path.join(repoRoot, 'components');
const templatesRoot = path.join(
  repoRoot,
  'packages',
  'cli',
  'templates',
  'components',
);

/**
 * Transitional surface contract (ADR 0020, phase 3): the descriptor catalog,
 * once expanded (base entries + presets), must offer the exact same set of
 * selectable (name, category) pairs as the old component-template catalog. The
 * displayName/description are intentionally NOT compared - the descriptor port
 * rewrote them. What must not change is *what the builder can select*.
 */
describe('expandSelectable preserves the selectable surface', () => {
  it('offers the same (name, category) set as the old component templates', async () => {
    const oldCatalog = await loadComponentCatalog(templatesRoot);
    const expanded = expandSelectable(
      await loadDescriptorCatalog(componentsRoot),
    );

    const oldSet = new Set(
      [...oldCatalog.values()].map((c) => `${c.file.category}:${c.name}`),
    );
    const newSet = new Set(
      [...expanded.values()].map((c) => `${c.category}:${c.name}`),
    );

    expect(newSet).toEqual(oldSet);
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
