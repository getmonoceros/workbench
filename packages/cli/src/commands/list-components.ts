import { defineCommand } from 'citty';
import { consola } from 'consola';
import { loadComponentCatalog } from '../init/components.js';

export const listComponentsCommand = defineCommand({
  meta: {
    name: 'list-components',
    group: 'discovery',
    description:
      'Print the components catalog used by `monoceros init --with=…`. Each line is `name<TAB>category<TAB>displayName`, grouped by category for readability.',
  },
  args: {},
  async run() {
    try {
      const catalog = await loadComponentCatalog();
      if (catalog.size === 0) {
        consola.warn(
          'No components found. The workbench checkout looks incomplete.',
        );
        process.exit(0);
      }
      const sorted = [...catalog.values()].sort((a, b) => {
        // Stable group order: language < service < feature; within
        // each, alphabetical by name.
        const order = { language: 0, service: 1, feature: 2 } as const;
        const ca = order[a.file.category];
        const cb = order[b.file.category];
        if (ca !== cb) return ca - cb;
        return a.name.localeCompare(b.name);
      });

      let currentCategory: string | null = null;
      for (const c of sorted) {
        if (c.file.category !== currentCategory) {
          if (currentCategory !== null) process.stdout.write('\n');
          process.stdout.write(`# ${c.file.category}\n`);
          currentCategory = c.file.category;
        }
        process.stdout.write(`${c.name}\t${c.file.displayName}\n`);
      }
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
