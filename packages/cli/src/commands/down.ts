import { defineCommand } from 'citty';
import { runDown } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const downCommand = defineCommand({
  meta: {
    name: 'down',
    description:
      "Remove the solution's containers and project network so a fresh `monoceros start` picks up image changes. Pass --volumes/-v to also drop volumes (postgres data, …).",
  },
  args: {
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path, absolute or relative to cwd).',
    },
    volumes: {
      type: 'boolean',
      description:
        'Also remove named volumes (postgres-data, redis-data, …). Default keeps service data.',
      alias: ['v'],
      default: false,
    },
  },
  run({ args }) {
    return dispatch(() =>
      runDown({
        project: typeof args.project === 'string' ? args.project : undefined,
        volumes: args.volumes,
      }),
    );
  },
});
