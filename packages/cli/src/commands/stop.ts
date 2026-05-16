import { defineCommand } from 'citty';
import { containerDir } from '../config/paths.js';
import { runStop } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description:
      'Stop the compose services for the named dev-container. Volumes are preserved.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    service: {
      type: 'string',
      description:
        'Restrict to a single compose service (e.g. postgres). Defaults to all.',
    },
  },
  run({ args }) {
    return dispatch(() =>
      runStop({
        root: containerDir(args.name),
        ...(typeof args.service === 'string' ? { service: args.service } : {}),
      }),
    );
  },
});
