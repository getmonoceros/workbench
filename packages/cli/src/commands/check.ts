import { defineCommand } from 'citty';
import { renderCheckReport, runCheck } from '../check/index.js';
import { colorsFor } from '../util/format.js';
import { dispatch } from './_dispatch.js';

export const checkCommand = defineCommand({
  meta: {
    name: 'check',
    group: 'discovery',
    description:
      'Check the materialized container against the rules the in-container briefing sets: every directory under projects/ registered in the workspace file, no project files at the workspace root, project compose files matching the catalog blocks from .monoceros/deploy.md, launch configs that are actually reachable (exposed port, no 127.0.0.1 binding), and every MCP server from the yml registered with each agent - reporting the tool names the server actually serves, so an agent claiming it has no such tool can be checked against fact. Host-side read plus one request per remote MCP server; nothing is changed. Exits 1 when it finds something.',
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
