import { describe, expect, it, vi } from 'vitest';
import type * as PathsModule from '../src/config/paths.js';

// Simulate the production (npm-installed) CLI: no workbench checkout, so
// `workbenchCheckoutRoot()` returns null. `bundledFeaturesDir()` stays
// real and resolves to `packages/cli/features/` (synced manifests), the
// same layout the published tarball ships.
vi.mock('../src/config/paths.js', async () => {
  const actual = await vi.importActual<typeof PathsModule>(
    '../src/config/paths.js',
  );
  return { ...actual, workbenchCheckoutRoot: () => null };
});

const { resolveFeatures } = await import('../src/create/scaffold.js');

describe('resolveFeatures — production path (no workbench checkout)', () => {
  it('reads per-feature persistent-home entries from the bundled manifest', () => {
    const resolved = resolveFeatures({
      name: 'prod',
      languages: [],
      services: [],
      features: {
        'ghcr.io/getmonoceros/monoceros-features/claude-code:1': {},
      },
    });

    const claude = resolved.find((f) =>
      f.devcontainerKey.includes('claude-code'),
    );
    expect(claude).toBeDefined();
    // In prod the feature is pulled from GHCR (passthrough ref), NOT the
    // dev-only `./features/<name>` local-source build.
    expect(claude!.devcontainerKey).toBe(
      'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
    );
    // The regression this guards: without the bundle fallback these were
    // empty, so no `../home/.claude` bind was emitted and Claude Code's
    // auth/config was lost on every `apply` rebuild.
    expect(claude!.persistentHomePaths).toContain('.claude');
    expect(claude!.persistentHomeFiles.map((e) => e.path)).toContain(
      '.claude.json',
    );
  });
});
