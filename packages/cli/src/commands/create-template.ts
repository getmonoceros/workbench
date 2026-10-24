import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runCreateTemplate } from '../init/create-template.js';

export const createTemplateCommand = defineCommand({
  meta: {
    name: 'create-template',
    group: 'templates',
    description:
      'Turn a workbench into a template in ~/.monoceros/templates/workbenches/: copies its yml with the workbench name and the pinned runtime replaced by the template placeholders. Values from <name>.env stay behind. `monoceros init <new> --template=<template>` starts from it.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    template: {
      type: 'positional',
      description: 'Name of the new template, its file name without .yml.',
      required: true,
    },
    description: {
      type: 'string',
      description:
        'What the template is for, in quotes (--description "Node with Postgres."), or the shell passes only its first word. Written as the paragraph under the header comment, which `list-components --json` shows.',
    },
  },
  async run({ args }) {
    try {
      // Words beyond the two positionals are almost always a description
      // without quotes, which the shell split up. Say so rather than write
      // a template described by its first word.
      const extra = args._.slice(2);
      if (extra.length > 0) {
        throw new Error(
          `Unexpected arguments: ${extra.join(' ')}. Put the description in quotes: --description "…".`,
        );
      }
      const result = await runCreateTemplate({
        name: args.name,
        template: args.template,
        ...(args.description !== undefined
          ? { description: args.description }
          : {}),
      });
      consola.success(`Wrote template '${args.template}': ${result.file}`);
      if (result.description === undefined) {
        consola.info(
          `It has no description yet. Add one with --description, or as the paragraph under the header comment in ${result.file}.`,
        );
      }
      consola.info(
        `Start a workbench from it: monoceros init <name> --template=${args.template}`,
      );
      consola.info('In a team repository, commit it there.');
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
