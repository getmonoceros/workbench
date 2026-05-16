import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveRepo } from '../modify/index.js';

export const removeRepoCommand = defineCommand({
  meta: {
    name: 'remove-repo',
    description:
      'Remove a repo from the container config (matches by URL or by its projects/<folder> name). Does NOT delete the existing projects/<folder> directory — local edits are preserved; clean it up manually.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    target: {
      type: 'positional',
      description: 'Repo URL or its projects/<folder> name. Either works.',
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
      const result = await runRemoveRepo({
        name: args.name,
        target: args.target,
        yes: args.yes,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
