import { defineCommand } from 'citty';
import { renderCheckReport, runCheck } from '../check/index.js';
import { colorsFor } from '../util/format.js';
import { dispatch } from './_dispatch.js';

export const checkCommand = defineCommand({
  meta: {
    name: 'check',
    group: 'discovery',
    description:
      'Check the materialized container against the rules the in-container briefing sets: every directory under projects/ registered in the workspace file, no project files at the workspace root, project compose files matching the catalog blocks from .monoceros/deploy.md, and launch configs that are actually reachable (exposed port, no 127.0.0.1 binding). Pure host-side read - no container, no docker, nothing is changed. Exits 1 when it finds something.',
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
    return dispatch(async () => {
      const report = await runCheck(args.name);
      // A report goes to stdout, so colours drop out when piped.
      const block = renderCheckReport(report, colorsFor(process.stdout));
      process.stdout.write(`\n${block}\n`);
      return report.findings.length > 0 ? 1 : 0;
    });
  },
});
