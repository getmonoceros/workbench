import { defineCommand } from 'citty';
import {
  gatherStatus,
  renderApp,
  renderService,
  renderStatus,
} from '../status/index.js';
import { colorsFor } from '../util/format.js';
import { dispatch } from './_dispatch.js';

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    group: 'run',
    description:
      'Show the dev-container at a glance: container, services and apps (up/down), the ports it routes, and what the yml built in. With an <app> (or a service name), narrow to just that.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    app: {
      type: 'positional',
      description:
        'Narrow to one app (a path under projects/ with .monoceros/launch.json) or one compose service (e.g. postgres). Omit for the whole stack.',
      required: false,
    },
  },
  run({ args }) {
    const filter = typeof args.app === 'string' ? args.app : undefined;
    return dispatch(async () => {
      const model = await gatherStatus(args.name);
      // status output is a report → stdout, so colours drop out when piped.
      const p = colorsFor(process.stdout);
      let block: string;
      if (filter) {
        // Dispatch like `logs <name> [<app>]`: an app the launch config knows
        // → its targets; otherwise a compose service; otherwise an error.
        const isApp = model.apps.some((a) => a.app === filter);
        block = isApp
          ? renderApp(model, filter, p)
          : renderService(model, filter, p);
      } else {
        block = renderStatus(model, p);
      }
      process.stdout.write(`\n${block}\n`);
      return 0;
    });
  },
});
