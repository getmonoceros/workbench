import type { FindingsStore, FindingsStoreItem } from '@monoceros/core';

export interface ListOptions {
  store: FindingsStore;
  /** When true, includes triaged items (jetzt/später/verworfen). */
  all: boolean;
}

/**
 * Returns a plain-text rendering of the Findings store contents,
 * grouped by kind. The format is line-oriented and stable so the
 * slash-command consumer can re-emit it verbatim.
 */
export async function renderList(options: ListOptions): Promise<string> {
  const items = options.all
    ? await options.store.listAll()
    : await options.store.listOpen();
  if (items.length === 0) {
    return options.all
      ? 'No items captured yet.'
      : 'No open items. Use `--all` to include triaged items.';
  }
  const lines: string[] = [];
  for (const kind of ['finding', 'concern', 'risk'] as const) {
    const group = items.filter((i) => i.kind === kind);
    if (group.length === 0) continue;
    lines.push(`## ${kindHeading(kind)} (${group.length})`, '');
    for (const item of group) {
      lines.push(renderItem(item));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function kindHeading(kind: FindingsStoreItem['kind']): string {
  return kind === 'finding'
    ? 'Findings'
    : kind === 'concern'
      ? 'Concerns'
      : 'Risks';
}

function renderItem(item: FindingsStoreItem): string {
  const severity = item.frontmatter.severity as string | undefined;
  const category = item.frontmatter.category as string | undefined;
  const tags = [
    item.status,
    severity,
    category,
    item.frontmatter.blocking === true ? 'blocking' : undefined,
  ].filter((t): t is string => typeof t === 'string' && t.length > 0);
  const message = item.body.trim().split('\n')[0] ?? '';
  return `- [${item.id}] (${tags.join(', ')}) ${message}`;
}
