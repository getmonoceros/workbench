import { defineCommand } from 'citty';
import { consola } from 'consola';
import { containerDir } from '../config/paths.js';
import { runInContainer } from '../devcontainer/run.js';
import { getInnerArgs } from '../inner-args.js';

export const runCommand = defineCommand({
  meta: {
    name: 'run',
    group: 'run',
    description:
      'Run a one-off command inside the named dev-container. Use `--` to separate monoceros flags from the inner command.',
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
    const command = [...getInnerArgs()];
    if (command.length === 0) {
      consola.error(
        'No command provided. Usage: `monoceros run <containername> -- <cmd> [args…]`.',
      );
      process.exit(1);
    }
    try {
      const exitCode = await runInContainer({
        root: containerDir(args.name),
        command,
      });
      process.exit(exitCode);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
