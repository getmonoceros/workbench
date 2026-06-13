import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import {
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  SERVICE_CATALOG,
} from '../src/create/catalog.js';

// test/ -> packages/cli -> packages -> <checkout root>
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const componentsRoot = path.join(repoRoot, 'components');

/**
 * Transitional parity contract (ADR 0020, phase 3): the language/service
 * descriptors under `components/` must reproduce the structural data still
 * held in `catalog.ts` (LANGUAGE_CATALOG / SERVICE_CATALOG). This guards the
 * data port so no consumer behavior changes when we later flip consumers onto
 * the descriptor model. Retire alongside catalog.ts in phase 4.
 *
 * displayName/description are intentionally NOT compared: they have no
 * canonical source in catalog.ts (they lived in the now-superseded component
 * templates, where the version numbers had gone stale), so the port is free to
 * write fresh, correct copy.
 */

/** Map an options record to a plain { key: defaultValue } object. */
function optionDefaults(
  options: Record<string, { default?: string | boolean | number }>,
): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  for (const [key, spec] of Object.entries(options)) {
    if (spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

describe('language descriptors reproduce LANGUAGE_CATALOG', () => {
  for (const [id, entry] of Object.entries(LANGUAGE_CATALOG)) {
    it(`${id}: feature ref, builtin flag and default options match`, async () => {
      const catalog = await loadDescriptorCatalog(componentsRoot);
      const component = catalog.get(id);
      expect(component, `descriptor for ${id}`).toBeDefined();
      const d = component!.descriptor;

      expect(d.category).toBe('language');
      expect(d.language?.feature).toBe(entry.feature);
      expect(d.language?.builtin).toBe(BUILTIN_LANGUAGES.has(id));
      expect(optionDefaults(d.options)).toEqual(entry.defaultOptions ?? {});
      expect(d.displayName.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
    });
  }
});

describe('service descriptors reproduce SERVICE_CATALOG', () => {
  for (const [id, entry] of Object.entries(SERVICE_CATALOG)) {
    it(`${id}: image, port, mount, healthcheck, extensions and env match`, async () => {
      const catalog = await loadDescriptorCatalog(componentsRoot);
      const component = catalog.get(id);
      expect(component, `descriptor for ${id}`).toBeDefined();
      const d = component!.descriptor;

      expect(d.category).toBe('service');
      expect(d.service?.image).toBe(entry.image);
      expect(d.service?.defaultPort).toBe(entry.defaultPort);
      expect(d.service?.dataMount).toBe(entry.dataMount);
      expect(d.service?.healthcheck).toEqual(entry.healthcheck);
      expect(d.service?.vscodeExtensions).toEqual(entry.vscodeExtensions);
      // env defaults are modeled as surface:env options.
      expect(optionDefaults(d.options)).toEqual(entry.env ?? {});
      expect(d.displayName.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
    });
  }
});
