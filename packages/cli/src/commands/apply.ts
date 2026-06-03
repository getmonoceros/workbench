import { defineCommand } from 'citty';
import { runApply } from '../apply/index.js';
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
  },
  run({ args }) {
    return dispatch(async () => {
      const result = await runApply({
        name: args.name,
        cliVersion: CLI_VERSION,
        verbose: args.verbose,
      });
      return result.containerExitCode;
    });
  },
});
