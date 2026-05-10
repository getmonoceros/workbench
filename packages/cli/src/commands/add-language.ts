import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runAddLanguage } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const addLanguageCommand = defineCommand({
  meta: {
    name: 'add-language',
    description:
      'Add a language toolchain (devcontainer feature) to an existing solution. Idempotent, prints a diff before writing.',
  },
  args: {
    language: {
      type: 'positional',
      description:
        'Language identifier from the feature whitelist (e.g. python, java, rust).',
      required: true,
    },
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path, absolute or relative to cwd).',
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
      const result = await runAddLanguage({
        language: args.language,
        project: typeof args.project === 'string' ? args.project : undefined,
        yes: args.yes,
        cliVersion: CLI_VERSION,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
