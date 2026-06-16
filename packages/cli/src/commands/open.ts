import { defineCommand } from 'citty';
import { OPEN_TOOLS, runOpen } from '../open/index.js';
import { dispatch } from './_dispatch.js';

export const openCommand = defineCommand({
  meta: {
    name: 'open',
    group: 'run',
    description: `Attach an editor to the named dev-container over SSH, or drop into a shell. Tools: ${OPEN_TOOLS.join(', ')}. The container must be applied (runtime >= 1.2.0) and running.`,
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    tool: {
      type: 'positional',
      description: `What to open it in: ${OPEN_TOOLS.join(', ')}.`,
      required: true,
    },
  },
  run({ args }) {
    return dispatch(() => runOpen({ name: args.name, tool: args.tool }));
  },
});
