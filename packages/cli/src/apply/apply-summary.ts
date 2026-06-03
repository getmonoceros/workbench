import type { CreateOptions } from '../create/types.js';
import { cyan } from '../util/format.js';

/**
 * Post-apply summary: a label/values block that lists what the
 * builder just materialized into the container — features, services,
 * languages, repos, ports, apt packages, install URLs. Skips sections
 * that are empty.
 *
 * Replaces the pre-spinner "Features: …" line that used to print
 * above the progress indicator: that line cherry-picked one yml field
 * arbitrarily; the summary covers everything.
 *
 * Two-step API so the formatter can be unit-tested without an open
 * apply: `buildApplySummary` produces a structured list,
 * `formatApplySummary` renders it.
 */

export interface SummaryLine {
  label: string;
  values: string[];
}

/**
 * Last path-or-URL segment, with any `:tag` suffix stripped. Used as
 * a short display name for OCI-style feature refs.
 *
 *   `ghcr.io/getmonoceros/monoceros-features/claude-code:1` → `claude-code`
 *   `./features/local-thing`                                → `local-thing`
 */
function shortFeatureName(ref: string): string {
  const withoutTag = ref.replace(/:[^:/@]+$/, '');
  const idx = withoutTag.lastIndexOf('/');
  return idx >= 0 ? withoutTag.slice(idx + 1) : withoutTag;
}

/** Last non-empty path segment, falling back to the URL when path is bare. */
function shortRepoName(repo: { url: string; path: string }): string {
  const last = repo.path.split('/').filter(Boolean).pop();
  return last && last.length > 0 ? last : repo.url;
}

export function buildApplySummary(opts: CreateOptions): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (opts.languages.length > 0) {
    lines.push({ label: 'Languages', values: opts.languages });
  }
  if (opts.services.length > 0) {
    lines.push({
      label: 'Services',
      values: opts.services.map((s) => s.name),
    });
  }
  if (opts.features && Object.keys(opts.features).length > 0) {
    lines.push({
      label: 'Features',
      values: Object.keys(opts.features).map(shortFeatureName),
    });
  }
  if (opts.repos && opts.repos.length > 0) {
    lines.push({
      label: 'Repositories',
      values: opts.repos.map(shortRepoName),
    });
  }
  if (opts.ports && opts.ports.length > 0) {
    lines.push({ label: 'Ports', values: opts.ports.map(String) });
  }
  if (opts.aptPackages && opts.aptPackages.length > 0) {
    lines.push({ label: 'APT packages', values: opts.aptPackages });
  }
  if (opts.installUrls && opts.installUrls.length > 0) {
    lines.push({ label: 'Install URLs', values: opts.installUrls });
  }
  return lines;
}

/**
 * Render the summary as a colour-tinted, label-aligned block. The
 * caller is responsible for adding the leading + trailing newlines
 * that frame it within the apply output.
 */
export function formatApplySummary(lines: SummaryLine[]): string {
  if (lines.length === 0) return '';
  const labelWidth = Math.max(...lines.map((l) => l.label.length));
  return lines
    .map((l) => `  ${l.label.padEnd(labelWidth)}  ${cyan(l.values.join(', '))}`)
    .join('\n');
}
