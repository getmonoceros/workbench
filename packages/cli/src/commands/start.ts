import { defineCommand } from 'citty';
import { containerDir } from '../config/paths.js';
import { runStart } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const startCommand = defineCommand({
  meta: {
    name: 'start',
    group: 'run',
    description:
      'Bring the named dev-container up via `devcontainer up` (workspace + runServices, postCreate, features).',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
  },
  run({ args }) {
    return dispatch(() => runStart({ root: containerDir(args.name) }));
  },
});
