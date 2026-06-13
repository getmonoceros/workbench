import { defineCommand } from 'citty';
import { consola } from 'consola';
import { loadDescriptorCatalog } from '../catalog/load.js';
import { expandSelectable } from '../catalog/expand.js';
import { colorsFor } from '../util/format.js';

// Category-key → human-readable section label. Same order is used
// for rendering — languages first (most common), services next,
// features last.
const CATEGORY_LABELS = {
  language: 'Languages',
  service: 'Services',
  feature: 'Features',
} as const;
const CATEGORY_ORDER: ReadonlyArray<keyof typeof CATEGORY_LABELS> = [
  'language',
  'service',
  'feature',
];

export const listComponentsCommand = defineCommand({
  meta: {
    name: 'list-components',
    group: 'discovery',
    description:
      'Print the components catalog used by `monoceros init --with-languages=… / --with-services=… / --with-features=…`, grouped by category (Languages, Services, Features). Component names render in cyan, descriptions in default colour; when piped, the formatting drops out and lines become `name<TAB>description` for grep/awk-friendly consumption.',
  },
  args: {},
  async run() {
    try {
      const catalog = expandSelectable(await loadDescriptorCatalog());
      if (catalog.size === 0) {
        consola.warn(
          'No components found. The workbench checkout looks incomplete.',
        );
        process.exit(0);
      }

      const fmt = colorsFor(process.stdout);
      const isTty = process.stdout.isTTY ?? false;

      // Group entries by category for sectioned rendering.
      const byCategory = new Map<
        string,
        Array<{ name: string; desc: string }>
      >();
      for (const c of catalog.values()) {
        const list = byCategory.get(c.category) ?? [];
        list.push({ name: c.name, desc: c.displayName });
        byCategory.set(c.category, list);
      }
      for (const list of byCategory.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name));
      }

      // Piped (non-TTY) output: stay machine-friendly with the
      // historical `name<TAB>description` shape, one category at a
      // time. No ANSI, no alignment padding — grep/awk consumers
      // want predictable columns.
      if (!isTty) {
        let first = true;
        for (const cat of CATEGORY_ORDER) {
          const items = byCategory.get(cat);
          if (!items || items.length === 0) continue;
          if (!first) process.stdout.write('\n');
          first = false;
          process.stdout.write(`# ${cat}\n`);
          for (const { name, desc } of items) {
            process.stdout.write(`${name}\t${desc}\n`);
          }
        }
        process.exit(0);
      }

      // Interactive (TTY) output: section headers + aligned
      // columns, same visual vocabulary as the help renderer and
      // the apply/install structured output. Cyan name column
      // padded to the widest entry in its section so the
      // description column lines up.
      let first = true;
      for (const cat of CATEGORY_ORDER) {
        const items = byCategory.get(cat);
        if (!items || items.length === 0) continue;
        if (!first) process.stdout.write('\n');
        first = false;
        process.stdout.write(`${fmt.sectionLine(CATEGORY_LABELS[cat])}\n\n`);
        const nameWidth = Math.max(...items.map((i) => i.name.length));
        const gutter = 2;
        for (const { name, desc } of items) {
          const pad = ' '.repeat(nameWidth - name.length + gutter);
          process.stdout.write(`  ${fmt.cyan(name)}${pad}${desc}\n`);
        }
      }
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
