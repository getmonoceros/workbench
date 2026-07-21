import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveRepo } from '../modify/index.js';

export const removeRepoCommand = defineCommand({
  meta: {
    name: 'remove-repo',
    group: 'edit',
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
  },
  async run({ args }) {
    try {
      await runRemoveRepo({
        name: args.name,
        target: args.target,
      });
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
