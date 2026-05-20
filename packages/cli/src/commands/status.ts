import { defineCommand } from 'citty';
import { containerDir } from '../config/paths.js';
import { runStatus } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    group: 'run',
    description:
      'Show whether the compose services for the named dev-container are running.',
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
      runStatus({
        root: containerDir(args.name),
        ...(typeof args.service === 'string' ? { service: args.service } : {}),
      }),
    );
  },
});
