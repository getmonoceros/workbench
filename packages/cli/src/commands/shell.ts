import { defineCommand } from 'citty';
import { consola } from 'consola';
import { containerDir } from '../config/paths.js';
import { runShell } from '../devcontainer/shell.js';

export const shellCommand = defineCommand({
  meta: {
    name: 'shell',
    group: 'run',
    description:
      'Open an interactive bash session inside the named dev-container.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const exitCode = await runShell({ root: containerDir(args.name) });
      process.exit(exitCode);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
