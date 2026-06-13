import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type * as PathsModule from '../src/config/paths.js';

// The real checkout-root components/ tree (always present), used as the
// descriptor source. Feature manifest data + persistent-home entries derive
// from these descriptors (ADR 0020) — there is no manifest JSON to read.
const COMPONENTS_ROOT = fileURLToPath(
  new URL('../../../components', import.meta.url),
);
const COMPONENTS_FEATURES_DIR = path.join(COMPONENTS_ROOT, 'features');

// Simulate the production (npm-installed) CLI: no workbench checkout, so the
// dev-only local-source build does NOT kick in unless an override is set.
// Pin componentsRootDir() at the real components/ so the descriptor-derived
// data is available regardless of whether the bundle was built.
vi.mock('../src/config/paths.js', async () => {
  const actual = await vi.importActual<typeof PathsModule>(
    '../src/config/paths.js',
  );
  return {
    ...actual,
    workbenchCheckoutRoot: () => null,
    componentsRootDir: () => COMPONENTS_ROOT,
  };
});

const { resolveFeatures } = await import('../src/create/scaffold.js');

describe('resolveFeatures — production path (no workbench checkout)', () => {
  it('derives per-feature persistent-home entries from the descriptor', () => {
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
    // Persistent-home binds come from the descriptor; without them no
    // `../home/.claude` bind is emitted and Claude Code's auth/config is lost
    // on every `apply` rebuild.
    expect(claude!.persistentHomePaths).toContain('.claude');
    expect(claude!.persistentHomeFiles.map((e) => e.path)).toContain(
      '.claude.json',
    );
  });

  it('builds from local source when MONOCEROS_FEATURES_DIR_OVERRIDE is set', () => {
    // Even with no checkout, the override points the prod CLI at a
    // feature-source dir (the checkout's components/features/) so e2e tests
    // the BRANCH feature, not the published GHCR artifact.
    const prev = process.env.MONOCEROS_FEATURES_DIR_OVERRIDE;
    process.env.MONOCEROS_FEATURES_DIR_OVERRIDE = COMPONENTS_FEATURES_DIR;
    try {
      const resolved = resolveFeatures({
        name: 'override',
        languages: [],
        services: [],
        features: {
          'ghcr.io/getmonoceros/monoceros-features/claude-code:1': {},
        },
      });
      const claude = resolved.find((f) => f.localName === 'claude-code');
      expect(claude).toBeDefined();
      // Local-source build: relative `./features/<name>` key + recorded source
      // dir + a freshly generated manifest, NOT the GHCR passthrough ref.
      expect(claude!.devcontainerKey).toBe('./features/claude-code');
      expect(claude!.localSourceDir).toBe(
        path.join(COMPONENTS_FEATURES_DIR, 'claude-code'),
      );
      expect(claude!.generatedManifest?.id).toBe('claude-code');
      expect(claude!.persistentHomePaths).toContain('.claude');
    } finally {
      if (prev === undefined)
        delete process.env.MONOCEROS_FEATURES_DIR_OVERRIDE;
      else process.env.MONOCEROS_FEATURES_DIR_OVERRIDE = prev;
    }
  });
});
