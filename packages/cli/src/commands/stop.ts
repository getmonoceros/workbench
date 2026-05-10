import { defineCommand } from 'citty';
import { runStop } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description:
      'Stop the compose services for the current solution. Volumes are preserved.',
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
  },
  run({ args }) {
    return dispatch(() =>
      runStop({
        project: typeof args.project === 'string' ? args.project : undefined,
        service: typeof args.service === 'string' ? args.service : undefined,
      }),
    );
  },
});
