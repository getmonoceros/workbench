import type { Component, ResolvedComponent } from './components.js';
import { mergeComponents } from './components.js';
import type { FeatureManifestSummary } from './manifest.js';

/**
 * Renderer for the container yml that `monoceros init` produces.
 *
 * Style rules (the file the builder sees, not the code):
 *
 *   - Every section carries a short user-facing header comment that
 *     explains WHY the section exists, not how it's wired internally.
 *     One to four lines, builder-vocabulary.
 *
 *   - One `#` depth — never `# # foo`. Builder strips one `#` per line
 *     of a commented block to activate it.
 *
 *   - No trailing `# explanations` after a value. Per-feature option
 *     text lives in the feature manifest and surfaces as a wrapped
 *     header block above the matching `- ref:` line.
 *
 * Per-feature header text is pulled straight from the feature manifest
 * (`name`, `description`, `options.<key>.description`,
 * `documentationURL`, `x-monoceros.usageNotes`). The generator carries
 * no fallback prose — gaps in the manifest are visible gaps in the
 * generated yml, which is the right incentive.
 */

export type ManifestLookup = (
  ref: string,
) => FeatureManifestSummary | undefined;

const SCHEMA_HEADER_ACTIVE =
  '# Solution-config — describes what should be inside your dev-container.\n# Edit any section, then run `monoceros apply <name>` to (re-)build.';
const SCHEMA_HEADER_DOCUMENTED =
  '# Solution-config — describes what should be inside your dev-container.\n# Every section is commented out by default; un-comment what you need\n# (strip one `#` per line of the block), then run `monoceros apply <name>`.';

// Soft target for wrapped comment lines. Keeps the rendered yml
// readable in a standard editor without horizontal scrolling.
const COMMENT_WIDTH = 76;

/**
 * Render the active-mode yml for the given components.
 */
export function generateComposedYml(
  name: string,
  components: ResolvedComponent[],
  lookupManifest: ManifestLookup,
  repoUrls: readonly string[] = [],
  ports: readonly number[] = [],
): string {
  const merged = mergeComponents(components);
  const lines: string[] = [];
  pushHeader(lines, SCHEMA_HEADER_ACTIVE, name);
  lines.push('');
  lines.push('schemaVersion: 1');
  lines.push(`name: ${name}`);
  lines.push('');

  if (merged.languages.length > 0) {
    pushSectionHeader(lines, LANGUAGES_HEADER, /* commented */ false);
    lines.push('languages:');
    for (const lang of merged.languages) lines.push(`  - ${lang}`);
    lines.push('');
  }
  if (merged.services.length > 0) {
    pushSectionHeader(lines, SERVICES_HEADER, /* commented */ false);
    lines.push('services:');
    for (const svc of merged.services) lines.push(`  - ${svc}`);
    lines.push('');
  }
  if (merged.features.length > 0) {
    pushSectionHeader(lines, FEATURES_HEADER_ACTIVE, /* commented */ false);
    lines.push('features:');
    for (const f of merged.features) {
      lines.push('');
      renderFeatureBlock(
        lines,
        f,
        lookupManifest(f.ref),
        /* commented */ false,
      );
    }
    lines.push('');
  }
  if (repoUrls.length > 0) {
    pushSectionHeader(lines, REPOS_HEADER, /* commented */ false);
    lines.push('repos:');
    for (const url of repoUrls) {
      lines.push(`  - url: ${url}`);
      // Optional per-repo fields as commented hints (single-`#`).
      // Builder strips one `#` per line to set a path, declare a
      // provider, or override the container-level git.user for this
      // repo.
      lines.push('    # path:');
      lines.push('    # provider:');
      lines.push('    # git:');
      lines.push('    #   user:');
      lines.push('    #     name:');
      lines.push('    #     email:');
    }
    lines.push('');
  }
  if (ports.length > 0) {
    pushSectionHeader(lines, routingHeader(name), /* commented */ false);
    lines.push('routing:');
    lines.push('  ports:');
    for (const port of ports) {
      lines.push(`    - ${port}`);
    }
    lines.push('  # vscodeAutoForward: false');
    lines.push('');
  }

  return ensureTrailingNewline(lines.join('\n'));
}

/**
 * Render the documented-default yml: every section commented out at
 * single-`#` depth, with a user-facing header above each section.
 */
export function generateDocumentedYml(
  name: string,
  catalog: Map<string, Component>,
  lookupManifest: ManifestLookup,
  repoUrls: readonly string[] = [],
  ports: readonly number[] = [],
): string {
  const byCategory = groupByCategory(catalog);
  const lines: string[] = [];
  pushHeader(lines, SCHEMA_HEADER_DOCUMENTED, name);
  lines.push('');
  lines.push('schemaVersion: 1');
  lines.push(`name: ${name}`);
  lines.push('');

  if (byCategory.language.length > 0) {
    pushSectionHeader(lines, LANGUAGES_HEADER, /* commented */ true);
    lines.push('# languages:');
    for (const c of byCategory.language) {
      for (const lang of c.file.contributes.languages ?? []) {
        lines.push(`#   - ${lang}`);
      }
    }
    lines.push('');
  }
  if (byCategory.service.length > 0) {
    pushSectionHeader(lines, SERVICES_HEADER, /* commented */ true);
    lines.push('# services:');
    for (const c of byCategory.service) {
      for (const svc of c.file.contributes.services ?? []) {
        lines.push(`#   - ${svc}`);
      }
    }
    lines.push('');
  }
  if (byCategory.feature.length > 0) {
    pushSectionHeader(lines, FEATURES_HEADER_DOCUMENTED, /* commented */ true);
    lines.push('# features:');

    const renderedRefs = new Set<string>();
    const topLevel = byCategory.feature.filter((c) => !c.name.includes('/'));
    for (const c of topLevel) {
      for (const f of c.file.contributes.features ?? []) {
        if (renderedRefs.has(f.ref)) continue;
        renderedRefs.add(f.ref);
        lines.push('#');
        renderFeatureBlock(
          lines,
          f,
          lookupManifest(f.ref),
          /* commented */ true,
        );
      }
    }
    for (const c of byCategory.feature) {
      if (!c.name.includes('/')) continue;
      for (const f of c.file.contributes.features ?? []) {
        if (renderedRefs.has(f.ref)) continue;
        renderedRefs.add(f.ref);
        lines.push('#');
        renderFeatureBlock(
          lines,
          f,
          lookupManifest(f.ref),
          /* commented */ true,
        );
      }
    }
    lines.push('');
  }

  if (repoUrls.length > 0) {
    pushSectionHeader(lines, REPOS_HEADER, /* commented */ false);
    lines.push('repos:');
    for (const url of repoUrls) {
      lines.push(`  - url: ${url}`);
    }
    lines.push('');
  } else {
    pushSectionHeader(lines, REPOS_HEADER, /* commented */ true);
    lines.push('# repos:');
    lines.push('#   - url: https://github.com/<org>/<repo>.git');
    lines.push('#     path: <folder>');
    lines.push('#     provider: github');
    lines.push('#     git:');
    lines.push('#       user:');
    lines.push('#         name: Your Name');
    lines.push('#         email: you@example.com');
    lines.push('');
  }

  if (ports.length > 0) {
    pushSectionHeader(lines, routingHeader(name), /* commented */ false);
    lines.push('routing:');
    lines.push('  ports:');
    for (const port of ports) {
      lines.push(`    - ${port}`);
    }
    lines.push('  # vscodeAutoForward: false');
    lines.push('');
  } else {
    pushSectionHeader(lines, routingHeader(name), /* commented */ true);
    lines.push('# routing:');
    lines.push('#   ports:');
    lines.push('#     - 3000');
    lines.push('#     - 5173');
    lines.push('#   vscodeAutoForward: false');
    lines.push('');
  }

  return ensureTrailingNewline(lines.join('\n'));
}

// ───── Section header text ────────────────────────────────────────

const LANGUAGES_HEADER =
  'Language runtimes installed inside the dev-container. Pick the ones your projects build against. The catalog of available runtimes is shown by `monoceros list-components`.';

const SERVICES_HEADER =
  'Sibling containers that run alongside the dev-container (databases, caches, message queues, …). Each service is reachable from inside the dev-container by its name as hostname (e.g. `postgres://postgres:5432`). Activating any service switches the container to docker-compose mode automatically.';

const FEATURES_HEADER_ACTIVE =
  'A Monoceros dev-container is shaped by features — pluggable units that drop tooling (AI assistants, language CLIs, cloud SDKs, …) into the container and bring their own options. The features active for this container are listed below; adjust their options as needed. Shared credentials used across containers belong in monoceros-config.yml under `defaults.features.<ref>` rather than here. Full catalog: `monoceros list-components`.';

const FEATURES_HEADER_DOCUMENTED =
  'A Monoceros dev-container is shaped by features — pluggable units that drop tooling (AI assistants, language CLIs, cloud SDKs, …) into the container and bring their own options. Un-comment the blocks below for the features you want active. Shared credentials used across containers belong in monoceros-config.yml under `defaults.features.<ref>` rather than here. Full catalog: `monoceros list-components`.';

const REPOS_HEADER =
  'Git repositories cloned into `projects/` on container start-up. HTTPS URLs only. The provider is auto-detected for github.com / gitlab.com / bitbucket.org; for any other host (self-hosted GitLab, Gitea, …) declare `provider:` explicitly. Add more later with `monoceros add-repo`.';

function routingHeader(name: string): string {
  return `Container ports exposed to the host through Traefik. Reach them in your browser as ${name}-<port>.localhost (e.g. ${name}-3000.localhost). The first entry is the default route and is also reachable as the bare ${name}.localhost. Manage the list with \`monoceros add-port\`.`;
}

// ───── Per-feature rendering ──────────────────────────────────────

interface RenderableFeature {
  ref: string;
  options?: Record<string, string | number | boolean>;
}

/**
 * Render one feature entry. Header comment block (from manifest) +
 * the `- ref:` / `options:` yaml. Commented (`commented: true`) means
 * every line carries one `#` prefix — builder strips it to activate.
 *
 * Format (both modes), `<lp>` = line prefix (`# ` when commented, ``
 * when active), `<ip>` = inside-options-prefix (`#       ` commented,
 * `      ` active):
 *
 *   <lp># <feature name and prose, wrapped>
 *   <lp># Options: opt1 (desc), opt2 (desc), …
 *   <lp># See <documentationURL> for further information.
 *   <lp>  - ref: <ref>
 *   <lp>    options:
 *   <lp>      <opt>: <value>
 */
function renderFeatureBlock(
  out: string[],
  feature: RenderableFeature,
  summary: FeatureManifestSummary | undefined,
  commented: boolean,
): void {
  // Header lines are ALWAYS plain `#` comments at single depth —
  // never double `# #`. In documented mode the yaml lines below get
  // a `# ` prefix that the builder strips to activate; in active
  // mode they have no prefix. Either way the header comments stay
  // as-is, because they ARE the documentation that should live in
  // the file forever.
  const yamlPrefix = commented ? '# ' : '';

  const headerLines = buildHeaderLines(summary);
  for (const line of headerLines) {
    const wrapped = wrapToComment(line, COMMENT_WIDTH - 2);
    for (const wl of wrapped) {
      out.push(`# ${wl}`.trimEnd());
    }
  }

  // The `- ref:` block. Indented two spaces under `features:`.
  out.push(`${yamlPrefix}  - ref: ${feature.ref}`);

  const options = feature.options ?? {};
  const activeKeys = Object.entries(options);
  const hintKeys = (summary?.optionHints ?? []).filter((h) => !(h in options));

  if (activeKeys.length === 0 && hintKeys.length === 0) return;

  if (commented) {
    // Documented mode: the whole feature block is single-`#`
    // commented at outer depth. The options skeleton lives INSIDE
    // that outer comment — no extra inner `#`, otherwise we'd
    // re-introduce `# # foo` nesting that the builder rightly
    // objected to. After stripping one `#` per line, the active
    // form has the hint keys as bare-null values which the
    // transform treats as "fall through to default" (see
    // `solutionConfigToCreateOptions`).
    out.push(`${yamlPrefix}    options:`);
    for (const [key, value] of activeKeys) {
      out.push(`${yamlPrefix}      ${key}: ${renderScalarValue(value)}`);
    }
    for (const key of hintKeys) {
      out.push(`${yamlPrefix}      ${key}:`);
    }
    return;
  }

  // Composed mode: `- ref:` is active. Active option values (from
  // explicit --with-options, when that lands) go under an active
  // `options:` block. Remaining hints stay in a single-`#`
  // commented block under the ref — never active-empty, because
  // bare-null values attract yaml-lib's trailing-comment-stealing
  // on round-trip via the AST writers (apply / add-port / …) and
  // would silently override monoceros-config defaults with `""`.
  if (activeKeys.length > 0) {
    out.push(`    options:`);
    for (const [key, value] of activeKeys) {
      out.push(`      ${key}: ${renderScalarValue(value)}`);
    }
  }
  if (hintKeys.length > 0) {
    out.push(`    # options:`);
    for (const key of hintKeys) {
      out.push(`    #   ${key}:`);
    }
  }
}

/**
 * Assemble the header comment text from a manifest summary. Returns
 * one string per paragraph; the caller wraps each.
 *
 * Format:
 *   <Name> — <description>. <usageNotes joined>.
 *   Options: <opt> (<desc>), <opt> (<desc>), …
 *   See <documentationURL> for further information.
 */
function buildHeaderLines(
  summary: FeatureManifestSummary | undefined,
): string[] {
  const out: string[] = [];
  if (!summary) {
    // Third-party / unknown ref — nothing to say. Caller still emits
    // the `- ref:` line below.
    return out;
  }
  const tagline = summary.name?.trim();
  const description = summary.description?.trim();
  if (tagline && description) {
    out.push(`${tagline} — ${description}`);
  } else if (tagline) {
    out.push(tagline);
  } else if (description) {
    out.push(description);
  }
  for (const note of summary.usageNotes) {
    const trimmed = note.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  if (summary.optionHints.length > 0) {
    const parts = summary.optionHints.map((key) => {
      const desc = summary.optionDescriptions[key];
      const short = desc ? shortenOptionDescription(desc) : undefined;
      return short ? `${key} (${short})` : key;
    });
    out.push(`Options: ${parts.join(', ')}.`);
  }
  if (summary.documentationURL) {
    out.push(`See ${summary.documentationURL} for further information.`);
  }
  return out;
}

/**
 * Trim a per-option `description` to a parenthetical hint — first
 * sentence, trailing punctuation stripped. Length cap is intentionally
 * absent: feature manifests are expected to keep descriptions terse;
 * the wrap function downstream handles line breaks naturally. If a
 * description gets unwieldy that's a signal to edit the manifest, not
 * to silently truncate.
 */
function shortenOptionDescription(desc: string): string {
  const firstSentence = desc.split(/(?<=[.!?])\s+/)[0]?.trim() ?? desc.trim();
  return firstSentence.replace(/[.!?]+$/, '').trim();
}

// ───── Misc helpers ───────────────────────────────────────────────

function pushHeader(out: string[], header: string, name: string): void {
  for (const line of header.replace(/<name>/g, name).split('\n')) {
    out.push(line);
  }
}

function pushSectionHeader(
  out: string[],
  text: string,
  _commented: boolean,
): void {
  // All section headers are themselves `#`-comments regardless of
  // whether the section body is commented or active. The `_commented`
  // flag is kept for symmetry with future per-mode wording but is
  // unused today — the body's commented-ness is encoded in the body
  // lines, not in the header.
  void _commented;
  const wrapped = wrapToComment(text, COMMENT_WIDTH - 2);
  for (const wl of wrapped) {
    out.push(`# ${wl}`.trimEnd());
  }
}

/**
 * Word-wrap a single paragraph of plain text to `width` columns. The
 * returned strings do NOT include any prefix — the caller is expected
 * to prepend a comment marker (`# `) and indent. Long words that
 * exceed `width` are emitted on their own line rather than split
 * mid-word.
 */
function wrapToComment(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [''];
  const usable = Math.max(width, 20);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (current.length === 0) {
      current = w;
      continue;
    }
    if (current.length + 1 + w.length <= usable) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function renderScalarValue(value: string | number | boolean): string {
  if (typeof value === 'string') {
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
