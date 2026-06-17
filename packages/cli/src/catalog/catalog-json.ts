import type { CatalogComponent } from './load.js';
import type { OptionSpec } from './descriptor.js';

/**
 * Public, machine-readable projection of the component catalog — the
 * shape published as `getmonoceros.build/catalog.json` and consumed by
 * the claude.ai workbench skill to suggest correct `monoceros init
 * --with-* / add-*` commands.
 *
 * This is a deliberate *projection*, not a dump of the descriptors. It
 * carries only what a command-suggesting consumer needs: the selector
 * name, the human labels, and the builder-visible options/versions/
 * presets. Internal implementation details (the upstream OCI feature
 * ref, the service image, healthchecks, `connectionEnv` templates,
 * persistent-home paths, VS Code extensions, and `silent` options like a
 * floating feature version) are intentionally left out — they are not
 * part of the command surface and should not leak into a public API.
 *
 * Pure function, no I/O. The caller loads the descriptor catalog and the
 * CLI version and passes them in.
 */

export interface CatalogJsonOption {
  key: string;
  type: 'string' | 'boolean' | 'number';
  default?: string | boolean | number;
  description?: string;
  /** `yml` (visible/editable in the profile) or `env` (seeded into `<name>.env`). */
  surface: 'yml' | 'env';
  proposals?: string[];
}

interface CatalogJsonBase {
  /** CLI/yml selector, e.g. `node`, `postgres`, `claude`. */
  name: string;
  displayName: string;
  description: string;
  documentationURL?: string;
  options: CatalogJsonOption[];
}

export interface CatalogJsonLanguage extends CatalogJsonBase {
  /** Version shown inline in the generated yml, when the descriptor pins one. */
  defaultVersion?: string;
  /** Versions the upstream feature accepts (docs/UX only). */
  versions?: string[];
}

export interface CatalogJsonService extends CatalogJsonBase {
  defaultPort?: number;
}

export interface CatalogJsonFeature extends CatalogJsonBase {
  /** Preset keys, each selectable as `<name>/<preset>` (e.g. `atlassian/twg`). */
  presets: string[];
}

export interface CatalogJson {
  /** Bumped when this projection's shape changes incompatibly. */
  schemaVersion: number;
  /** The CLI version this snapshot was generated from. */
  cliVersion: string;
  languages: CatalogJsonLanguage[];
  services: CatalogJsonService[];
  features: CatalogJsonFeature[];
}

/** Current shape version of the published `catalog.json`. */
export const CATALOG_JSON_SCHEMA_VERSION = 1;

/**
 * Project a builder-visible option. Returns `null` for `silent` options
 * so they never reach the public catalog.
 */
function projectOption(
  key: string,
  spec: OptionSpec,
): CatalogJsonOption | null {
  if (spec.surface === 'silent') return null;
  const out: CatalogJsonOption = {
    key,
    type: spec.type,
    surface: spec.surface,
  };
  if (spec.default !== undefined) out.default = spec.default;
  if (spec.description !== undefined) out.description = spec.description;
  if (spec.proposals !== undefined) out.proposals = spec.proposals;
  return out;
}

/** Builder-visible options for a descriptor, sorted by key for stable output. */
function projectOptions(
  options: Record<string, OptionSpec>,
): CatalogJsonOption[] {
  return Object.entries(options)
    .map(([key, spec]) => projectOption(key, spec))
    .filter((o): o is CatalogJsonOption => o !== null)
    .sort((a, b) => a.key.localeCompare(b.key));
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

/**
 * Build the public catalog projection from the loaded descriptor catalog.
 * Output is deterministic (every list sorted by name/key) so the
 * generated `catalog.json` only changes when the catalog actually does.
 */
export function buildCatalogJson(
  catalog: Map<string, CatalogComponent>,
  cliVersion: string,
): CatalogJson {
  const languages: CatalogJsonLanguage[] = [];
  const services: CatalogJsonService[] = [];
  const features: CatalogJsonFeature[] = [];

  for (const { descriptor: d } of catalog.values()) {
    const base: CatalogJsonBase = {
      name: d.name ?? d.id,
      displayName: d.displayName,
      description: d.description,
      options: projectOptions(d.options),
    };
    if (d.documentationURL !== undefined) {
      base.documentationURL = d.documentationURL;
    }

    if (d.category === 'language' && d.language) {
      const lang: CatalogJsonLanguage = { ...base };
      if (d.language.defaultVersion !== undefined) {
        lang.defaultVersion = d.language.defaultVersion;
      }
      if (d.language.versions !== undefined) {
        lang.versions = d.language.versions;
      }
      languages.push(lang);
    } else if (d.category === 'service' && d.service) {
      const svc: CatalogJsonService = { ...base };
      if (d.service.defaultPort !== undefined) {
        svc.defaultPort = d.service.defaultPort;
      }
      services.push(svc);
    } else if (d.category === 'feature') {
      features.push({ ...base, presets: Object.keys(d.presets ?? {}).sort() });
    }
  }

  return {
    schemaVersion: CATALOG_JSON_SCHEMA_VERSION,
    cliVersion,
    languages: languages.sort(byName),
    services: services.sort(byName),
    features: features.sort(byName),
  };
}
