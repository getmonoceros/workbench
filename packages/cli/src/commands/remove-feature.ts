import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveFeature } from '../modify/index.js';

export const removeFeatureCommand = defineCommand({
  meta: {
    name: 'remove-feature',
    group: 'edit',
    description:
      'Remove a devcontainer feature from the container config. Accepts either a Monoceros catalog short-name (e.g. `atlassian`, `claude`) or a full OCI ref. Idempotent, prints a diff before writing.',
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
        'Feature to remove. Either a Monoceros catalog short-name (e.g. `atlassian`, `atlassian/twg`, `claude` — see `monoceros list-components`) or a full OCI feature ref (e.g. `ghcr.io/devcontainers/features/docker-in-docker:2`).',
      required: true,
    },
  },
  async run({ args }) {
    try {
      await runRemoveFeature({
        name: args.name,
        ref: args.ref,
      });
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
