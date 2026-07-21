import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveFromUrl } from '../modify/index.js';

export const removeFromUrlCommand = defineCommand({
  meta: {
    name: 'remove-from-url',
    group: 'edit',
    description:
      'Remove a previously-added install URL from the container config. Idempotent. The URL is dropped from post-create.sh on the next `monoceros apply`.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    url: {
      type: 'positional',
      description: 'Install URL to remove (must match the original exactly).',
      required: true,
    },
  },
  async run({ args }) {
    try {
      await runRemoveFromUrl({
        name: args.name,
        url: args.url,
      });
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
