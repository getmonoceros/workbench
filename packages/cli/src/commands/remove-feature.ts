import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveFeature } from '../modify/index.js';

export const removeFeatureCommand = defineCommand({
  meta: {
    name: 'remove-feature',
    group: 'edit',
    description:
      'Remove a devcontainer feature from the container config (by its OCI ref). Idempotent, prints a diff before writing.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    ref: {
      type: 'positional',
      description:
        'Feature ref (e.g. ghcr.io/devcontainers/features/docker-in-docker:2).',
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
      const result = await runRemoveFeature({
        name: args.name,
        ref: args.ref,
        yes: args.yes,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
