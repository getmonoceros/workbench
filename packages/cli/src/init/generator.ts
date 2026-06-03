import type { Component } from './components.js';
import type { FeatureManifestSummary } from './manifest.js';
import {
  buildFeatureHeaderLines,
  featureOptionHints,
  wrapToComment as sharedWrapToComment,
} from './feature-doc.js';
import { expandCuratedService } from '../create/catalog.js';
import { renderCustomService, renderServiceObjectBody } from './service-doc.js';
import { GIT_IDENTITY_VAR } from '../config/env-file.js';

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
/** A service the builder asked for via `--with-services`. */
export interface InitService {
  /** `curated` → expand via SERVICE_CATALOG; `custom` → name + image + scaffold. */
  kind: 'curated' | 'custom';
  /** Compose service name (curated id, or derived from the image). */
  name: string;
  /** Image ref — only for `custom` services. */
  image?: string;
}

/** Resolved, categorized inputs for the composed-mode generator. */
export interface ComposedInit {
  languages: readonly string[];
  aptPackages: readonly string[];
  services: readonly InitService[];
  features: readonly RenderableFeature[];
}

export function generateComposedYml(
  name: string,
  composed: ComposedInit,
  lookupManifest: ManifestLookup,
  repoUrls: readonly string[] = [],
  ports: readonly number[] = [],
): string {
  const lines: string[] = [];
  pushHeader(lines, SCHEMA_HEADER_ACTIVE, name);
  lines.push('');
  lines.push('schemaVersion: 1');
  lines.push(`name: ${name}`);
  lines.push('');

  if (composed.languages.length > 0) {
    pushSectionHeader(lines, LANGUAGES_HEADER, /* commented */ false);
    lines.push('languages:');
    for (const lang of composed.languages) lines.push(`  - ${lang}`);
    lines.push('');
  }
  if (composed.aptPackages.length > 0) {
    pushSectionHeader(lines, APT_PACKAGES_HEADER, /* commented */ false);
    lines.push('aptPackages:');
    for (const pkg of composed.aptPackages) lines.push(`  - ${pkg}`);
    lines.push('');
  }
  if (composed.services.length > 0) {
    pushSectionHeader(lines, SERVICES_HEADER, /* commented */ false);
    lines.push('services:');
    for (const svc of composed.services) pushServiceEntry(lines, svc);
    lines.push('');
  }
  if (composed.features.length > 0) {
    pushSectionHeader(lines, FEATURES_HEADER_ACTIVE, /* commented */ false);
    lines.push('features:');
    for (const f of composed.features) {
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
    // Container-level identity first (placeholders + .env seed); repos
    // inherit it. The per-repo `git.user` below stays commented as the
    // override hint for the work-vs-personal case.
    pushGitIdentityBlock(lines);
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
        const body = renderServiceObjectBody(expandCuratedService(svc));
        lines.push(`#   - ${body[0]}`);
        for (const line of body.slice(1)) lines.push(`#     ${line}`);
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
    pushGitIdentityBlock(lines);
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

const APT_PACKAGES_HEADER =
  'Debian/Ubuntu apt packages installed in the dev-container at build time. No curated list — any apt package name works; an invalid name surfaces as an apt error during build.';

// Render one composed-mode service entry as a `services:` sequence item.
// Curated services expand to the full catalog block; custom images get
// name + image active plus the commented field scaffold.
function pushServiceEntry(out: string[], svc: InitService): void {
  if (svc.kind === 'custom') {
    const { bodyLines, comment } = renderCustomService(
      svc.name,
      svc.image ?? '',
    );
    out.push(`  - ${bodyLines[0]}`);
    for (const line of bodyLines.slice(1)) out.push(`    ${line}`);
    for (const cl of comment.split('\n')) out.push(`    #${cl}`);
    return;
  }
  const body = renderServiceObjectBody(expandCuratedService(svc.name));
  out.push(`  - ${body[0]}`);
  for (const line of body.slice(1)) out.push(`    ${line}`);
}

const FEATURES_HEADER_ACTIVE =
  'A Monoceros dev-container is shaped by features — pluggable units that drop tooling (AI assistants, language CLIs, cloud SDKs, …) into the container and bring their own options. The features active for this container are listed below; adjust their options as needed. Shared credentials used across containers belong in monoceros-config.yml under `defaults.features.<ref>` rather than here. Full catalog: `monoceros list-components`.';

const FEATURES_HEADER_DOCUMENTED =
  'A Monoceros dev-container is shaped by features — pluggable units that drop tooling (AI assistants, language CLIs, cloud SDKs, …) into the container and bring their own options. Un-comment the blocks below for the features you want active. Shared credentials used across containers belong in monoceros-config.yml under `defaults.features.<ref>` rather than here. Full catalog: `monoceros list-components`.';

const REPOS_HEADER =
  'Git repositories cloned into `projects/` on container start-up. HTTPS URLs only. The provider is auto-detected for github.com / gitlab.com / bitbucket.org; for any other host (self-hosted GitLab, Gitea, …) declare `provider:` explicitly. Add more later with `monoceros add-repo`.';

const GIT_IDENTITY_HEADER =
  'Git committer identity for commits made inside the container. The ${VAR} values resolve from <name>.env at apply time — fill them there, or leave them blank to fall back to your global git config (or a one-time prompt). Override per repo under repos[].git.user.';

// Top-level `git.user` block with `${VAR}` placeholders. Rendered
// whenever the container has repos: the identity then lives in the
// gitignored <name>.env (seeded blank by init/add-repo), keeping the
// shareable yml free of personal data while staying obvious.
function pushGitIdentityBlock(lines: string[]): void {
  pushSectionHeader(lines, GIT_IDENTITY_HEADER, /* commented */ false);
  lines.push('git:');
  lines.push('  user:');
  lines.push(`    name: \${${GIT_IDENTITY_VAR.name}}`);
  lines.push(`    email: \${${GIT_IDENTITY_VAR.email}}`);
  lines.push('');
}

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

  // Header lines come from the shared feature-doc builder so
  // `add-feature`'s AST writer can emit the exact same prose block.
  for (const wl of buildFeatureHeaderLines(summary, COMMENT_WIDTH - 2)) {
    out.push(`# ${wl}`.trimEnd());
  }

  // The `- ref:` block. Indented two spaces under `features:`.
  out.push(`${yamlPrefix}  - ref: ${feature.ref}`);

  const options = feature.options ?? {};
  const activeKeys = Object.entries(options);
  // Hint keys carry a `${VAR}` placeholder so the builder sees exactly
  // which env var to fill (and `init` / `add-feature` seed the same var
  // into <name>.env). Derivation is shared via featureOptionHints.
  const hints = featureOptionHints(summary, feature.ref, Object.keys(options));

  if (activeKeys.length === 0 && hints.length === 0) return;

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
    for (const hint of hints) {
      out.push(`${yamlPrefix}      ${hint.key}: ${hint.placeholder}`);
    }
    return;
  }

  // Composed mode: `- ref:` is active, and so is a single `options:`
  // block — active sub-component values first, then the credential
  // hints as `${VAR}` placeholders. The placeholders are NOT bare-null
  // (they carry a value), so no yaml-lib trailing-comment-stealing on
  // round-trip; and an empty/missing `${VAR}` resolves to "" at apply,
  // which the transform skips → the monoceros-config default is
  // inherited (not clobbered). The matching `.env` keys are seeded blank
  // by init/add-feature, so the builder just fills the value.
  out.push(`    options:`);
  for (const [key, value] of activeKeys) {
    out.push(`      ${key}: ${renderScalarValue(value)}`);
  }
  for (const hint of hints) {
    out.push(`      ${hint.key}: ${hint.placeholder}`);
  }
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
  const wrapped = sharedWrapToComment(text, COMMENT_WIDTH - 2);
  for (const wl of wrapped) {
    out.push(`# ${wl}`.trimEnd());
  }
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
