import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runAddLanguage } from '../modify/index.js';

export const addLanguageCommand = defineCommand({
  meta: {
    name: 'add-language',
    group: 'edit',
    description:
      'Add a language toolchain (devcontainer feature) to the container config. Idempotent, prints a diff before writing.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    language: {
      type: 'positional',
      description:
        'Language identifier from the feature whitelist (e.g. python, java, rust).',
      required: true,
    },
  },
  async run({ args }) {
    try {
      await runAddLanguage({
        name: args.name,
        language: args.language,
      });
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
