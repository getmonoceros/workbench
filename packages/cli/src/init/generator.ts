import type { Component, ResolvedComponent } from './components.js';
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
  components: ResolvedComponent[],
  lookupManifest: ManifestLookup,
  repoUrls: readonly string[] = [],
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
      renderFeatureBlock(
        lines,
        f,
        lookupManifest(f.ref),
        /* commented */ false,
      );
    }
    lines.push('');
  }
  // Composed mode only emits a repos block when --with-repo provided
  // URLs. The "show all available options" requirement applies on a
  // per-entry basis there: each active repo entry carries commented
  // hints for its optional fields. With no URLs, composed mode stays
  // schlank — repos are surfaced via `monoceros add-repo` post-init.
  if (repoUrls.length > 0) {
    renderReposBlock(lines, repoUrls, /* commented */ false);
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
  repoUrls: readonly string[] = [],
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
    const items = byCategory.language.flatMap((c) =>
      (c.file.contributes.languages ?? []).map((lang) => ({
        value: lang,
        label: c.file.displayName,
      })),
    );
    const width = Math.max(...items.map((i) => i.value.length)) + 2;
    lines.push('# Languages — runtime toolchains.');
    lines.push('# languages:');
    for (const item of items) {
      const pad = ' '.repeat(width - item.value.length);
      lines.push(`#   - ${item.value}${pad}# ${item.label}`);
    }
    lines.push('');
  }
  if (byCategory.service.length > 0) {
    const items = byCategory.service.flatMap((c) =>
      (c.file.contributes.services ?? []).map((svc) => ({
        value: svc,
        label: c.file.displayName,
      })),
    );
    const width = Math.max(...items.map((i) => i.value.length)) + 2;
    lines.push('# Services — compose-mode siblings of the workspace');
    lines.push('# container (compose mode kicks in as soon as at least');
    lines.push('# one service is active).');
    lines.push('# services:');
    for (const item of items) {
      const pad = ' '.repeat(width - item.value.length);
      lines.push(`#   - ${item.value}${pad}# ${item.label}`);
    }
    lines.push('');
  }
  if (byCategory.feature.length > 0) {
    lines.push('# Features — devcontainer features installed inside the');
    lines.push('# container. Each entry has an OCI-style `ref` plus an');
    lines.push('# optional `options` map. Credentials/auth keys appear');
    lines.push('# as commented hints; set them here per container, or');
    lines.push('# globally in monoceros-config.yml under');
    lines.push('# `defaults.features.<ref>`.');
    lines.push('#');
    lines.push('# Catalog:');
    lines.push('#');
    const nameColumnWidth =
      Math.max(...byCategory.feature.map((c) => c.name.length)) + 2;
    for (const c of byCategory.feature) {
      const pad = ' '.repeat(nameColumnWidth - c.name.length);
      lines.push(`#   ${c.name}${pad}${c.file.displayName}`);
    }
    lines.push('#');
    lines.push('# Below: one block per feature ref. Un-comment what');
    lines.push("# you want active. Sub-components share their parent's");
    lines.push('# block — pick the parent for the full preset, swap to');
    lines.push('# a sub-component name for a partial install.');
    lines.push('#');
    lines.push('# features:');

    // Render one feature block per unique ref. Prefer the top-level
    // component (e.g. `atlassian` over `atlassian/twg`) as the source
    // of the rendered options, since the top-level carries the
    // "everything on" default users typically want first.
    const renderedRefs = new Set<string>();
    const topLevel = byCategory.feature.filter((c) => !c.name.includes('/'));

    for (const c of topLevel) {
      for (const f of c.file.contributes.features ?? []) {
        if (renderedRefs.has(f.ref)) continue;
        renderedRefs.add(f.ref);
        renderFeatureBlock(
          lines,
          f,
          lookupManifest(f.ref),
          /* commented */ true,
        );
      }
    }
    // Any feature ref only mentioned through a sub-component (no
    // top-level component for the same ref) — render it from the
    // first sub-component.
    for (const c of byCategory.feature) {
      if (!c.name.includes('/')) continue;
      for (const f of c.file.contributes.features ?? []) {
        if (renderedRefs.has(f.ref)) continue;
        renderedRefs.add(f.ref);
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
  // Repos section — always rendered in documented mode (commented out
  // when no --with-repo URLs were provided, active when they were).
  // The block shows the full set of per-entry options so a builder
  // reading the yml sees what's possible without leaving the file —
  // same "all available options are visible" rule that drives the
  // features block above.
  renderReposBlock(lines, repoUrls, /* commented */ repoUrls.length === 0);

  // Routing — same visibility rule, but always fully commented:
  // `monoceros add-port` is what activates the block.
  renderRoutingBlock(lines);

  return ensureTrailingNewline(lines.join('\n'));
}

interface RenderableFeature {
  ref: string;
  options?: Record<string, string | number | boolean>;
}

// Target column width for rendered comment lines. Description text
// and usage notes get word-wrapped against this width so the output
// stays readable in a standard editor without horizontal scrolling.
const COMMENT_WIDTH = 72;

function renderFeatureBlock(
  out: string[],
  feature: RenderableFeature,
  summary: FeatureManifestSummary | undefined,
  commented: boolean,
): void {
  const c = commented ? '#   ' : '  ';
  const optionHints = summary?.optionHints ?? [];
  const optionDescriptions = summary?.optionDescriptions ?? {};
  const usageNotes = summary?.usageNotes ?? [];

  // Per-feature usage notes — rendered as a wrapped comment block
  // right before the `- ref:` line. Multiple notes are separated
  // by an empty comment line so they read as distinct paragraphs.
  for (let i = 0; i < usageNotes.length; i++) {
    if (i > 0) out.push(`${c}#`);
    for (const line of wrapToComment(
      usageNotes[i]!,
      COMMENT_WIDTH - c.length,
    )) {
      out.push(`${c}# ${line}`);
    }
  }

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
        emitHint(out, hint, optionDescriptions[hint], `${c}    `);
      }
    }
  } else if (remainingHints.length > 0) {
    out.push(
      `${c}  # Optional — override monoceros-config.yml defaults.features:`,
    );
    out.push(`${c}  # options:`);
    for (const hint of remainingHints) {
      emitHint(out, hint, optionDescriptions[hint], `${c}  #   `);
    }
  }
}

/**
 * Emit a single option-hint line, optionally preceded by its
 * description as wrapped comment lines. `linePrefix` is the full
 * prefix (indent + any commented-out `#   ` chars) that every
 * emitted line should start with; the hint itself is suffixed
 * with `: ` so the user can fill in a value.
 */
function emitHint(
  out: string[],
  hint: string,
  description: string | undefined,
  linePrefix: string,
): void {
  if (description) {
    for (const line of wrapToComment(
      description,
      COMMENT_WIDTH - linePrefix.length,
    )) {
      out.push(`${linePrefix}# ${line}`);
    }
  }
  out.push(`${linePrefix}${hint}:`);
}

/**
 * Render the `repos:` section. When `commented` is true the entire
 * block is prefixed with `# ` (documented mode, no --with-repo).
 * When false the `url:` lines are active but the optional fields
 * (path, provider, git.user) stay commented per entry so the
 * builder sees what else can go there.
 *
 * The "all available options visible" rule: every per-entry field
 * the schema accepts appears on every rendered entry, either active
 * (rare — only `url` is required) or as a commented hint.
 */
function renderReposBlock(
  out: string[],
  urls: readonly string[],
  commented: boolean,
): void {
  // Prose intro — always a comment block, regardless of whether the
  // section below is active or fully commented.
  out.push('# Repos — git repositories cloned into projects/ during');
  out.push('# post-create. HTTPS-only (ADR 0006). Provider auto-detected');
  out.push('# for github.com, gitlab.com, bitbucket.org; for any other host');
  out.push('# (self-hosted GitLab, Bitbucket Data Center, Gitea/Forgejo,');
  out.push('# GitHub Enterprise, …) declare provider explicitly.');
  out.push('#');

  if (commented) {
    // Pure documented mode (no --with-repo): a single example entry,
    // everything commented. Shows the full per-entry surface.
    out.push('# repos:');
    out.push('#   - url: https://github.com/<org>/<repo>.git');
    out.push(
      '#     # path: <folder>           # subfolder under projects/; default: URL-derived',
    );
    out.push(
      '#     # provider: github         # github | gitlab | bitbucket | gitea',
    );
    out.push(
      '#     # git:                     # per-repo committer identity override',
    );
    out.push('#     #   user:');
    out.push('#     #     name: Your Name');
    out.push('#     #     email: you@example.com');
    out.push('');
    return;
  }

  // Active entries from --with-repo. Each entry repeats the
  // commented hints for the optional fields so they're discoverable
  // without docs.
  out.push('repos:');
  for (const url of urls) {
    const derivedPath = deriveDefaultPath(url);
    out.push(`  - url: ${url}`);
    out.push(
      `    # path: ${derivedPath}            # subfolder under projects/; default: URL-derived (${derivedPath})`,
    );
    out.push(
      '    # provider: github         # github | gitlab | bitbucket | gitea',
    );
    out.push(
      '    # git:                     # per-repo committer identity override',
    );
    out.push('    #   user:');
    out.push('    #     name: Your Name');
    out.push('    #     email: you@example.com');
  }
  out.push('');
}

/**
 * Render the `routing:` section. Always commented in the documented
 * mode — the block stays absent from a fresh yml until the builder
 * runs `monoceros add-port`, at which point the AST mutator
 * materializes it. The commented form shows the full set of fields
 * the schema accepts (same "all available options visible" rule as
 * features and repos). See ADR 0007.
 */
function renderRoutingBlock(out: string[]): void {
  out.push('# Routing — expose container ports to the host through the');
  out.push('# shared Traefik singleton. Once any port is declared the');
  out.push('# container joins the monoceros-proxy network and the proxy');
  out.push('# routes <name>.localhost (default port) and');
  out.push('# <name>-<port>.localhost (explicit). `monoceros add-port`');
  out.push('# manages the list; the block appears on first add.');
  out.push('#');
  out.push('# routing:');
  out.push('#   ports:                    # internal container ports');
  out.push(
    '#     - 3000                  # first entry doubles as <name>.localhost',
  );
  out.push('#     - 5173');
  out.push(
    '#   vscodeAutoForward: false  # default: false. Traefik is the single',
  );
  out.push(
    '#                             # source of truth — set true only if you',
  );
  out.push(
    "#                             # want VS Code's port panel as primary.",
  );
  out.push('');
}

/**
 * URL-derived default for the `path:` hint. Mirrors what
 * `deriveRepoName` in scaffold.ts does at apply time — inlined
 * here to keep the generator self-contained (no cross-module
 * dependency from init/ → create/).
 */
function deriveDefaultPath(url: string): string {
  let last = url;
  const slash = url.lastIndexOf('/');
  if (slash >= 0) last = url.slice(slash + 1);
  if (last.endsWith('.git')) last = last.slice(0, -4);
  return last || 'repo';
}

/**
 * Word-wrap a single paragraph of plain text to `width` columns.
 * The returned strings do NOT include any prefix — the caller is
 * expected to prepend a comment marker (`# `) and any indent.
 * Long words that exceed `width` are emitted on their own line
 * rather than split mid-word.
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
