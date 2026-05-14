import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runAddRepo } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const addRepoCommand = defineCommand({
  meta: {
    name: 'add-repo',
    description:
      'Register a git repo to be cloned into projects/<name>/ on container build. Idempotent — existing project subfolders are left alone. Name derived from URL by default; override with --name. SSH-auth ergonomics (agent forwarding) is not yet automated — use HTTPS URLs for public/PAT-authed access.',
  },
  args: {
    url: {
      type: 'positional',
      description:
        'Git URL (HTTPS or SSH/git@ form). E.g. https://github.com/foo/bar.git, git@github.com:foo/bar.git.',
      required: true,
    },
    name: {
      type: 'string',
      description:
        'Folder name under projects/. Default: derived from URL (e.g. bar.git → bar).',
    },
    branch: {
      type: 'string',
      description: 'Specific branch to clone (default: repo default branch).',
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
      const result = await runAddRepo({
        url: String(args.url),
        name: typeof args.name === 'string' ? args.name : undefined,
        branch: typeof args.branch === 'string' ? args.branch : undefined,
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
