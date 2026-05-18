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
      const withList =
        typeof args.with === 'string' && args.with.trim().length > 0
          ? args.with
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
