import { defineCommand } from 'citty';
import { consola } from 'consola';
import { loadDescriptorCatalog } from '../catalog/load.js';
import { expandSelectable } from '../catalog/expand.js';
import { buildCatalogJson } from '../catalog/catalog-json.js';
import { CLI_VERSION } from '../version.js';
import { colorsFor } from '../util/format.js';

// Category-key → human-readable section label. Same order is used
// for rendering — languages first (most common), services next,
// features last.
const CATEGORY_LABELS = {
  language: 'Languages',
  service: 'Services',
  feature: 'Features',
  'mcp-server': 'MCP servers',
} as const;
const CATEGORY_ORDER: ReadonlyArray<keyof typeof CATEGORY_LABELS> = [
  'language',
  'service',
  'feature',
  'mcp-server',
];

export const listComponentsCommand = defineCommand({
  meta: {
    name: 'list-components',
    group: 'discovery',
    description:
      'Print the components catalog used by `monoceros init --with-languages=… / --with-services=… / --with-features=… / --with-mcp-servers=…`, grouped by category (Languages, Services, Features, MCP servers). On a terminal the names render in cyan against a short label, in aligned columns; when piped, the formatting drops out and lines become `name<TAB>description`, the full sentence, for grep/awk-friendly consumption. `--json` emits the full catalog (options, versions, presets) as a machine-readable document — the same shape published at getmonoceros.build/catalog.json.',
  },
  args: {
    json: {
      type: 'boolean',
      description:
        'Emit the catalog as a JSON document (name, options, versions, presets per component) instead of the human-readable listing.',
    },
  },
  async run({ args }) {
    try {
      const descriptors = await loadDescriptorCatalog();

      // --json: machine-readable projection, no TTY formatting. This is the
      // canonical shape published as getmonoceros.build/catalog.json.
      if (args.json) {
        const doc = buildCatalogJson(descriptors, CLI_VERSION);
        process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
        process.exit(0);
      }

      const catalog = expandSelectable(descriptors);
      if (catalog.size === 0) {
        consola.warn(
          'No components found. The workbench checkout looks incomplete.',
        );
        process.exit(0);
      }

      const fmt = colorsFor(process.stdout);
      const isTty = process.stdout.isTTY ?? false;

      // Group entries by category for sectioned rendering.
      // Two columns, because the two consumers want different things: a
      // terminal wants a short label it can align, a pipe wants the sentence
      // that says what the component is (`dotnet<TAB>.NET` tells a grep
      // nothing).
      const byCategory = new Map<
        string,
        Array<{ name: string; label: string; desc: string }>
      >();
      for (const c of catalog.values()) {
        const list = byCategory.get(c.category) ?? [];
        list.push({ name: c.name, label: c.displayName, desc: c.description });
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
        for (const { name, label } of items) {
          const pad = ' '.repeat(nameWidth - name.length + gutter);
          process.stdout.write(`  ${fmt.cyan(name)}${pad}${label}\n`);
        }
      }
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
