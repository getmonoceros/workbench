import { defineCommand } from 'citty';
import { consola } from 'consola';
import { catalogWarnings, loadDescriptorCatalog } from '../catalog/load.js';
import { expandSelectable } from '../catalog/expand.js';
import { buildCatalogJson } from '../catalog/catalog-json.js';
import type { CatalogJsonTemplate } from '../catalog/catalog-json.js';
import { copyToHostClipboard } from '../devcontainer/clipboard-bridge.js';
import {
  projectWorkbenchTemplate,
  readWorkbenchTemplates,
  workbenchTemplateSources,
} from '../init/templates.js';
import { CLI_VERSION } from '../version.js';
import { colorsFor, type Palette } from '../util/format.js';

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

export interface ListingItem {
  name: string;
  /** Terminal column: a short label. */
  label: string;
  /** Piped column: the full sentence. */
  desc: string;
}

export interface ListingSection {
  /** Header of the piped output (`# service`). */
  key: string;
  /** Header of the terminal output (`Services`). */
  label: string;
  items: ListingItem[];
}

/**
 * The human-readable listing. Piped (non-TTY) output stays machine-friendly
 * with the historical `name<TAB>description` shape, one section at a time,
 * no ANSI, no alignment padding, because grep/awk consumers want predictable
 * columns. On a terminal: section headers and aligned columns, the same
 * visual vocabulary as the help renderer, the cyan name column padded to the
 * widest entry in its section. An empty section is left out.
 */
export function renderListing(
  sections: readonly ListingSection[],
  isTty: boolean,
  fmt: Palette,
): string {
  const blocks: string[] = [];
  for (const { key, label, items } of sections) {
    if (items.length === 0) continue;
    const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
    if (!isTty) {
      blocks.push(
        [`# ${key}`, ...sorted.map((i) => `${i.name}\t${i.desc}`)].join('\n'),
      );
      continue;
    }
    const nameWidth = Math.max(...sorted.map((i) => i.name.length));
    const gutter = 2;
    blocks.push(
      [
        `${fmt.sectionLine(label)}\n`,
        ...sorted.map((i) => {
          const pad = ' '.repeat(nameWidth - i.name.length + gutter);
          return `  ${fmt.cyan(i.name)}${pad}${i.label}`;
        }),
      ].join('\n'),
    );
  }
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

/** What a template brings, by the names `init` takes: `node:22, postgres, claude`. */
export function templateContents(t: CatalogJsonTemplate): string {
  return [
    ...t.languages,
    ...t.services.map((s) => s.replace(/@\d+$/, '')),
    ...t.features.map((f) => f.name),
    ...t.mcpServers,
  ].join(', ');
}

export const listComponentsCommand = defineCommand({
  meta: {
    name: 'list-components',
    group: 'discovery',
    description:
      'Print the components catalog used by `monoceros init --with-languages=… / --with-services=… / --with-features=… / --with-mcp-servers=…`, grouped by category (Languages, Services, Features, MCP servers), followed by the workbench templates `init --template=…` starts from. On a terminal the names render in cyan against a short label (for a template: what it brings), in aligned columns; when piped, the formatting drops out and lines become `name<TAB>description`, the full sentence, for grep/awk-friendly consumption. `--json` emits the full catalog (options, versions, presets) as a machine-readable document — the same shape published at getmonoceros.build/catalog.json, plus what only this machine has: components and workbench templates from `~/.monoceros/templates/` carry `local: true`, and every template lists what it already brings. `--copy` puts that JSON on the clipboard instead of printing it.',
  },
  args: {
    json: {
      type: 'boolean',
      description:
        'Emit the catalog as a JSON document (name, options, versions, presets per component, plus the workbench templates and their contents) instead of the human-readable listing.',
    },
    copy: {
      type: 'boolean',
      description:
        'Put the JSON document on the clipboard instead of printing it. Implies `--json`. Fails and names the missing tool when no clipboard tool is installed.',
    },
  },
  async run({ args }) {
    try {
      const descriptors = await loadDescriptorCatalog();
      for (const warning of catalogWarnings(descriptors)) {
        consola.warn(warning);
      }

      // --json: machine-readable projection, no TTY formatting. This is the
      // canonical shape published as getmonoceros.build/catalog.json.
      if (args.json || args.copy) {
        const templates = (
          await readWorkbenchTemplates(workbenchTemplateSources())
        ).map((t) => projectWorkbenchTemplate(t, descriptors));
        const doc = buildCatalogJson(descriptors, CLI_VERSION, templates);
        const text = `${JSON.stringify(doc, null, 2)}\n`;
        if (args.copy) {
          const tool = copyToHostClipboard(text);
          const kb = (Buffer.byteLength(text) / 1024).toFixed(1);
          consola.success(
            `Copied the catalog JSON to the clipboard (${kb} KB, ${templates.length} workbench templates, via ${tool}).`,
          );
        } else {
          process.stdout.write(text);
        }
        process.exit(0);
      }

      const catalog = expandSelectable(descriptors);
      if (catalog.size === 0) {
        consola.warn(
          'No components found. The workbench checkout looks incomplete.',
        );
        process.exit(0);
      }

      // Group entries by category for sectioned rendering.
      // Two columns, because the two consumers want different things: a
      // terminal wants a short label it can align, a pipe wants the sentence
      // that says what the component is (`dotnet<TAB>.NET` tells a grep
      // nothing).
      const byCategory = new Map<string, ListingItem[]>();
      for (const c of catalog.values()) {
        const list = byCategory.get(c.category) ?? [];
        // The builder's own descriptor says so, in both outputs: it is the
        // one entry that exists on this machine and not on a colleague's.
        const local = c.local ? ' (local)' : '';
        list.push({
          name: c.name,
          label: `${c.displayName}${local}`,
          desc: `${c.description}${local}`,
        });
        byCategory.set(c.category, list);
      }
      const sections: ListingSection[] = CATEGORY_ORDER.map((cat) => ({
        key: cat,
        label: CATEGORY_LABELS[cat],
        items: byCategory.get(cat) ?? [],
      }));

      // A workbench template's short label is what it brings; its description
      // is a paragraph, which only the pipe gets. Read with the config parser,
      // so a broken template fails here with its path, as it does under --json.
      const templates = (
        await readWorkbenchTemplates(workbenchTemplateSources())
      ).map((t) => projectWorkbenchTemplate(t, descriptors));
      sections.push({
        key: 'template',
        label: 'Workbench templates',
        items: templates.map((t) => {
          const local = t.local ? ' (local)' : '';
          return {
            name: t.name,
            label: `${templateContents(t)}${local}`,
            desc: `${t.description ?? templateContents(t)}${local}`,
          };
        }),
      });

      const isTty = process.stdout.isTTY ?? false;
      process.stdout.write(
        renderListing(sections, isTty, colorsFor(process.stdout)),
      );
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
