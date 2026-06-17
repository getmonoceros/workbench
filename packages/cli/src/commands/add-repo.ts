import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runAddRepo } from '../modify/index.js';

export const addRepoCommand = defineCommand({
  meta: {
    name: 'add-repo',
    group: 'edit',
    description:
      'Add a git repo to the container config. Cloned into projects/<path>/ on container build. Idempotent — existing project subfolders are left alone. Destination path derived from URL by default; override with --path (supports nested subfolders like apps/web). Branches/PRs are git-level concerns: clone, then `git checkout` inside the container.',
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
    path: {
      type: 'string',
      description:
        'Destination under projects/. Subfolders via `/` (e.g. apps/web). Default: URL-derived single segment (bar.git → bar).',
    },
    'git-name': {
      type: 'string',
      description:
        'Per-repo git committer name. Overrides the container-level git.user.name for this repo only. Pair with --git-email.',
    },
    'git-email': {
      type: 'string',
      description:
        'Per-repo git committer email. Overrides the container-level git.user.email for this repo only. Pair with --git-name.',
    },
    provider: {
      type: 'string',
      description:
        'Git provider for credential-helper guidance: github | gitlab | bitbucket | gitea. Required when the URL host is not github.com, gitlab.com, or bitbucket.org — Monoceros uses this to suggest the right auth (gh / glab / a provider token) on missing credentials.',
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
        ...(typeof args.path === 'string' ? { path: args.path } : {}),
        ...(typeof args['git-name'] === 'string'
          ? { gitName: args['git-name'] }
          : {}),
        ...(typeof args['git-email'] === 'string'
          ? { gitEmail: args['git-email'] }
          : {}),
        ...(typeof args.provider === 'string'
          ? { provider: args.provider }
          : {}),
        yes: args.yes,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
