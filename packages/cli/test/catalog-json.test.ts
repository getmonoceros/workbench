import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import {
  buildCatalogJson,
  CATALOG_JSON_SCHEMA_VERSION,
} from '../src/catalog/catalog-json.js';

// test/ -> packages/cli -> packages -> <checkout root>
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const componentsRoot = path.join(repoRoot, 'components');

/**
 * The public `catalog.json` projection (published at
 * getmonoceros.build/catalog.json, consumed by the workbench skill). The
 * contract: the selector surface and builder-visible options survive;
 * internal implementation detail does not; output is deterministic.
 */
describe('buildCatalogJson', () => {
  it('projects the real catalog into the three category arrays with stamps', async () => {
    const catalog = await loadDescriptorCatalog(componentsRoot);
    const doc = buildCatalogJson(catalog, '9.9.9');

    expect(doc.schemaVersion).toBe(CATALOG_JSON_SCHEMA_VERSION);
    expect(doc.cliVersion).toBe('9.9.9');
    expect(doc.languages.length).toBeGreaterThan(0);
    expect(doc.services.length).toBeGreaterThan(0);
    expect(doc.features.length).toBeGreaterThan(0);
  });

  it('uses the selector name (not the canonical id) and surfaces presets', async () => {
    const catalog = await loadDescriptorCatalog(componentsRoot);
    const doc = buildCatalogJson(catalog, 'dev');

    // Short selector wins over the manifest id (claude, not claude-code).
    const names = doc.features.map((f) => f.name);
    expect(names).toContain('claude');
    expect(names).not.toContain('claude-code');

    const atlassian = doc.features.find((f) => f.name === 'atlassian');
    expect(atlassian?.presets).toEqual([...(atlassian?.presets ?? [])].sort());
    expect(atlassian?.presets).toContain('twg');
    expect(atlassian?.presets).toContain('rovodev');
  });

  it('emits sorted, deterministic output', async () => {
    const catalog = await loadDescriptorCatalog(componentsRoot);
    const a = buildCatalogJson(catalog, 'dev');
    const b = buildCatalogJson(catalog, 'dev');
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));

    const langNames = a.languages.map((l) => l.name);
    expect(langNames).toEqual([...langNames].sort());
    for (const f of a.features) {
      const keys = f.options.map((o) => o.key);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('excludes silent options and carries only the projected key set', async () => {
    const catalog = await loadDescriptorCatalog(componentsRoot);
    const doc = buildCatalogJson(catalog, 'dev');

    // No option in the public projection is `silent` — only yml/env survive.
    for (const group of [doc.languages, doc.services, doc.features]) {
      for (const c of group) {
        for (const o of c.options) {
          expect(o.surface === 'yml' || o.surface === 'env').toBe(true);
        }
      }
    }

    // Each projected object exposes only its allowed keys — internal blocks
    // (service.image, language.feature, connectionEnv, healthcheck,
    // persistentHome*, vscodeExtensions, sourcePath) never leak as keys.
    const optionKeys = new Set([
      'key',
      'type',
      'default',
      'description',
      'surface',
      'proposals',
    ]);
    const base = [
      'name',
      'displayName',
      'description',
      'documentationURL',
      'options',
    ];
    const allowed = {
      languages: new Set([...base, 'defaultVersion', 'versions']),
      services: new Set([...base, 'defaultPort']),
      features: new Set([...base, 'presets']),
    };
    for (const group of ['languages', 'services', 'features'] as const) {
      for (const c of doc[group]) {
        for (const k of Object.keys(c)) {
          expect(allowed[group].has(k)).toBe(true);
        }
        for (const o of c.options) {
          for (const k of Object.keys(o)) {
            expect(optionKeys.has(k)).toBe(true);
          }
        }
      }
    }
  });
});
