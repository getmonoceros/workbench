import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runInit } from '../init/index.js';

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description:
      'Create a fresh container-config yml at .local/container-configs/<name>.yml. Without --with, the file is a documented default with every component commented out. With --with=<names>, the named components are composed into an active, immediately-applyable yml. Then run `monoceros apply <name>`.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Config name. The yml lands at <MONOCEROS_HOME>/container-configs/<name>.yml and becomes the source-of-truth for `monoceros apply <name>`.',
      required: true,
    },
    with: {
      type: 'string',
      description:
        "Comma-separated list of component names to compose, e.g. 'node,postgres,github,claude'. Sub-components use a slash, e.g. 'atlassian/twg'. When omitted, init writes a documented default with every catalog component commented out.",
      required: false,
    },
  },
  async run({ args }) {
    try {
      const raw = typeof args.with === 'string' ? args.with.trim() : '';
      // A trailing comma is a strong signal that the shell split the
      // list on unquoted spaces (e.g. `--with=a, b, c` became three
      // separate argv entries; only the first survived). Catch it
      // here with a specific hint instead of silently producing a
      // half-empty yml.
      if (raw.endsWith(',')) {
        consola.error(
          [
            'The --with list looks truncated (ended with a comma).',
            'If you used spaces between component names, the shell split',
            'them as separate arguments and only the first one made it',
            'through. Either drop the spaces (--with=a,b,c) or quote',
            'the list (--with="a, b, c").',
          ].join('\n'),
        );
        process.exit(1);
      }
      const withList =
        raw.length > 0
          ? raw
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;
      await runInit({
        name: args.name,
        ...(withList ? { with: withList } : {}),
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
