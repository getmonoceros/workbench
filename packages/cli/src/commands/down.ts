import { defineCommand } from 'citty';
import { containerDir } from '../config/paths.js';
import { runDown } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const downCommand = defineCommand({
  meta: {
    name: 'down',
    description:
      "Remove the named dev-container's containers and project network so a fresh `monoceros start` picks up image changes. Pass --volumes/-v to also drop volumes (postgres data, …).",
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
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
        root: containerDir(args.name),
        volumes: args.volumes,
      }),
    );
  },
});
