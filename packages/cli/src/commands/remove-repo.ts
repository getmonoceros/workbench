import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveRepo } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const removeRepoCommand = defineCommand({
  meta: {
    name: 'remove-repo',
    description:
      'Remove a repo from the solution config (matches by URL or by the projects/<name> folder name). Does NOT delete the existing projects/<name> folder — local edits are preserved; the builder cleans it up manually.',
  },
  args: {
    target: {
      type: 'positional',
      description: 'Repo URL or its projects/<name> folder name. Either works.',
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
      const result = await runRemoveRepo({
        target: args.target,
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
