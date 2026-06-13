import { loadDescriptorCatalogSync } from '../catalog/load-sync.js';
import { matchMonocerosFeature } from '../util/ref.js';

/**
 * Derives the feature-manifest summary init's yml-generator surfaces as inline
 * guidance straight from the unified component descriptor (ADR 0020) — the
 * single source of truth. There is no devcontainer-feature.json to read: that
 * file is a build artifact generated from the same descriptor.
 *
 * The fields init's generator wants:
 *
 *   - `name` / `description` — the feature's displayName / prose. The
 *     generator builds the header comment block from these.
 *   - `documentationURL` — emitted as a "See <url>…" line when it's a real
 *     URL. Empty / missing / literal "tbd" → line omitted.
 *   - `optionHints` — option keys marked `surface: env` (credentials/config
 *     the builder fills in); rendered as `${VAR}` placeholders.
 *   - `optionDescriptions` / `optionNames` / `optionTypes` / `optionDefaults`
 *     — per-option metadata for the "Options: …" summary, completion, and the
 *     briefing's `whenOption` resolution.
 *   - `usageNotes` — free-text per-feature paragraphs.
 *   - `briefing` — the AGENTS.md lines.
 *
 * Only Monoceros-owned refs
 * (`ghcr.io/getmonoceros/monoceros-features/<name>:<tag>`) resolve — for
 * third-party features we have no descriptor, so the fallback is "no hints",
 * which is right: we don't speculate about other people's feature options.
 * Unknown ref → `undefined` and init renders without hints. Never throws.
 */

export interface FeatureManifestSummary {
  /** `name` field — short product/tagline. Empty string when unset. */
  name: string;
  /** `description` field — multi-sentence prose. Empty string when unset. */
  description: string;
  /**
   * `documentationURL` — only set when it's a real URL. `tbd` / empty / unset
   * → undefined, so the generator suppresses the "See <url>…" line.
   */
  documentationURL: string | undefined;
  /** Names of options to render as commented hints in the init output. */
  optionHints: string[];
  /** `description` from each option, keyed by name. */
  optionDescriptions: Record<string, string>;
  /** ALL option keys, in declaration order (used by completion). */
  optionNames: string[];
  /** `type` from each option, keyed by name (used by completion). */
  optionTypes: Record<string, 'string' | 'boolean'>;
  /** `default` from each option, keyed by name (used by briefing whenOption). */
  optionDefaults: Record<string, string | boolean>;
  /** Free-text per-feature notes rendered above the `- ref:` line. */
  usageNotes: string[];
  /** Optional briefing block for `AGENTS.md`. */
  briefing?: FeatureBriefing;
}

export interface FeatureBriefing {
  /** Ordered list of bullet-style lines emitted as installed-tool entries. */
  lines: FeatureBriefingLine[];
}

export interface FeatureBriefingLine {
  /** Markdown text for the bullet, without the leading `- `. */
  text: string;
  /**
   * If set, the line is only emitted when the named feature option resolves
   * truthy (after merging user options over defaults). If unset, always.
   */
  whenOption?: string;
}

/**
 * Resolve a Monoceros feature ref to its manifest summary, derived from the
 * descriptor. `componentsRoot` overrides the descriptor root (tests / a fake
 * workbench); defaults to the resolved checkout-or-bundle root.
 */
export function loadFeatureManifestSummary(
  ref: string,
  componentsRoot?: string,
): FeatureManifestSummary | undefined {
  const match = matchMonocerosFeature(ref);
  if (!match) return undefined;
  let descriptor;
  try {
    descriptor = loadDescriptorCatalogSync(componentsRoot).get(
      match.name,
    )?.descriptor;
  } catch {
    return undefined;
  }
  if (!descriptor || descriptor.category !== 'feature') return undefined;

  const optionHints: string[] = [];
  const optionDescriptions: Record<string, string> = {};
  const optionTypes: Record<string, 'string' | 'boolean'> = {};
  const optionDefaults: Record<string, string | boolean> = {};
  const optionNames: string[] = [];
  for (const [key, spec] of Object.entries(descriptor.options)) {
    optionNames.push(key);
    // `surface: env` options are the credential/config hints (the old
    // optionHints), rendered as `${VAR}` placeholders.
    if (spec.surface === 'env') optionHints.push(key);
    if (spec.description !== undefined && spec.description.length > 0) {
      optionDescriptions[key] = spec.description;
    }
    optionTypes[key] = spec.type === 'boolean' ? 'boolean' : 'string';
    if (typeof spec.default === 'string' || typeof spec.default === 'boolean') {
      optionDefaults[key] = spec.default;
    }
  }

  const rawUrl = descriptor.documentationURL?.trim() ?? '';
  const documentationURL =
    rawUrl.length > 0 && rawUrl.toLowerCase() !== 'tbd' ? rawUrl : undefined;

  const briefing: FeatureBriefing | undefined =
    descriptor.briefing.length > 0
      ? {
          lines: descriptor.briefing.map((l) => ({
            text: l.text,
            ...(l.whenOption !== undefined ? { whenOption: l.whenOption } : {}),
          })),
        }
      : undefined;

  return {
    name: descriptor.displayName,
    description: descriptor.description,
    documentationURL,
    optionHints,
    optionDescriptions,
    optionNames,
    optionTypes,
    optionDefaults,
    usageNotes: descriptor.usageNotes,
    ...(briefing ? { briefing } : {}),
  };
}
