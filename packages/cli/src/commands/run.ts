import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runInContainer } from '../devcontainer/run.js';
import { getInnerArgs } from '../inner-args.js';

export const runCommand = defineCommand({
  meta: {
    name: 'run',
    description:
      'Run a one-off command inside the devcontainer. Use `--` to separate monoceros flags from the inner command.',
  },
  args: {
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path, absolute or relative to cwd). Defaults to walking upwards from cwd.',
    },
  },
  async run({ args }) {
    const command = [...getInnerArgs()];
    if (command.length === 0) {
      consola.error(
        'No command provided. Usage: `monoceros run [--project=<path>] -- <cmd> [args…]`.',
      );
      process.exit(1);
    }
    try {
      const exitCode = await runInContainer({
        project: typeof args.project === 'string' ? args.project : undefined,
        command,
      });
      process.exit(exitCode);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
