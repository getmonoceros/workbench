import { defineCommand } from 'citty';
import { runStart } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const startCommand = defineCommand({
  meta: {
    name: 'start',
    description:
      'Bring the devcontainer up via `devcontainer up` (workspace + runServices, postCreate, features).',
  },
  args: {
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path, absolute or relative to cwd).',
    },
  },
  run({ args }) {
    return dispatch(() =>
      runStart({
        project: typeof args.project === 'string' ? args.project : undefined,
      }),
    );
  },
});
