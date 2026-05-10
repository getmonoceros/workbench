import { defineCommand } from 'citty';
import { notImplemented } from './_stub.js';

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
  },
  run() {
    notImplemented('add-language');
  },
});
