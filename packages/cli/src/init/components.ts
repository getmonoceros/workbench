import {
  loadDescriptorCatalog,
  type CatalogComponent,
} from '../catalog/load.js';
import type { Descriptor } from '../catalog/descriptor.js';

/**
 * Components catalog — the selectable surface `monoceros init` composes from.
 *
 * Sourced from the unified component descriptors under `components/`
 * (ADR 0020) and projected into the legacy `Component` shape that
 * `resolveComponents` / `mergeComponents` consume. One entry per descriptor
 * (keyed by its selector `name`, default `id`) plus one per `presets` key as
 * `<name>/<presetKey>` (e.g. `atlassian/twg`). A feature's ref and yml options
 * are reconstructed from the descriptor: the ref from id + major version, the
 * options from the `surface: yml` defaults merged with any preset overrides.
 */

export type ComponentCategory = 'language' | 'service' | 'feature';

export interface FeatureContribution {
  ref: string;
  options?: Record<string, string | number | boolean>;
}

export interface ComponentContributes {
  languages?: string[];
  services?: string[];
  features?: FeatureContribution[];
}

export interface ComponentFile {
  displayName: string;
  description: string;
  category: ComponentCategory;
  contributes: ComponentContributes;
}

export interface Component {
  /** Catalog name, e.g. `node`, `atlassian/twg`. Always slash-form. */
  name: string;
  /** Absolute filesystem path of the source yml — useful for errors. */
  sourcePath: string;
  file: ComponentFile;
}

/** Feature OCI ref reconstructed from a descriptor: id + major version. */
function featureRef(d: Descriptor): string {
  const major = (d.feature?.version ?? '1').split('.')[0];
  return `ghcr.io/getmonoceros/monoceros-features/${d.id}:${major}`;
}

/** The `surface: yml` option defaults written into a feature's yml block. */
function surfaceYmlDefaults(
  d: Descriptor,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, spec] of Object.entries(d.options)) {
    if (spec.surface === 'yml' && spec.default !== undefined) {
      out[key] = spec.default;
    }
  }
  return out;
}

function baseComponentFile(d: Descriptor): ComponentFile {
  const selector = d.name ?? d.id;
  if (d.category === 'language') {
    return {
      displayName: d.displayName,
      description: d.description,
      category: 'language',
      contributes: { languages: [selector] },
    };
  }
  if (d.category === 'service') {
    return {
      displayName: d.displayName,
      description: d.description,
      category: 'service',
      contributes: { services: [selector] },
    };
  }
  return {
    displayName: d.displayName,
    description: d.description,
    category: 'feature',
    contributes: {
      features: [{ ref: featureRef(d), options: surfaceYmlDefaults(d) }],
    },
  };
}

/**
 * Build the selectable component catalog from the descriptor tree. Defaults
 * to the resolved components root (checkout in dev, bundled copy in prod);
 * `rootDir` overrides it (tests).
 */
export async function loadComponentCatalog(
  rootDir?: string,
): Promise<Map<string, Component>> {
  return buildComponentCatalog(await loadDescriptorCatalog(rootDir));
}

/** Project a loaded descriptor catalog into the selectable Component map. */
export function buildComponentCatalog(
  descriptors: Map<string, CatalogComponent>,
): Map<string, Component> {
  const out = new Map<string, Component>();
  const add = (name: string, file: ComponentFile, sourcePath: string): void => {
    if (out.has(name)) {
      throw new Error(`Duplicate component name '${name}' (${sourcePath}).`);
    }
    out.set(name, { name, sourcePath, file });
  };
  for (const { descriptor: d, sourcePath } of descriptors.values()) {
    const selector = d.name ?? d.id;
    add(selector, baseComponentFile(d), sourcePath);
    for (const [presetKey, overrides] of Object.entries(d.presets ?? {})) {
      add(
        `${selector}/${presetKey}`,
        {
          displayName: `${d.displayName} (${presetKey})`,
          description: d.description,
          category: 'feature',
          contributes: {
            features: [
              {
                ref: featureRef(d),
                options: { ...surfaceYmlDefaults(d), ...overrides },
              },
            ],
          },
        },
        sourcePath,
      );
    }
  }
  return out;
}

/**
 * A `SolutionConfig`-shaped fragment produced by merging the
 * `contributes` of one or more components. Caller wraps this into
 * a full config (adds schemaVersion + name) before writing the yml.
 */
export interface MergedComponents {
  languages: string[];
  services: string[];
  features: Array<{
    ref: string;
    options: Record<string, string | number | boolean>;
  }>;
}

/**
 * Merge the contributions of the given components into a single
 * fragment.
 *
 * Rules:
 *   - `languages`/`services`: concat + dedupe (insertion order kept
 *     stable; first occurrence wins).
 *   - `features`: deduped by `ref`. When two components contribute
 *     the same ref, their options are merged with the per-key rules
 *     below.
 *   - Per-key feature option merge:
 *       - booleans: OR (true wins)
 *       - strings + numbers: later component overrides (rare in
 *         practice — components should set activation flags, not
 *         credentials; credentials come from monoceros-config.yml
 *         defaults.features or the user editing the yml directly).
 *
 * The OR-merge for booleans is what makes
 * `--with-features=atlassian/rovodev,atlassian/twg` yield both `true` even
 * though each sub-component sets the sibling flag to `false`.
 */
/**
 * One entry of the resolved-components list. The optional `version`
 * is the `<name>:<version>` suffix from the CLI flag; today it
 * only applies to language components (we append it to each
 * contributed language string so the scaffold passes it as the
 * upstream feature's `version` option). For other categories,
 * providing a version is a builder error and resolveComponents
 * rejects it up front.
 */
export interface ResolvedComponent {
  component: Component;
  version?: string;
}

export function mergeComponents(
  resolved: Array<Component | ResolvedComponent>,
): MergedComponents {
  const languages: string[] = [];
  const services: string[] = [];
  const featureByRef = new Map<
    string,
    { ref: string; options: Record<string, string | number | boolean> }
  >();

  for (const entry of resolved) {
    const c = isResolvedComponent(entry) ? entry.component : entry;
    const version = isResolvedComponent(entry) ? entry.version : undefined;
    const ct = c.file.contributes;
    for (const lang of ct.languages ?? []) {
      // Language components can carry a `:version` suffix from the
      // CLI. We emit `<lang>:<version>` in the final yml; the
      // scaffold parses it back to the upstream feature's
      // `version` option at apply time.
      const value = version !== undefined ? `${lang}:${version}` : lang;
      if (!languages.includes(value)) languages.push(value);
    }
    for (const svc of ct.services ?? []) {
      if (!services.includes(svc)) services.push(svc);
    }
    for (const f of ct.features ?? []) {
      const existing = featureByRef.get(f.ref);
      if (!existing) {
        featureByRef.set(f.ref, {
          ref: f.ref,
          options: { ...(f.options ?? {}) },
        });
        continue;
      }
      existing.options = mergeFeatureOptions(existing.options, f.options ?? {});
    }
  }

  return {
    languages,
    services,
    features: [...featureByRef.values()],
  };
}

function isResolvedComponent(
  x: Component | ResolvedComponent,
): x is ResolvedComponent {
  return 'component' in x;
}

export function mergeFeatureOptions(
  a: Record<string, string | number | boolean>,
  b: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const result = { ...a };
  for (const [key, valueB] of Object.entries(b)) {
    const valueA = result[key];
    if (typeof valueA === 'boolean' && typeof valueB === 'boolean') {
      result[key] = valueA || valueB;
      continue;
    }
    result[key] = valueB;
  }
  return result;
}

/**
 * Resolve `--with-*` names against the catalog. Accepts plain
 * names (`node`) and language-version pairs (`node:20`). Splits
 * the `:version` off, looks up the bare name in the catalog, and
 * carries the version forward only for language components — a
 * version on any other category is rejected with a clear error.
 *
 * Throws with the full list of unknown names so the builder fixes
 * them all at once rather than running into them one at a time.
 */
export function resolveComponents(
  catalog: Map<string, Component>,
  names: string[],
): ResolvedComponent[] {
  const unknown: string[] = [];
  const out: ResolvedComponent[] = [];
  for (const raw of names) {
    const colon = raw.indexOf(':');
    const name = colon === -1 ? raw : raw.slice(0, colon);
    const version = colon === -1 ? undefined : raw.slice(colon + 1);

    const c = catalog.get(name);
    if (!c) {
      // The unknown-name message reports the form the user typed
      // (including the :version) so it's easy to spot the typo.
      unknown.push(raw);
      continue;
    }
    if (version !== undefined && c.file.category !== 'language') {
      throw new Error(
        `Component '${name}' is a ${c.file.category}, not a language — a ':${version}' suffix has no meaning here.`,
      );
    }
    out.push({ component: c, ...(version !== undefined ? { version } : {}) });
  }
  if (unknown.length > 0) {
    const available = [...catalog.keys()].sort();
    throw new Error(
      `Unknown component${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.\n` +
        `Available: ${available.join(', ')}.`,
    );
  }
  return out;
}
