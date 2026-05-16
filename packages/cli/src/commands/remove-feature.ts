import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveFeature } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const removeFeatureCommand = defineCommand({
  meta: {
    name: 'remove-feature',
    description:
      'Remove a devcontainer feature from the solution config (by its OCI ref). Idempotent, prints a diff before writing.',
  },
  args: {
    ref: {
      type: 'positional',
      description:
        'Feature ref (e.g. ghcr.io/devcontainers/features/docker-in-docker:2).',
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
      const result = await runRemoveFeature({
        ref: args.ref,
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
