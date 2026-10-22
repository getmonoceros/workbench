import { defineCommand } from 'citty';
import { consola } from 'consola';
import { containerConfigPath, containerDir } from '../config/paths.js';
import { runInContainer } from '../devcontainer/run.js';
import { getInnerArgs } from '../inner-args.js';
import { explainExit137 } from '../limits/index.js';

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
    in: {
      type: 'string',
      description:
        'Run the inner command in this directory inside the container (relative to the workspace folder, or absolute). Offers to create it when it does not exist yet.',
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description:
        'Answer the create-the-directory question with yes. For CI and scripts.',
      default: false,
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
        name: args.name,
        command,
        ...(args.in ? { cwd: args.in } : {}),
        ...(args.yes ? { yes: true } : {}),
      });
      // 137 is a SIGKILL. When the kernel sent it for memory, say so and
      // name the limit, instead of leaving a bare exit code (ADR 0062).
      if (exitCode === 137) {
        const why = await explainExit137(containerDir(args.name), {
          name: args.name,
          ymlPath: containerConfigPath(args.name),
        });
        if (why) consola.error(why);
      }
      process.exit(exitCode);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
