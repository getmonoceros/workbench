import type { Component, MergedComponents } from './components.js';
import { mergeComponents } from './components.js';
import type { FeatureManifestSummary } from './manifest.js';

/**
 * Renderer for the container yml that `monoceros init` produces.
 *
 * Two modes:
 *
 *   - **Composed** (`monoceros init <name> --with=node,…`): all
 *     listed components are active. The output is a clean,
 *     immediately-applyable yml. Per-feature option hints
 *     (auth/credentials from the feature manifest) are appended as
 *     commented lines beneath the active options block, so a builder
 *     reading the yml can see at a glance which keys exist without
 *     leaving the file.
 *
 *   - **Documented** (`monoceros init <name>` without `--with`):
 *     every section is commented out. The output is a self-explaining
 *     reference; the builder un-comments what they need and runs
 *     `monoceros apply`.
 *
 * Both modes share the per-feature block rendering. The only
 * difference is whether the section is commented out at the top
 * level or not.
 *
 * We hand-render the yml as a string instead of going through the
 * yaml library's AST. The shape is narrow enough that the explicit
 * line-by-line approach is shorter and easier to reason about than
 * juggling Document + Pair + Scalar nodes with attached comments.
 */

export type ManifestLookup = (
  ref: string,
) => FeatureManifestSummary | undefined;

const SCHEMA_HEADER = [
  '# Monoceros solution-config. Edit freely, then run',
  '# `monoceros apply <name>` to materialize a dev-container.',
  '#',
  '# Schema reference: see the workbench `templates/components/README.md`',
  '# and `docs/konzept.md` for what each section does. Each feature',
  '# under `features:` also accepts options not shown here — check',
  "# the feature's `devcontainer-feature.json` for the full list.",
] as const;

/**
 * Render the active-mode yml for the given components.
 */
export function generateComposedYml(
  name: string,
  components: Component[],
  lookupManifest: ManifestLookup,
): string {
  const merged = mergeComponents(components);
  const lines: string[] = [];
  for (const h of SCHEMA_HEADER) lines.push(h);
  lines.push('');
  lines.push('schemaVersion: 1');
  lines.push(`name: ${name}`);
  lines.push('');

  if (merged.languages.length > 0) {
    lines.push('languages:');
    for (const lang of merged.languages) lines.push(`  - ${lang}`);
    lines.push('');
  }
  if (merged.services.length > 0) {
    lines.push('services:');
    for (const svc of merged.services) lines.push(`  - ${svc}`);
    lines.push('');
  }
  if (merged.features.length > 0) {
    lines.push('features:');
    for (const f of merged.features) {
      const hints = lookupManifest(f.ref)?.optionHints ?? [];
      renderFeatureBlock(lines, f, hints, /* commented */ false);
    }
    lines.push('');
  }

  return ensureTrailingNewline(lines.join('\n'));
}

/**
 * Render the documented-default yml: every component listed but
 * commented out, with section headers carrying short prose so a
 * fresh builder can read the file and figure out what to enable.
 */
export function generateDocumentedYml(
  name: string,
  catalog: Map<string, Component>,
  lookupManifest: ManifestLookup,
): string {
  const byCategory = groupByCategory(catalog);
  const lines: string[] = [];
  for (const h of SCHEMA_HEADER) lines.push(h);
  lines.push('#');
  lines.push('# Below is the full set of components shipped with this');
  lines.push('# workbench, every one commented out. Un-comment the lines');
  lines.push('# you want active. The same effect (and a cleaner yml) is');
  lines.push('# achievable by running `monoceros init <name> --with=…`');
  lines.push('# with a comma-separated list of component names.');
  lines.push('');
  lines.push('schemaVersion: 1');
  lines.push(`name: ${name}`);
  lines.push('');

  if (byCategory.language.length > 0) {
    lines.push('# Languages — runtime toolchains.');
    lines.push('# languages:');
    for (const c of byCategory.language) {
      for (const lang of c.file.contributes.languages ?? []) {
        lines.push(`#   - ${lang}   # ${c.file.displayName}`);
      }
    }
    lines.push('');
  }
  if (byCategory.service.length > 0) {
    lines.push('# Services — compose-mode siblings of the workspace');
    lines.push('# container (compose mode kicks in as soon as at least');
    lines.push('# one service is active).');
    lines.push('# services:');
    for (const c of byCategory.service) {
      for (const svc of c.file.contributes.services ?? []) {
        lines.push(`#   - ${svc}   # ${c.file.displayName}`);
      }
    }
    lines.push('');
  }
  if (byCategory.feature.length > 0) {
    lines.push('# Features — devcontainer features installed inside the');
    lines.push('# container. Each entry has an OCI-style `ref` plus an');
    lines.push('# optional `options` map; the commented-out lines below');
    lines.push('# each feature show the credentials it understands (the');
    lines.push('# same keys you can set globally in monoceros-config.yml');
    lines.push('# under `defaults.features.<ref>`).');
    lines.push('# features:');
    // Within features we group by ref. Top-level components carry
    // the human-friendly description; sub-components (atlassian/twg)
    // are listed in the description block of their parent ref as
    // hints for "if you want only one of these tools, swap the parent
    // for a sub".
    const renderedRefs = new Set<string>();
    const topLevel = byCategory.feature.filter((c) => !c.name.includes('/'));
    const subByParent = new Map<string, Component[]>();
    for (const c of byCategory.feature) {
      if (!c.name.includes('/')) continue;
      const parent = c.name.split('/')[0]!;
      const arr = subByParent.get(parent) ?? [];
      arr.push(c);
      subByParent.set(parent, arr);
    }

    const renderFeatureWithDescription = (
      describe: Component,
      f: RenderableFeature,
      siblings: Component[],
    ) => {
      lines.push('#');
      lines.push(`#   # ${describe.file.displayName}`);
      for (const dline of describe.file.description.trim().split('\n')) {
        lines.push(`#   # ${dline}`);
      }
      if (siblings.length > 0) {
        lines.push('#   #');
        lines.push('#   # Sub-components for partial installs:');
        for (const s of siblings) {
          lines.push(`#   #   ${s.name} — ${s.file.displayName}`);
        }
      }
      const hints = lookupManifest(f.ref)?.optionHints ?? [];
      renderFeatureBlock(lines, f, hints, /* commented */ true);
    };

    for (const c of topLevel) {
      for (const f of c.file.contributes.features ?? []) {
        if (renderedRefs.has(f.ref)) continue;
        renderedRefs.add(f.ref);
        renderFeatureWithDescription(c, f, subByParent.get(c.name) ?? []);
      }
    }
    // Any feature ref only mentioned through a sub-component (no
    // top-level component for the same ref) — render it from the
    // first sub.
    for (const c of byCategory.feature) {
      if (!c.name.includes('/')) continue;
      for (const f of c.file.contributes.features ?? []) {
        if (renderedRefs.has(f.ref)) continue;
        renderedRefs.add(f.ref);
        renderFeatureWithDescription(c, f, []);
      }
    }
    lines.push('');
  }

  return ensureTrailingNewline(lines.join('\n'));
}

interface RenderableFeature {
  ref: string;
  options?: Record<string, string | number | boolean>;
}

function renderFeatureBlock(
  out: string[],
  feature: RenderableFeature,
  optionHints: string[],
  commented: boolean,
): void {
  const c = commented ? '#   ' : '  ';
  out.push(`${c}- ref: ${feature.ref}`);
  const options = feature.options ?? {};
  const activeOptions = Object.entries(options);
  const remainingHints = optionHints.filter((h) => !(h in options));

  // When there are active options, emit a real `options:` block.
  // When there are only hints (no active options), skip `options:`
  // entirely and emit the hints as plain comments at the same depth
  // — yaml parsers see `options:` with no content under it as
  // `null`, which fails our schema.
  if (activeOptions.length > 0) {
    out.push(`${c}  options:`);
    for (const [key, value] of activeOptions) {
      out.push(`${c}    ${key}: ${renderScalarValue(value)}`);
    }
    if (remainingHints.length > 0) {
      out.push(
        `${c}    # Optional — override monoceros-config.yml defaults.features:`,
      );
      for (const hint of remainingHints) {
        out.push(`${c}    # ${hint}:`);
      }
    }
  } else if (remainingHints.length > 0) {
    out.push(
      `${c}  # Optional — override monoceros-config.yml defaults.features:`,
    );
    out.push(`${c}  # options:`);
    for (const hint of remainingHints) {
      out.push(`${c}  #   ${hint}:`);
    }
  }
}

function renderScalarValue(value: string | number | boolean): string {
  if (typeof value === 'string') {
    // Quote anything that could be ambiguous to a yaml parser
    // (leading numerics, special chars). Quoting strings is always
    // safe; we only avoid it for booleans/numbers so they keep
    // their types.
    return /^[A-Za-z_][A-Za-z0-9._-]*$/.test(value)
      ? value
      : JSON.stringify(value);
  }
  return String(value);
}

function groupByCategory(catalog: Map<string, Component>): {
  language: Component[];
  service: Component[];
  feature: Component[];
} {
  const out: ReturnType<typeof groupByCategory> = {
    language: [],
    service: [],
    feature: [],
  };
  // Stable sort by component name for deterministic output.
  const sorted = [...catalog.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const c of sorted) {
    out[c.file.category].push(c);
  }
  return out;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}
