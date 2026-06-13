import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { descriptorToFeatureManifest } from '../src/catalog/generate-manifest.js';

// test/ -> packages/cli -> packages -> <checkout root>
const componentsRoot = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  'components',
);

/**
 * The devcontainer-feature.json is generated from the component descriptor
 * (ADR 0020); these assertions pin the shape of that generation from the real
 * feature descriptors — id/name/version, the devcontainer option schema, and
 * the x-monoceros block (optionHints from surface:env, persistent home,
 * briefing). This is the contract the GHCR publish and the local-source build
 * both rely on.
 */
async function generate(id: string) {
  const catalog = await loadDescriptorCatalog(componentsRoot);
  const component = catalog.get(id);
  expect(component, `descriptor for ${id}`).toBeDefined();
  return descriptorToFeatureManifest(component!.descriptor);
}

describe('descriptorToFeatureManifest', () => {
  it('claude-code: full manifest shape', async () => {
    const m = await generate('claude-code');
    expect(m.$schema).toMatch(/devContainerFeature\.schema\.json$/);
    expect(m.id).toBe('claude-code');
    expect(m.name).toBe('Claude Code');
    expect(m.version).toBe('1.2.0');
    expect(m.documentationURL).toBe(
      'https://docs.anthropic.com/en/docs/claude-code',
    );
    // devcontainer option schema: surface/secret are stripped, proposals kept.
    expect(Object.keys(m.options as object)).toEqual([
      'version',
      'apiKey',
      'permissionMode',
    ]);
    expect((m.options as Record<string, unknown>).version).toEqual({
      type: 'string',
      default: 'latest',
      description: 'npm-style version spec (`latest`, `^0.4`, `0.4.2`).',
    });
    const x = m['x-monoceros'] as Record<string, unknown>;
    expect(x.optionHints).toEqual(['apiKey']); // surface:env only
    expect(x.persistentHomePaths).toEqual(['.claude']);
    expect(x.persistentHomeFiles).toEqual([
      { path: '.claude.json', initialContent: '{}\n' },
    ]);
    expect((x.briefing as { lines: unknown[] }).lines).toHaveLength(1);
    expect(
      (m.customizations as { vscode: { extensions: string[] } }).vscode
        .extensions,
    ).toEqual(['anthropic.claude-code']);
  });

  it('atlassian: optionHints follow declaration order; briefing keeps whenOption', async () => {
    const m = await generate('atlassian');
    const x = m['x-monoceros'] as Record<string, unknown>;
    // rovodev/twg are surface:yml (not hints); the four credentials are env.
    expect(x.optionHints).toEqual([
      'instance',
      'email',
      'apiToken',
      'bitbucketToken',
    ]);
    const lines = (x.briefing as { lines: { whenOption?: string }[] }).lines;
    expect(lines.map((l) => l.whenOption)).toEqual(['rovodev', 'twg']);
  });

  it('refuses to generate a manifest for a non-feature descriptor', () => {
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
