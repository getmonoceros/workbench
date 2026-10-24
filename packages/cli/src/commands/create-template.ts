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
        'What the template is for. Written as the paragraph under the header comment, which `list-components --json` shows.',
    },
  },
  async run({ args }) {
    try {
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
      consola.info('In a team repository, commit it and open a pull request.');
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
