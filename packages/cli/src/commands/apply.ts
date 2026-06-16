import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runApply } from '../apply/index.js';
import { OPEN_TOOLS, runOpen } from '../open/index.js';
import { CLI_VERSION } from '../version.js';
import { dispatch } from './_dispatch.js';

/**
 * `monoceros apply <name>` — materialize the yml at
 * `<MONOCEROS_HOME>/container-configs/<name>.yml` into
 * `<MONOCEROS_HOME>/container/<name>/` and bring the container up.
 *
 * The target location is fixed by convention. cwd is irrelevant. No
 * `--path` override — one config maps to exactly one container
 * directory, and that's the whole mental model.
 */
export const applyCommand = defineCommand({
  meta: {
    name: 'apply',
    group: 'lifecycle',
    description:
      'Materialize a container config into $MONOCEROS_HOME/container/<name>/ and bring the dev-container up. Close any VS Code Remote Containers session for the target first — the extension auto-recreates and races with apply.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Config name. Resolves to $MONOCEROS_HOME/container-configs/<name>.yml.',
      required: true,
    },
    verbose: {
      type: 'boolean',
      description:
        'Stream the raw @devcontainers/cli output to stderr instead of showing a phase spinner. Auto-enabled when stderr is not a TTY.',
      default: false,
    },
    open: {
      type: 'string',
      description: `After a successful apply, open the container in this tool (${OPEN_TOOLS.join('|')}).`,
    },
  },
  run({ args }) {
    return dispatch(async () => {
      const result = await runApply({
        name: args.name,
        cliVersion: CLI_VERSION,
        verbose: args.verbose,
      });
      // `--open` is a convenience on top of a successful apply. A failure
      // here (editor not found, etc.) must not mask the apply result, so
      // it surfaces as a warning and the apply's exit code stands.
      if (args.open && result.containerExitCode === 0) {
        try {
          await runOpen({ name: args.name, tool: args.open });
        } catch (err) {
          consola.warn(err instanceof Error ? err.message : String(err));
        }
      }
      return result.containerExitCode;
    });
  },
});
