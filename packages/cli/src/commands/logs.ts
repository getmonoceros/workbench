import { defineCommand } from 'citty';
import { containerDir } from '../config/paths.js';
import { runLogs } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const logsCommand = defineCommand({
  meta: {
    name: 'logs',
    group: 'run',
    description:
      'Tail logs from the compose services of the named dev-container. Pass --no-follow for a one-shot dump.',
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
    follow: {
      type: 'boolean',
      description:
        'Follow log output (default: true). Use --no-follow to disable.',
      alias: ['f'],
      default: true,
    },
  },
  run({ args }) {
    return dispatch(() =>
      runLogs({
        root: containerDir(args.name),
        ...(typeof args.service === 'string' ? { service: args.service } : {}),
        follow: args.follow,
      }),
    );
  },
});
