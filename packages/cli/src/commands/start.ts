import { defineCommand } from 'citty';
import { runStart } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const startCommand = defineCommand({
  meta: {
    name: 'start',
    description:
      'Start the compose services for the current solution (detached).',
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
      runStart({
        project: typeof args.project === 'string' ? args.project : undefined,
        service: typeof args.service === 'string' ? args.service : undefined,
      }),
    );
  },
});
