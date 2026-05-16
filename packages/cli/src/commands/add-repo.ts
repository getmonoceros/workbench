import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runAddRepo } from '../modify/index.js';

export const addRepoCommand = defineCommand({
  meta: {
    name: 'add-repo',
    description:
      'Add a git repo to the container config. Cloned into projects/<folder>/ on container build. Idempotent — existing project subfolders are left alone. Folder name derived from URL by default; override with --as.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    url: {
      type: 'positional',
      description:
        'Git URL (HTTPS or SSH/git@ form). E.g. https://github.com/foo/bar.git, git@github.com:foo/bar.git.',
      required: true,
    },
    as: {
      type: 'string',
      description:
        'Folder name under projects/. Default: derived from URL (e.g. bar.git → bar).',
    },
    branch: {
      type: 'string',
      description: 'Specific branch to clone (default: repo default branch).',
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
      const result = await runAddRepo({
        name: args.name,
        url: args.url,
        ...(typeof args.as === 'string' ? { repoName: args.as } : {}),
        ...(typeof args.branch === 'string' ? { branch: args.branch } : {}),
        yes: args.yes,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
