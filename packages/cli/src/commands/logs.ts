import { defineCommand } from 'citty';
import { runLogs } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const logsCommand = defineCommand({
  meta: {
    name: 'logs',
    description:
      'Tail logs from the compose services. Pass --no-follow for a one-shot dump.',
  },
  args: {
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path, absolute or relative to cwd).',
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
        project: typeof args.project === 'string' ? args.project : undefined,
        service: typeof args.service === 'string' ? args.service : undefined,
        follow: args.follow,
      }),
    );
  },
});
