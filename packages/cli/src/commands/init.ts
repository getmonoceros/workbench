import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runInit } from '../init/index.js';

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description:
      'Copy a shipped yml template to .local/container-configs/<name>.yml, rewriting the `name` field. Edit the result, then `monoceros apply <name> <dir>`.',
  },
  args: {
    template: {
      type: 'positional',
      description:
        'Template name (file basename under templates/yml/, e.g. bare, nodejs-github, python).',
      required: true,
    },
    name: {
      type: 'positional',
      description:
        'Config name. The copy lands at .local/container-configs/<name>.yml and becomes the source-of-truth for any dev-container `monoceros apply <name>` materializes.',
      required: true,
    },
  },
  async run({ args }) {
    try {
      await runInit({
        template: args.template,
        name: args.name,
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
