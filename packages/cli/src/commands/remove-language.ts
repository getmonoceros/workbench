import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveLanguage } from '../modify/index.js';

export const removeLanguageCommand = defineCommand({
  meta: {
    name: 'remove-language',
    group: 'edit',
    description:
      'Remove a language toolchain from the container config. Idempotent, prints a diff before writing.',
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
      description: 'Language identifier (e.g. python, java, rust).',
      required: true,
    },
    yes: {
      type: 'boolean',
      description: 'Skip the interactive confirmation and apply the diff.',
      alias: ['y'],
      default: false,
    },
  },
  async run({ args }) {
    try {
      const result = await runRemoveLanguage({
        name: args.name,
        language: args.language,
        yes: args.yes,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
